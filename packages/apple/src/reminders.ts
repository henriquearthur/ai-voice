import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { AutomationError } from "./apple-error.ts"
import { Osascript, parseRecords } from "./osascript.ts"

/**
 * `due` is `YYYY-MM-DD` for an all-day reminder (a calendar day, not an instant)
 * and `YYYY-MM-DDTHH:mm:ss.sss±hh:mm` in the machine's time zone for a timed one.
 */
export const Reminder = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  list: Schema.String,
  completed: Schema.Boolean,
  due: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.String)
})
export type Reminder = typeof Reminder.Type

// C0 controls (bar tab/newline/CR) and DEL: NUL cannot travel in argv and
// ASCII 30/31 are the record/field separators of the script output.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const noControl = Schema.makeFilter<string>((value) =>
  CONTROL.test(value) ? "Must not contain control characters" : undefined
)

const Title = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(500), noControl)
const ListName = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200), noControl)
const Notes = Schema.String.check(Schema.isMaxLength(10_000), noControl)

// Date-only or date-time, optionally with a `Z` / `±hh:mm` offset.
const ISO_8601 = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/

interface ParsedDue {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly time?: { readonly hour: number; readonly minute: number; readonly second: number }
  /** Offset in minutes east of UTC; absent means local wall-clock time. */
  readonly offset?: number
}

// Pure and zone-independent: every field is range-checked through UTC
// arithmetic, so `2026-02-31`, `24:00` or `+25:00` are rejected instead of
// silently rolling over (Bun's `new Date("2026-02-31T10:00Z")` is March 3).
const parseDue = (iso: string): ParsedDue | undefined => {
  const match = ISO_8601.exec(iso)
  if (match === null) return undefined
  const [, y, mo, d, h, mi, s, zone] = match
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  const hour = Number(h ?? 0)
  const minute = Number(mi ?? 0)
  const second = Number(s ?? 0)
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  if (
    check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
    check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second
  ) return undefined
  let offset: number | undefined
  if (zone !== undefined && zone !== "Z") {
    const offsetHours = Number(zone.slice(1, 3))
    const offsetMinutes = Number(zone.slice(4, 6))
    if (offsetHours > 14 || offsetMinutes > 59) return undefined
    offset = (zone[0] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMinutes)
  } else if (zone === "Z") {
    offset = 0
  }
  return {
    year,
    month,
    day,
    ...(h === undefined ? {} : { time: { hour, minute, second } }),
    ...(offset === undefined ? {} : { offset })
  }
}

const IsoDate = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    parseDue(value) === undefined
      ? "Expected a valid ISO 8601 date such as 2026-10-11, 2026-10-11T09:30 or 2026-10-11T09:30-03:00"
      : undefined
  )
)

const ListInput = Schema.Struct({
  list: Schema.optional(ListName),
  includeCompleted: Schema.optional(Schema.Boolean)
})

const AddInput = Schema.Struct({
  title: Title,
  list: Schema.optional(ListName),
  due: Schema.optional(IsoDate),
  notes: Schema.optional(Notes)
})

const Row = Schema.Tuple([
  Schema.String,
  Schema.String,
  Schema.String,
  Schema.Literals(["true", "false"]),
  Schema.String,
  Schema.String
])

const decodeListInput = Schema.decodeUnknownEffect(ListInput)
const decodeAddInput = Schema.decodeUnknownEffect(AddInput)
const decodeRow = Schema.decodeUnknownEffect(Row)
const decodeReminder = Schema.decodeUnknownEffect(Reminder)

const invalid = (what: string) => (error: { readonly message: string }) =>
  new AutomationError({ message: `${what}: ${error.message}` })

// Shared handlers. Every free-text field goes through `clean`, which replaces
// ASCII 30/31 with spaces so a title or note typed elsewhere cannot break the
// record framing. The due date travels as "date,y,m,d" or
// "datetime,y,m,d,h,mi" so TypeScript owns the ISO formatting.
const HANDLERS = `
on clean(t)
  if t is missing value then return ""
  set t to t as text
  set saved to AppleScript's text item delimiters
  set AppleScript's text item delimiters to {character id 30, character id 31}
  set pieces to text items of t
  set AppleScript's text item delimiters to " "
  set t to pieces as text
  set AppleScript's text item delimiters to saved
  return t
end clean

on ymd(d)
  return ((year of d) as text) & "," & (((month of d) as integer) as text) & "," & ((day of d) as text)
end ymd

-- An all-day reminder reports its day in "allday due date" (and midnight in
-- "due date"); a timed one leaves "allday due date" missing. A non-midnight
-- "due date" always wins, so a timed reminder is never collapsed to a day.
on formatDue(d, ad)
  if ad is not missing value then
    if d is missing value then return "date," & my ymd(ad)
    if (time of d) is 0 then return "date," & my ymd(ad)
  end if
  if d is missing value then return ""
  return "datetime," & my ymd(d) & "," & ((hours of d) as text) & "," & ((minutes of d) as text)
end formatDue

on formatRecord(theId, theName, listName, isDone, d, ad, theBody)
  set fs to character id 31
  return (theId as text) & fs & my clean(theName) & fs & my clean(listName) & fs & (isDone as text) & fs & my formatDue(d, ad) & fs & my clean(theBody) & (character id 30)
end formatRecord

on joinRecords(parts)
  set saved to AppleScript's text item delimiters
  set AppleScript's text item delimiters to ""
  -- leading separator: osascript output is trimmed, which would eat leading spaces of the first field
  set joined to (character id 30) & (parts as text)
  set AppleScript's text item delimiters to saved
  return joined
end joinRecords
`

