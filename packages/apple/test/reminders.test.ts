import { assert, describe, it } from "@effect/vitest"
import { DateTime, Effect, Layer, Ref } from "effect"
import { AutomationError } from "../src/apple-error.ts"
import { FIELD_SEPARATOR as FS, Osascript, RECORD_SEPARATOR as RS } from "../src/osascript.ts"
import { Reminders } from "../src/reminders.ts"

interface Call {
  readonly script: string
  readonly args: ReadonlyArray<string>
}

const record = (...fields: ReadonlyArray<string>) => fields.join(FS) + RS

const makeLayer = (calls: Ref.Ref<Array<Call>>, reply: string) =>
  Reminders.layer.pipe(
    Layer.provide(Layer.succeed(
      Osascript,
      Osascript.of({
        run: (script, args = []) => Ref.update(calls, (all) => [...all, { script, args }]).pipe(Effect.as(reply)),
        open: () => Effect.void
      })
    ))
  )

// Every test pins the zone so results never depend on the machine running them.
const withReply = <A, E>(
  reply: string,
  use: (calls: Ref.Ref<Array<Call>>) => Effect.Effect<A, E, Reminders>,
  zone = "America/Sao_Paulo"
) =>
  Effect.gen(function*() {
    const calls = yield* Ref.make<Array<Call>>([])
    return yield* use(calls).pipe(Effect.provide(makeLayer(calls, reply)))
  }).pipe(DateTime.withCurrentZone(DateTime.zoneMakeNamedUnsafe(zone)))

const hostile = "\" & do shell script \"rm -rf ~\" & \""

const addArgs = (input: Parameters<Reminders["Service"]["add"]>[0], zone?: string) =>
  withReply(record("id", "t", "Inbox", "false", "", ""), (calls) =>
    Effect.gen(function*() {
      const reminders = yield* Reminders
      yield* reminders.add(input)
      const [call] = yield* Ref.get(calls)
      return call?.args.slice(3) ?? []
    }), zone)

