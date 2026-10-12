import { Array as Arr, Context, DateTime, Effect, Layer, Option, Order, Schema } from "effect"
import { AutomationError } from "./apple-error.ts"
import { CalendarHelper } from "./calendar-helper.ts"
import type { Completed } from "./process.ts"

export const CalendarEvent = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  calendar: Schema.String,
  start: Schema.String,
  end: Schema.String,
  allDay: Schema.Boolean,
  location: Schema.optional(Schema.String)
})
export type CalendarEvent = typeof CalendarEvent.Type

const MAX_SPAN_DAYS = 31
const MAX_SPAN_MILLIS = MAX_SPAN_DAYS * 24 * 60 * 60 * 1000

const CalendarName = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200))
const EventsInput = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  calendar: Schema.optional(CalendarName)
})

// What `native/calendar-events.swift` prints. Instants are epoch milliseconds;
// recurring series arrive already expanded into occurrences by EventKit.
const Millis = Schema.Number.check(Schema.isInt())
const HelperEvent = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  calendar: Schema.String,
  start: Millis,
  end: Millis,
  allDay: Schema.Boolean,
  location: Schema.optional(Schema.String)
})
const EventsOutput = Schema.fromJsonString(Schema.Struct({ events: Schema.Array(HelperEvent) }))
const CalendarsOutput = Schema.fromJsonString(Schema.Struct({ calendars: Schema.Array(Schema.String) }))

const decodeInput = Schema.decodeUnknownEffect(EventsInput)
const decodeEvents = Schema.decodeUnknownEffect(EventsOutput)
const decodeCalendars = Schema.decodeUnknownEffect(CalendarsOutput)

const invalid = (what: string) => (error: { readonly message: string }) =>
  new AutomationError({ message: `${what}: ${error.message}` })

// Exit codes of the helper; see the header of `native/calendar-events.swift`.
const EXIT_DENIED = 3
const EXIT_NOT_FOUND = 4
const EXIT_NO_ANSWER = 5

const PERMISSION_HINT =
  "Allow Full Access for \"calendar-events\" (the Jarvis helper) in System Settings > Privacy & Security > Calendars, then try again."

const describeFailure = ({ exitCode, stderr }: Completed, calendar: string | undefined): string => {
  switch (Number(exitCode)) {
    case EXIT_DENIED:
      return /write-only/.test(stderr)
        ? `macOS granted only "Add Events Only" Calendar access. ${PERMISSION_HINT}`
        : `macOS denied Calendar access. ${PERMISSION_HINT}`
    case EXIT_NOT_FOUND:
      return `Calendar not found: ${calendar ?? ""}`
    case EXIT_NO_ANSWER:
      return `The Calendar access request was not answered. ${PERMISSION_HINT}`
    default: {
      const detail = stderr.trim().slice(0, 500)
      return detail.length > 0 ? `Calendar helper failed: ${detail}` : "The Calendar helper failed."
    }
  }
}

interface Placed {
  readonly event: typeof HelperEvent.Type
  readonly start: number
  readonly end: number
}

const byStartThenTitle = Order.combine(
  Order.mapInput(Order.Number, (item: Placed) => item.start),
  Order.mapInput(Order.String, (item: Placed) => item.event.title)
)

const parseInstant = (label: string, value: string) =>
  Option.match(DateTime.make(value), {
    onNone: () => Effect.fail(new AutomationError({ message: `${label} is not a valid ISO 8601 date: ${value}` })),
    onSome: (dateTime) => Effect.succeed(DateTime.toUtc(dateTime))
  })

export class Calendar extends Context.Service<Calendar, {
  readonly calendars: Effect.Effect<ReadonlyArray<string>, AutomationError>
  readonly events: (input: {
    readonly from: string
    readonly to: string
    readonly calendar?: string
  }) => Effect.Effect<ReadonlyArray<CalendarEvent>, AutomationError>
  readonly today: Effect.Effect<ReadonlyArray<CalendarEvent>, AutomationError>
}>()("@jarvis/apple/Calendar") {
  /** Reads Calendar through whichever `CalendarHelper` is provided. */
  static readonly layerWithoutHelper = Layer.effect(
    Calendar,
    Effect.gen(function*() {
      const helper = yield* CalendarHelper

      // Caller values only travel as separate argv entries of an absolute
      // executable; there is no shell and no script source to inject into.
      const run = (args: ReadonlyArray<string>, calendar: string | undefined) =>
        helper.run(args).pipe(
          Effect.filterOrElse(
            (completed) => Number(completed.exitCode) === 0,
            (completed) => Effect.fail(new AutomationError({ message: describeFailure(completed, calendar) }))
          ),
          Effect.map(({ stdout }) => stdout)
        )

      const calendars = run(["--list-calendars"], undefined).pipe(
        Effect.flatMap((stdout) => decodeCalendars(stdout).pipe(Effect.mapError(invalid("Unexpected Calendar output")))),
        Effect.map(({ calendars }) => calendars),
        Effect.withSpan("Calendar.calendars")
      )

      const query = Effect.fn("Calendar.query")(function*(
        from: DateTime.Utc,
        to: DateTime.Utc,
        calendar: string | undefined
      ) {
        const fromMillis = DateTime.toEpochMillis(from)
        const toMillis = DateTime.toEpochMillis(to)
        const span = toMillis - fromMillis
        if (span <= 0) {
          return yield* new AutomationError({ message: "`to` must be after `from`." })
        }
        if (span > MAX_SPAN_MILLIS) {
          return yield* new AutomationError({ message: `The range must not exceed ${MAX_SPAN_DAYS} days.` })
        }
        const stdout = yield* run([
          "--from",
          DateTime.formatIso(from),
          "--to",
          DateTime.formatIso(to),
          ...(calendar === undefined ? [] : ["--calendar", calendar])
        ], calendar)
        const { events } = yield* decodeEvents(stdout).pipe(Effect.mapError(invalid("Unexpected Calendar output")))
        const zone = DateTime.zoneMakeLocal()
        const iso = (millis: number) => DateTime.formatIsoOffset(DateTime.makeZonedUnsafe(millis, { timeZone: zone }))
        const placed = events
          .map((event): Placed => ({ event, start: event.start, end: event.end }))
          .filter((item) => item.start < toMillis && item.end > fromMillis)
        return Arr.sort(placed, byStartThenTitle).map(({ end, event, start }): CalendarEvent => ({
          id: event.id,
          title: event.title,
          calendar: event.calendar,
          start: iso(start),
          end: iso(end),
          allDay: event.allDay,
          ...(event.location !== undefined && event.location.length > 0 ? { location: event.location } : {})
        }))
      })

      const events = Effect.fn("Calendar.events")(function*(input: {
        readonly from: string
        readonly to: string
        readonly calendar?: string
      }) {
        const { from, to, calendar } = yield* decodeInput(input).pipe(Effect.mapError(invalid("Invalid input")))
        return yield* query(yield* parseInstant("from", from), yield* parseInstant("to", to), calendar)
      })

      const today = Effect.gen(function*() {
        const now = DateTime.setZone(yield* DateTime.now, DateTime.zoneMakeLocal())
        const start = DateTime.startOf(now, "day")
        const end = DateTime.add(start, { days: 1 })
        return yield* query(DateTime.toUtc(start), DateTime.toUtc(end), undefined)
      }).pipe(Effect.withSpan("Calendar.today"))

      return Calendar.of({ calendars, events, today })
    })
  )

  /** Reads Calendar through EventKit, building the helper on first use. */
  static readonly layer = Calendar.layerWithoutHelper.pipe(Layer.provide(CalendarHelper.layer))
}