const LISTS_SCRIPT = `
on run argv
  tell application "Reminders" to set names to name of every list
  set out to {}
  repeat with n in names
    set end of out to my clean(contents of n) & (character id 30)
  end repeat
  return my joinRecords(out)
end run
${HANDLERS}`

// argv: list name ("" = all lists), "1" to include completed reminders.
// Properties are fetched in bulk (one Apple event per property per list, the
// filter evaluated by Reminders itself) instead of ~6 events per reminder.
const LIST_SCRIPT = `
on run argv
  set listName to item 1 of argv
  set includeCompleted to (item 2 of argv is "1")
  set out to {}
  tell application "Reminders"
    if listName is "" then
      set targets to every list
    else
      set targets to {list listName}
    end if
    repeat with k from 1 to count of targets
      set l to item k of targets
      set currentName to name of l
      if includeCompleted then
        set q to a reference to (every reminder of l)
      else
        set q to a reference to (every reminder of l whose completed is false)
      end if
      set ids to id of q
      set names to name of q
      set dones to completed of q
      set dues to due date of q
      set alldays to allday due date of q
      set bodies to body of q
      repeat with i from 1 to count of ids
        set end of out to my formatRecord(item i of ids, item i of names, currentName, item i of dones, item i of dues, item i of alldays, item i of bodies)
      end repeat
    end repeat
  end tell
  return my joinRecords(out)
end run
${HANDLERS}`

// argv: title, list name ("" = default list), notes, due mode ("none" | "date" | "datetime"),
// year, month, day, hours, minutes (local wall clock).
// The date is built outside the tell block; the day is pinned to 1 before the
// month is set so 31 -> shorter month cannot overflow. The due date goes into
// `make` itself so a failure never leaves a half-configured reminder behind.
const ADD_SCRIPT = `
on run argv
  set theTitle to item 1 of argv
  set listName to item 2 of argv
  set theNotes to item 3 of argv
  set dueMode to item 4 of argv
  set d to missing value
  if dueMode is not "none" then
    set d to current date
    set day of d to 1
    set year of d to (item 5 of argv as integer)
    set month of d to (item 6 of argv as integer)
    set day of d to (item 7 of argv as integer)
    set time of d to ((item 8 of argv as integer) * hours + (item 9 of argv as integer) * minutes)
  end if
  tell application "Reminders"
    if listName is "" then
      set targetList to default list
    else
      set targetList to list listName
    end if
    if dueMode is "date" then
      set r to make new reminder at end of reminders of targetList with properties {name:theTitle, body:theNotes, allday due date:d}
    else if dueMode is "datetime" then
      set r to make new reminder at end of reminders of targetList with properties {name:theTitle, body:theNotes, due date:d}
    else
      set r to make new reminder at end of reminders of targetList with properties {name:theTitle, body:theNotes}
    end if
    set createdRecord to my formatRecord(id of r, name of r, name of targetList, completed of r, due date of r, allday due date of r, body of r)
  end tell
  return createdRecord
end run
${HANDLERS}`

interface DueArgs {
  readonly mode: "none" | "date" | "datetime"
  readonly values: ReadonlyArray<string>
}

const NO_DUE: DueArgs = { mode: "none", values: ["0", "0", "0", "0", "0"] }

// The zone Reminders works in: `DateTime.CurrentTimeZone` when provided (tests),
// otherwise the machine's zone.
const currentZone = Effect.map(
  Effect.serviceOption(DateTime.CurrentTimeZone),
  Option.getOrElse(() => DateTime.zoneMakeLocal())
)