describe("Reminders", () => {
  it.effect("lists reminder lists", () =>
    withReply(`${RS}Inbox${RS} Work${RS}`, () =>
      Effect.gen(function*() {
        const reminders = yield* Reminders
        assert.deepStrictEqual(yield* reminders.lists, ["Inbox", " Work"])
      })))

  it.effect("parses reminders and omits empty optional fields", () =>
    withReply(
      RS + record("x-id-1", "Buy milk", "Inbox", "false", "", "") +
        record("x-id-2", "Call", "Work", "true", "datetime,2026,10,11,9,30", "bring notes\nline 2"),
      () =>
        Effect.gen(function*() {
          const reminders = yield* Reminders
          const result = yield* reminders.list({ includeCompleted: true })
          assert.deepStrictEqual(result[0], {
            id: "x-id-1",
            title: "Buy milk",
            list: "Inbox",
            completed: false,
            due: undefined,
            notes: undefined
          })
          assert.strictEqual(result[1]?.completed, true)
          assert.strictEqual(result[1]?.notes, "bring notes\nline 2")
          assert.strictEqual(result[1]?.due, "2026-10-11T09:30:00.000-03:00")
        })
    ))

  it.effect("returns an all-day due as a calendar day, not a UTC instant", () =>
    withReply(record("id-1", "Pay rent", "Inbox", "false", "date,2026,11,1", ""), () =>
      Effect.gen(function*() {
        const reminders = yield* Reminders
        const [result] = yield* reminders.list()
        // toISOString() of local midnight would be "2026-10-31T15:00:00.000Z" in Tokyo.
        assert.strictEqual(result?.due, "2026-11-01")
      }), "Asia/Tokyo"))

  it.effect("reports timed dues with the offset in force on that day (DST)", () =>
    withReply(
      record("a", "winter", "L", "false", "datetime,2026,1,15,9,0", "") +
        record("b", "summer", "L", "false", "datetime,2026,7,15,9,0", ""),
      () =>
        Effect.gen(function*() {
          const reminders = yield* Reminders
          const [winter, summer] = yield* reminders.list()
          assert.strictEqual(winter?.due, "2026-01-15T09:00:00.000-05:00")
          assert.strictEqual(summer?.due, "2026-07-15T09:00:00.000-04:00")
        }),
      "America/New_York"
    ))

  it.effect.each([
    { name: "unknown mode", due: "soon,2026,1,1" },
    { name: "missing parts", due: "datetime,2026,1,1" },
    { name: "non-numeric", due: "date,2026,x,1" }
  ])("fails on a malformed due field ($name)", ({ due }) =>
    withReply(record("a", "t", "L", "false", due, ""), () =>
      Effect.gen(function*() {
        const reminders = yield* Reminders
        const error = yield* reminders.list().pipe(Effect.flip)
        assert.instanceOf(error, AutomationError)
      })))

  it.effect("passes list filters through argv and keeps the script constant", () =>
    withReply("", (calls) =>
      Effect.gen(function*() {
        const reminders = yield* Reminders
        yield* reminders.list()
        yield* reminders.list({ list: hostile, includeCompleted: true })
        const [first, second] = yield* Ref.get(calls)
        assert.deepStrictEqual(first?.args, ["", "0"])
        assert.deepStrictEqual(second?.args, [hostile, "1"])
        assert.strictEqual(first?.script, second?.script)
        assert.isTrue(second?.script.trimStart().startsWith("on run argv"))
        assert.isFalse(second?.script.includes("rm -rf") ?? true)
      })))

  it.effect("scripts sanitise separators in text coming back from Reminders", () =>
    withReply("", (calls) =>
      Effect.gen(function*() {
        const reminders = yield* Reminders
        yield* reminders.lists
        yield* reminders.list()
        yield* reminders.add({ title: "x" }).pipe(Effect.ignore)
        const all = yield* Ref.get(calls)
        assert.strictEqual(all.length, 3)
        for (const { script } of all) {
          assert.include(script, "on clean(t)")
          assert.include(script, "my clean(")
        }
      })))

  it.effect("adds a reminder with hostile values only in argv", () =>
    withReply(record("id-9", hostile, "Inbox", "false", "datetime,2026,1,31,18,0", hostile), (calls) =>
      Effect.gen(function*() {
        const reminders = yield* Reminders
        const created = yield* reminders.add({
          title: `  ${hostile}  `,
          list: hostile,
          due: "2026-01-31T18:00",
          notes: hostile
        })
        const [call] = yield* Ref.get(calls)
        assert.deepStrictEqual(call?.args, [hostile, hostile, hostile, "datetime", "2026", "1", "31", "18", "0"])
        assert.isTrue(call?.script.trimStart().startsWith("on run argv"))
        assert.isFalse(call?.script.includes("rm -rf") ?? true)
        assert.include(call?.script ?? "", "set day of d to 1")
        assert.strictEqual(created.title, hostile)
        assert.strictEqual(created.notes, hostile)
      })))

  it.effect("treats a date-only due as an all-day reminder", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* addArgs({ title: "Pay rent", due: "2026-11-01" }), [
        "date",
        "2026",
        "11",
        "1",
        "0",
        "0"
      ])
    }))

  it.effect("passes a floating local time through untouched", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(
        yield* addArgs({ title: "x", due: "2026-03-08T02:30" }, "America/New_York"),
        ["datetime", "2026", "3", "8", "2", "30"]
      )
    }))

  it.effect("converts an offset or Z due into local wall-clock time", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* addArgs({ title: "x", due: "2026-10-11T12:30:00Z" }), [
        "datetime",
        "2026",
        "10",
        "11",
        "9",
        "30"
      ])
      // Crosses midnight and the month boundary.
      assert.deepStrictEqual(yield* addArgs({ title: "x", due: "2026-11-01T01:15+00:00" }), [
        "datetime",
        "2026",
        "10",
        "31",
        "22",
        "15"
      ])
      // New York switches to EDT on 2026-03-08 at 07:00Z.
      assert.deepStrictEqual(yield* addArgs({ title: "x", due: "2026-03-08T07:30Z" }, "America/New_York"), [
        "datetime",
        "2026",
        "3",
        "8",
        "3",
        "30"
      ])
      assert.deepStrictEqual(yield* addArgs({ title: "x", due: "2026-03-08T06:30Z" }, "America/New_York"), [
        "datetime",
        "2026",
        "3",
        "8",
        "1",
        "30"
      ])
    }))

  it.effect.each([
    { name: "blank title", input: { title: "   " } },
    { name: "oversized title", input: { title: "a".repeat(501) } },
    { name: "malformed date", input: { title: "x", due: "tomorrow" } },
    { name: "impossible date", input: { title: "x", due: "2026-02-31" } },
    { name: "impossible zoned date", input: { title: "x", due: "2026-02-31T10:00Z" } },
    { name: "hour 24", input: { title: "x", due: "2026-02-10T24:00" } },
    { name: "minute 60", input: { title: "x", due: "2026-02-10T10:60-03:00" } },
    { name: "offset out of range", input: { title: "x", due: "2026-02-10T10:00+25:00" } },
    { name: "empty list name", input: { title: "x", list: " " } },
    { name: "record separator in title", input: { title: "a\u001eb" } },
    { name: "field separator in notes", input: { title: "x", notes: "a\u001fb" } },
    { name: "NUL in list name", input: { title: "x", list: "a\u0000b" } }
  ])("rejects $name before running a script", ({ input }) =>
    withReply("", (calls) =>
      Effect.gen(function*() {
        const reminders = yield* Reminders
        const error = yield* reminders.add(input).pipe(Effect.flip)
        assert.instanceOf(error, AutomationError)
        assert.deepStrictEqual(yield* Ref.get(calls), [])
      })))

  it.effect("accepts newlines and tabs in notes", () =>
    Effect.gen(function*() {
      const args = yield* addArgs({ title: "x", notes: "a\n\tb\r\n" })
      assert.strictEqual(args[0], "none")
    }))

  it.effect("fails with AutomationError on malformed output", () =>
    withReply(record("only", "three", "fields"), () =>
      Effect.gen(function*() {
        const reminders = yield* Reminders
        const error = yield* reminders.list().pipe(Effect.flip)
        assert.instanceOf(error, AutomationError)
      })))

  it.effect("fails when add returns nothing", () =>
    withReply("", () =>
      Effect.gen(function*() {
        const reminders = yield* Reminders
        const error = yield* reminders.add({ title: "x" }).pipe(Effect.flip)
        assert.instanceOf(error, AutomationError)
      })))
})
