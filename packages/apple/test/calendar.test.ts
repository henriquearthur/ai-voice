import { BunServices } from "@effect/platform-bun"
import { assert, describe, it } from "@effect/vitest"
import { mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Duration, Effect, Fiber, Layer, Sink, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { AutomationError } from "../src/apple-error.ts"
import { buildHelper, CalendarHelper, INSTALLED_HELPER, installHelper } from "../src/calendar-helper.ts"
import { Calendar } from "../src/calendar.ts"

// Pin a zone with DST so offsets in the formatted output are predictable.
process.env.TZ = "America/New_York"

const HELPER = "/opt/jarvis/bin/calendar-events"

interface Reply {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly hang?: boolean
}

// Never spawns anything: records each command and answers with a canned reply.
const fakeSpawner = (respond: (command: ChildProcess.StandardCommand) => Reply = () => ({})) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) throw new Error("unexpected piped command")
      commands.push(command)
      const reply = respond(command)
      const stdout = Stream.encodeText(Stream.make(reply.stdout ?? ""))
      const stderr = Stream.encodeText(Stream.make(reply.stderr ?? ""))
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: reply.hang === true ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(reply.exitCode ?? 0)),
        isRunning: Effect.succeed(reply.hang === true),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout,
        stderr,
        all: Stream.merge(stdout, stderr),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void)
      })
    })
  )
  return { commands, spawner: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) }
}

const withHelper = (respond: (command: ChildProcess.StandardCommand) => Reply) => {
  const fake = fakeSpawner(respond)
  const layer = Calendar.layerWithoutHelper.pipe(
    Layer.provide(CalendarHelper.layerAt(HELPER)),
    Layer.provide(fake.spawner)
  )
  return { commands: fake.commands, layer }
}

const json = (events: ReadonlyArray<Record<string, unknown>>) => JSON.stringify({ events }) + "\n"

const at = (iso: string) => Date.parse(iso)

const FROM = "2026-10-11T04:00:00.000Z"
const TO = "2026-10-12T04:00:00.000Z"