const toDueArgs = (iso: string | undefined, zone: DateTime.TimeZone): Effect.Effect<DueArgs, AutomationError> => {
  if (iso === undefined) return Effect.succeed(NO_DUE)
  const parsed = parseDue(iso)
  if (parsed === undefined) return Effect.fail(new AutomationError({ message: `Invalid due date: ${iso}` }))
  const { day, month, time, year } = parsed
  if (time === undefined) {
    return Effect.succeed({ mode: "date", values: [year, month, day, 0, 0].map(String) })
  }
  if (parsed.offset === undefined) {
    // Floating local time: Reminders stores wall-clock time, pass it through untouched.
    return Effect.succeed({ mode: "datetime", values: [year, month, day, time.hour, time.minute].map(String) })
  }
  const instant = DateTime.makeUnsafe(
    Date.UTC(year, month - 1, day, time.hour, time.minute, time.second) - parsed.offset * 60_000
  )
  const local = DateTime.toParts(DateTime.setZone(instant, zone))
  return Effect.succeed({
    mode: "datetime",
    values: [local.year, local.month, local.day, local.hour, local.minute].map(String)
  })
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0")

const fromDueField = (field: string, zone: DateTime.TimeZone): Effect.Effect<string | undefined, AutomationError> => {
  if (field === "") return Effect.succeed(undefined)
  const [mode, ...rest] = field.split(",")
  const numbers = rest.map(Number)
  const bad = Effect.fail(new AutomationError({ message: `Unexpected Reminders due date: ${field}` }))
  if (numbers.some((n) => !Number.isInteger(n))) return bad
  if (mode === "date" && numbers.length === 3) {
    const [year, month, day] = numbers as [number, number, number]
    return Effect.succeed(`${pad(year, 4)}-${pad(month)}-${pad(day)}`)
  }
  if (mode === "datetime" && numbers.length === 5) {
    const [year, month, day, hour, minute] = numbers as [number, number, number, number, number]
    return Option.match(
      DateTime.makeZoned({ year, month, day, hour, minute, second: 0, millisecond: 0 }, {
        timeZone: zone,
        adjustForTimeZone: true
      }),
      { onNone: () => bad, onSome: (zoned) => Effect.succeed(DateTime.formatIsoOffset(zoned)) }
    )
  }
  return bad
}

const toReminder = (record: ReadonlyArray<string>, zone: DateTime.TimeZone) =>
  decodeRow(record).pipe(
    Effect.mapError(invalid("Unexpected Reminders output")),
    Effect.flatMap(([id, title, list, completed, dueField, notes]) =>
      fromDueField(dueField, zone).pipe(
        Effect.flatMap((due) =>
          decodeReminder({
            id,
            title,
            list,
            completed: completed === "true",
            due,
            notes: notes === "" ? undefined : notes
          }).pipe(Effect.mapError(invalid("Unexpected Reminders output")))
        )
      )
    )
  )

export class Reminders extends Context.Service<Reminders, {
  readonly lists: Effect.Effect<ReadonlyArray<string>, AutomationError>
  readonly list: (
    input?: { readonly list?: string; readonly includeCompleted?: boolean }
  ) => Effect.Effect<ReadonlyArray<Reminder>, AutomationError>
  readonly add: (
    input: { readonly title: string; readonly list?: string; readonly due?: string; readonly notes?: string }
  ) => Effect.Effect<Reminder, AutomationError>
}>()("@jarvis/apple/Reminders") {
  static readonly layer: Layer.Layer<Reminders, never, Osascript> = Layer.effect(
    Reminders,
    Effect.gen(function*() {
      const osascript = yield* Osascript

      // Zero-arg operation: a plain Effect value with a span, as in the official
      // service examples (`TodoRepo.getAll`, `Groups.list`); Effect.fn is for functions.
      const lists = osascript.run(LISTS_SCRIPT).pipe(
        Effect.map((output) => parseRecords(output).map((fields) => fields[0] ?? "").filter((name) => name !== "")),
        Effect.withSpan("Reminders.lists")
      )

      const list = Effect.fn("Reminders.list")(function*(input: {
        readonly list?: string
        readonly includeCompleted?: boolean
      } = {}) {
        const options = yield* decodeListInput(input).pipe(Effect.mapError(invalid("Invalid list input")))
        const zone = yield* currentZone
        const output = yield* osascript.run(LIST_SCRIPT, [options.list ?? "", options.includeCompleted === true ? "1" : "0"])
        return yield* Effect.forEach(parseRecords(output), (record) => toReminder(record, zone))
      })

      const add = Effect.fn("Reminders.add")(function*(input: {
        readonly title: string
        readonly list?: string
        readonly due?: string
        readonly notes?: string
      }) {
        const options = yield* decodeAddInput(input).pipe(Effect.mapError(invalid("Invalid reminder")))
        const zone = yield* currentZone
        const due = yield* toDueArgs(options.due, zone)
        const output = yield* osascript.run(ADD_SCRIPT, [
          options.title,
          options.list ?? "",
          options.notes ?? "",
          due.mode,
          ...due.values
        ])
        const [record] = parseRecords(output)
        if (record === undefined) {
          return yield* new AutomationError({ message: "Reminders did not return the created reminder" })
        }
        return yield* toReminder(record, zone)
      })

      return Reminders.of({ lists, list, add })
    })
  )
}