describe("Calendar (EventKit helper)", () => {
  it.effect("lists calendar names through the helper with a fixed argv", () => {
    const { commands, layer } = withHelper(() => ({ stdout: JSON.stringify({ calendars: ["Work", "Home"] }) }))
    return Effect.gen(function*() {
      const names = yield* Calendar.use((calendar) => calendar.calendars)
      assert.deepStrictEqual(names, ["Work", "Home"])
      const [command] = commands
      assert.strictEqual(command?.command, HELPER)
      assert.deepStrictEqual(command?.args, ["--list-calendars"])
      assert.isUndefined(command?.options.shell)
      assert.strictEqual(command?.options.stdin, "ignore")
      assert.isDefined(command?.options.forceKillAfter)
    }).pipe(Effect.provide(layer))
  })

  it.effect("passes the range as ISO instants and a hostile calendar name as a single argv entry", () => {
    const hostile = `--from "; rm -rf ~ #`
    const { commands, layer } = withHelper(() => ({ stdout: json([]) }))
    return Effect.gen(function*() {
      const events = yield* Calendar.use((calendar) => calendar.events({ from: FROM, to: TO, calendar: hostile }))
      assert.deepStrictEqual(events, [])
      assert.deepStrictEqual(commands[0]?.args, ["--from", FROM, "--to", TO, "--calendar", hostile])
    }).pipe(Effect.provide(layer))
  })

  it.effect("omits --calendar when no calendar is given", () => {
    const { commands, layer } = withHelper(() => ({ stdout: json([]) }))
    return Effect.gen(function*() {
      yield* Calendar.use((calendar) => calendar.events({ from: "2026-10-11T00:00:00-04:00", to: TO }))
      assert.deepStrictEqual(commands[0]?.args, ["--from", FROM, "--to", TO])
    }).pipe(Effect.provide(layer))
  })

  it.effect("turns the helper JSON into local ISO events sorted by start, then title", () => {
    const { layer } = withHelper(() => ({
      stdout: json([
        {
          id: "b",
          title: "Lunch",
          calendar: "Home",
          start: at("2026-10-11T12:00:00-04:00"),
          end: at("2026-10-11T13:00:00-04:00"),
          allDay: false,
          location: "Cafe"
        },
        {
          id: "c",
          title: "Holiday",
          calendar: "Feriados",
          start: at("2026-10-11T00:00:00-04:00"),
          end: at("2026-10-12T00:00:00-04:00"),
          allDay: true
        },
        {
          id: "a",
          title: "Alpha",
          calendar: "Work",
          start: at("2026-10-11T12:00:00-04:00"),
          end: at("2026-10-11T12:30:00-04:00"),
          allDay: false,
          location: ""
        }
      ])
    }))
    return Effect.gen(function*() {
      const events = yield* Calendar.use((calendar) => calendar.events({ from: FROM, to: TO }))
      assert.deepStrictEqual(events, [
        {
          id: "c",
          title: "Holiday",
          calendar: "Feriados",
          start: "2026-10-11T00:00:00.000-04:00",
          end: "2026-10-12T00:00:00.000-04:00",
          allDay: true
        },
        {
          id: "a",
          title: "Alpha",
          calendar: "Work",
          start: "2026-10-11T12:00:00.000-04:00",
          end: "2026-10-11T12:30:00.000-04:00",
          allDay: false
        },
        {
          id: "b",
          title: "Lunch",
          calendar: "Home",
          start: "2026-10-11T12:00:00.000-04:00",
          end: "2026-10-11T13:00:00.000-04:00",
          allDay: false,
          location: "Cafe"
        }
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps occurrences of a recurring series (same id) and drops anything outside the range", () => {
    const { layer } = withHelper(() => ({
      stdout: json([
        { id: "s", title: "Standup", calendar: "W", start: at(FROM), end: at(FROM) + 900_000, allDay: false },
        { id: "s", title: "Standup", calendar: "W", start: at(TO) - 900_000, end: at(TO), allDay: false },
        { id: "x", title: "Ended", calendar: "W", start: at(FROM) - 3_600_000, end: at(FROM), allDay: false }
      ])
    }))
    return Effect.gen(function*() {
      const events = yield* Calendar.use((calendar) => calendar.events({ from: FROM, to: TO }))
      assert.deepStrictEqual(events.map(({ id, start }) => `${id} ${start}`), [
        "s 2026-10-11T00:00:00.000-04:00",
        "s 2026-10-11T23:45:00.000-04:00"
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("today asks for the local day", () => {
    const { commands, layer } = withHelper(() => ({ stdout: json([]) }))
    return Effect.gen(function*() {
      yield* TestClock.setTime(at("2026-10-11T15:30:00-04:00"))
      yield* Calendar.use((calendar) => calendar.today)
      assert.deepStrictEqual(commands[0]?.args, ["--from", FROM, "--to", TO])
    }).pipe(Effect.provide(layer))
  })

  it.effect("reports a denied permission with a hint", () => {
    const { layer } = withHelper(() => ({ exitCode: 3, stderr: "calendar access denied\n" }))
    return Effect.gen(function*() {
      const error = yield* Effect.flip(Calendar.use((calendar) => calendar.today))
      assert.instanceOf(error, AutomationError)
      assert.include(error.message, "denied Calendar access")
      assert.include(error.message, "Privacy & Security > Calendars")
    }).pipe(Effect.provide(layer))
  })

  it.effect("tells write-only access apart from a denial", () => {
    const { layer } = withHelper(() => ({ exitCode: 3, stderr: "calendar access is write-only\n" }))
    return Effect.gen(function*() {
      const error = yield* Effect.flip(Calendar.use((calendar) => calendar.calendars))
      assert.include(error.message, "Add Events Only")
      assert.include(error.message, "Full Access")
    }).pipe(Effect.provide(layer))
  })

  it.effect("reports an unknown calendar", () => {
    const { layer } = withHelper(() => ({ exitCode: 4, stderr: "calendar not found\n" }))
    return Effect.gen(function*() {
      const error = yield* Effect.flip(
        Calendar.use((calendar) => calendar.events({ from: FROM, to: TO, calendar: "Nope" }))
      )
      assert.strictEqual(error.message, "Calendar not found: Nope")
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects malformed helper output", () => {
    const { layer } = withHelper(() => ({ stdout: `{"events":[{"id":1}]}` }))
    return Effect.gen(function*() {
      const error = yield* Effect.flip(Calendar.use((calendar) => calendar.events({ from: FROM, to: TO })))
      assert.include(error.message, "Unexpected Calendar output")
    }).pipe(Effect.provide(layer))
  })

  it.effect("validates the range before spawning anything", () => {
    const { commands, layer } = withHelper(() => ({ stdout: json([]) }))
    return Effect.gen(function*() {
      const backwards = yield* Effect.flip(Calendar.use((calendar) => calendar.events({ from: TO, to: FROM })))
      assert.include(backwards.message, "after")
      const tooLong = yield* Effect.flip(
        Calendar.use((calendar) => calendar.events({ from: FROM, to: "2026-12-01T00:00:00Z" }))
      )
      assert.include(tooLong.message, "31 days")
      const garbage = yield* Effect.flip(Calendar.use((calendar) => calendar.events({ from: "soon", to: TO })))
      assert.include(garbage.message, "ISO 8601")
      assert.strictEqual(commands.length, 0)
    }).pipe(Effect.provide(layer))
  })

  it.effect("gives up on a stuck helper after 10 s", () => {
    const { layer } = withHelper(() => ({ hang: true }))
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.flip(Calendar.use((calendar) => calendar.today)))
      yield* TestClock.adjust(Duration.seconds(9))
      assert.isUndefined(fiber.pollUnsafe())
      yield* TestClock.adjust(Duration.seconds(1))
      const error = yield* Fiber.join(fiber)
      assert.include(error.message, "did not finish within 10s")
    }).pipe(Effect.provide(layer))
  })

  it.effect("refuses a relative helper path", () =>
    Effect.gen(function*() {
      const layer = Calendar.layerWithoutHelper.pipe(
        Layer.provide(CalendarHelper.layerAt("calendar-events")),
        Layer.provide(fakeSpawner().spawner)
      )
      const error = yield* Effect.flip(Calendar.use((calendar) => calendar.calendars).pipe(Effect.provide(layer)))
      assert.include(error.message, "absolute")
    }))
})

describe("buildHelper", () => {
  it.effect("compiles once with swiftc + codesign into the cache directory, then reuses the binary", () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-bin-"))
    const previous = process.env["JARVIS_BIN_DIR"]
    process.env["JARVIS_BIN_DIR"] = directory
    const fake = fakeSpawner((command) => {
      const output = command.args[command.args.indexOf("-o") + 1]
      if (command.command === "/usr/bin/swiftc" && output !== undefined) writeFileSync(output, "binary")
      return {}
    })
    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const first = yield* buildHelper(spawner)
      const second = yield* buildHelper(spawner)
      assert.strictEqual(first, second)
      assert.match(first, /\/calendar-events-[0-9a-f]{12}$/)
      assert.deepStrictEqual(readdirSync(directory), [first.slice(directory.length + 1)])
      assert.deepStrictEqual(fake.commands.map((command) => command.command), ["/usr/bin/swiftc", "/usr/bin/codesign"])
      assert.include(fake.commands[0]?.args, "__info_plist")
    }).pipe(
      Effect.provide(fake.spawner),
      Effect.ensuring(Effect.sync(() => {
        if (previous === undefined) delete process.env["JARVIS_BIN_DIR"]
        else process.env["JARVIS_BIN_DIR"] = previous
        rmSync(directory, { recursive: true, force: true })
      }))
    )
  })

  it.effect("installs the built helper under a stable name", () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-bin-"))
    const previous = process.env["JARVIS_BIN_DIR"]
    process.env["JARVIS_BIN_DIR"] = directory
    const fake = fakeSpawner((command) => {
      const output = command.args[command.args.indexOf("-o") + 1]
      if (command.command === "/usr/bin/swiftc" && output !== undefined) writeFileSync(output, "binary")
      return {}
    })
    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const installed = yield* installHelper(spawner)
      assert.strictEqual(installed, join(directory, INSTALLED_HELPER))
      assert.match(readlinkSync(installed), /^calendar-events-[0-9a-f]{12}$/)
      // Reinstalling replaces the link instead of failing on the existing one.
      assert.strictEqual(yield* installHelper(spawner), installed)
      assert.strictEqual(readdirSync(directory).length, 2)
    }).pipe(
      Effect.provide(fake.spawner),
      Effect.ensuring(Effect.sync(() => {
        if (previous === undefined) delete process.env["JARVIS_BIN_DIR"]
        else process.env["JARVIS_BIN_DIR"] = previous
        rmSync(directory, { recursive: true, force: true })
      }))
    )
  })

  it.effect("without the sources, runs the installed helper and builds nothing", () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-bin-"))
    const previous = process.env["JARVIS_BIN_DIR"]
    process.env["JARVIS_BIN_DIR"] = directory
    const missing = { source: join(directory, "missing.swift"), infoPlist: join(directory, "missing.plist") }
    const fake = fakeSpawner()
    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const error = yield* Effect.flip(buildHelper(spawner, missing))
      assert.include(error.message, "build:native")
      writeFileSync(join(directory, INSTALLED_HELPER), "binary")
      assert.strictEqual(yield* buildHelper(spawner, missing), join(directory, INSTALLED_HELPER))
      assert.deepStrictEqual(fake.commands, [])
    }).pipe(
      Effect.provide(fake.spawner),
      Effect.ensuring(Effect.sync(() => {
        if (previous === undefined) delete process.env["JARVIS_BIN_DIR"]
        else process.env["JARVIS_BIN_DIR"] = previous
        rmSync(directory, { recursive: true, force: true })
      }))
    )
  })

  it.effect("cleans up and explains a failed build", () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-bin-"))
    const previous = process.env["JARVIS_BIN_DIR"]
    process.env["JARVIS_BIN_DIR"] = directory
    const fake = fakeSpawner(() => ({ exitCode: 1, stderr: "xcrun: error: invalid active developer path" }))
    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const error = yield* Effect.flip(buildHelper(spawner))
      assert.include(error.message, "Command Line Tools")
      assert.deepStrictEqual(readdirSync(directory), [])
    }).pipe(
      Effect.provide(fake.spawner),
      Effect.ensuring(Effect.sync(() => {
        if (previous === undefined) delete process.env["JARVIS_BIN_DIR"]
        else process.env["JARVIS_BIN_DIR"] = previous
        rmSync(directory, { recursive: true, force: true })
      }))
    )
  })
})

// Reads the real Calendar (never writes). Opt in with JARVIS_CALENDAR_LIVE=1;
// the process running the tests needs Full Access in Privacy & Security > Calendars.
describe.runIf(process.env["JARVIS_CALENDAR_LIVE"] === "1")("Calendar (live, read-only)", () => {
  it.live("lists calendars and reads the next 7 days through EventKit", () =>
    Effect.gen(function*() {
      const calendar = yield* Calendar
      const names = yield* calendar.calendars
      assert.isAbove(names.length, 0)
      const today = yield* calendar.today
      const from = new Date()
      const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000)
      const week = yield* calendar.events({ from: from.toISOString(), to: to.toISOString() })
      for (const event of [...today, ...week]) assert.isBelow(Date.parse(event.start), Date.parse(event.end) + 1)
    }).pipe(Effect.provide(Calendar.layer.pipe(Layer.provide(BunServices.layer)))), { timeout: 180_000 })
})
