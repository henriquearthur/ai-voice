import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer, Sink, Stream } from "effect"
import { PlatformError, SystemError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { FIELD_SEPARATOR as FS, Osascript, parseRecords, RECORD_SEPARATOR as RS } from "../src/osascript.ts"

interface Reply {
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly hang?: boolean
  readonly spawnFails?: boolean
}

// Never spawns anything: records each command and answers with a canned reply.
const fakeSpawner = (reply: Reply = {}) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const state = { released: 0 }
  const spawner = ChildProcessSpawner.make((command) =>
    reply.spawnFails === true
      ? Effect.fail(
        new PlatformError(new SystemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }))
      )
      : Effect.acquireRelease(Effect.sync(() => {
      if (!ChildProcess.isStandardCommand(command)) throw new Error("unexpected piped command")
      commands.push(command)
      const stdout = Stream.encodeText(Stream.make(reply.stdout ?? ""))
      const stderr = Stream.encodeText(Stream.make(reply.stderr ?? ""))
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: reply.hang === true
          ? Effect.never
          : Effect.succeed(ChildProcessSpawner.ExitCode(reply.exitCode ?? 0)),
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
    }), () => Effect.sync(() => void state.released++))
  )
  const layer = Osascript.layer.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))
  )
  return { commands, layer, state }
}

const hostile = "\" & do shell script \"open -a Calculator\" & \""

describe("Osascript.run", () => {
  it.effect("passes values as argv after `--`, never inside the script source", () => {
    const { commands, layer } = fakeSpawner({ stdout: "done\n" })
    const script = "on run argv\nreturn item 1 of argv\nend run"
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const output = yield* osascript.run(script, [hostile, "-e"])
      assert.strictEqual(output, "done")
      assert.strictEqual(commands.length, 1)
      const [command] = commands
      assert.strictEqual(command?.command, "/usr/bin/osascript")
      assert.deepStrictEqual(command?.args, ["-e", script, "--", hostile, "-e"])
      assert.isUndefined(command?.options.shell)
      assert.strictEqual(command?.options.stdin, "ignore")
      assert.isDefined(command?.options.forceKillAfter)
    }).pipe(Effect.provide(layer))
  })

  it.effect("drops only the final newline, keeping whitespace inside the value", () => {
    const { layer } = fakeSpawner({ stdout: `  lead${FS}trail  ${RS}\n` })
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const output = yield* osascript.run("on run argv\nend run")
      assert.deepStrictEqual(parseRecords(output), [["  lead", "trail  "]])
    }).pipe(Effect.provide(layer))
  })

  it.effect("fails instead of buffering unbounded output", () => {
    const { layer, state } = fakeSpawner({ stdout: "x".repeat(1_000_001) })
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const error = yield* Effect.flip(osascript.run("on run argv\nend run"))
      assert.strictEqual(error.message, "AppleScript produced too much output.")
      assert.strictEqual(state.released, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("reports a process that cannot be started", () => {
    const { layer } = fakeSpawner({ spawnFails: true })
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const error = yield* Effect.flip(osascript.run("on run argv\nend run"))
      assert.strictEqual(error.message, "Could not run AppleScript.")
    }).pipe(Effect.provide(layer))
  })

  it.effect("maps error -1744 to the Automation permission hint", () => {
    const { layer } = fakeSpawner({
      exitCode: 1,
      stderr: "execution error: Not authorised to send Apple events to Calendar. (-1744)\n"
    })
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const error = yield* Effect.flip(osascript.run("on run argv\nend run"))
      assert.include(error.message, "Privacy & Security > Automation")
    }).pipe(Effect.provide(layer))
  })

  it.effect("maps error -1743 to an Automation permission hint", () => {
    const { layer } = fakeSpawner({
      exitCode: 1,
      stderr: "0:58: execution error: Not authorized to send Apple events to Reminders. (-1743)\n"
    })
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const error = yield* Effect.flip(osascript.run("on run argv\nend run"))
      assert.strictEqual(error._tag, "AutomationError")
      assert.include(error.message, "Privacy & Security > Automation")
    }).pipe(Effect.provide(layer))
  })

  it.effect("surfaces stderr without the source range on a non-zero exit", () => {
    const { layer } = fakeSpawner({
      exitCode: 1,
      stderr: "12:40: execution error: Can’t get list \"Nope\". (-1728)\n"
    })
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const error = yield* Effect.flip(osascript.run("on run argv\nend run"))
      assert.strictEqual(error.message, "execution error: Can’t get list \"Nope\". (-1728)")
    }).pipe(Effect.provide(layer))
  })

  it.effect("uses a generic message when a failing run prints nothing", () => {
    const { layer } = fakeSpawner({ exitCode: 1 })
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const error = yield* Effect.flip(osascript.run("on run argv\nend run"))
      assert.strictEqual(error.message, "The AppleScript command failed.")
    }).pipe(Effect.provide(layer))
  })

  it.effect("fails after 15 seconds and releases the process", () => {
    const { layer, state } = fakeSpawner({ hang: true })
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const fiber = yield* Effect.forkChild(Effect.flip(osascript.run("on run argv\nend run")))
      yield* TestClock.adjust("15 seconds")
      const error = yield* Fiber.join(fiber)
      assert.include(error.message, "did not finish within 15s")
      assert.strictEqual(state.released, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps the 15 second default when no per-call timeout is given", () => {
    const { layer, state } = fakeSpawner({ hang: true })
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const fiber = yield* Effect.forkChild(Effect.flip(osascript.run("on run argv\nend run", [], {})))
      yield* TestClock.adjust("14999 millis")
      assert.isUndefined(fiber.pollUnsafe())
      assert.strictEqual(state.released, 0)
      yield* TestClock.adjust("1 millis")
      const error = yield* Fiber.join(fiber)
      assert.include(error.message, "did not finish within 15s")
      assert.strictEqual(state.released, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("respects a longer per-call timeout", () => {
    const { layer, state } = fakeSpawner({ hang: true })
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const fiber = yield* Effect.forkChild(
        Effect.flip(osascript.run("on run argv\nend run", [], { timeout: "45 seconds" }))
      )
      yield* TestClock.adjust("15 seconds")
      assert.isUndefined(fiber.pollUnsafe())
      yield* TestClock.adjust("29999 millis")
      assert.isUndefined(fiber.pollUnsafe())
      assert.strictEqual(state.released, 0)
      yield* TestClock.adjust("1 millis")
      const error = yield* Fiber.join(fiber)
      assert.include(error.message, "did not finish within 45s")
      assert.strictEqual(state.released, 1)
    }).pipe(Effect.provide(layer))
  })

  it.effect("respects a shorter per-call timeout", () => {
    const { layer, state } = fakeSpawner({ hang: true })
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      const fiber = yield* Effect.forkChild(
        Effect.flip(osascript.run("on run argv\nend run", [], { timeout: Duration.seconds(2) }))
      )
      yield* TestClock.adjust("2 seconds")
      const error = yield* Fiber.join(fiber)
      assert.include(error.message, "did not finish within 2s")
      assert.strictEqual(state.released, 1)
    }).pipe(Effect.provide(layer))
  })
})

describe("Osascript.open", () => {
  it.effect("opens allowed URLs with /usr/bin/open and no shell", () => {
    const { commands, layer } = fakeSpawner()
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      yield* osascript.open("tel:+5511999998888")
      assert.strictEqual(commands[0]?.command, "/usr/bin/open")
      assert.deepStrictEqual(commands[0]?.args, ["tel:+5511999998888"])
      assert.isUndefined(commands[0]?.options.shell)
    }).pipe(Effect.provide(layer))
  })

  it.effect.each([
    ["TEL:+5511999998888", "tel:+5511999998888"],
    [" facetime-audio:+14155550123\n", "facetime-audio:+14155550123"],
    ["https://maps.apple.com/?q=caf%C3%A9", "https://maps.apple.com/?q=caf%C3%A9"],
    ["HTTPS://Maps.Apple.com:443/?daddr=x", "https://maps.apple.com/?daddr=x"]
  ])("opens %j as the normalized %j", ([url, expected]) => {
    const { commands, layer } = fakeSpawner()
    return Effect.gen(function*() {
      const osascript = yield* Osascript
      yield* osascript.open(url!)
      assert.deepStrictEqual(commands[0]?.args, [expected])
    }).pipe(Effect.provide(layer))
  })

  it.effect.each([
    "file:///etc/passwd",
    "-a Calculator",
    "x-apple.systempreferences:",
    "not a url",
    "tel:*#06#",
    "tel:#31#+5511999998888",
    "tel:+5511999998888;phone-context=example.com",
    "tel:+5511999998888?call=1",
    "tel:%2B5511999998888",
    "tel:11999998888",
    "facetime-audio://+5511999998888",
    "facetime-audio:someone@example.com",
    "http://maps.apple.com/?q=x",
    "https://maps.apple.com.evil.example/?q=x",
    "https://user@maps.apple.com/?q=x",
    "https://maps.apple.com:8443/?q=x",
    "https://maps.apple.com/?q=x#frag",
    "https://zoom.us/j/123456789"
  ])(
    "refuses %s",
    (url) => {
      const { commands, layer } = fakeSpawner()
      return Effect.gen(function*() {
        const osascript = yield* Osascript
        const error = yield* Effect.flip(osascript.open(url))
        assert.strictEqual(error.message, "Refusing to open an unsupported URL.")
        assert.strictEqual(commands.length, 0)
      }).pipe(Effect.provide(layer))
    }
  )
})

describe("parseRecords", () => {
  it("splits records and fields, keeping empty fields", () => {
    assert.deepStrictEqual(parseRecords(`a${FS}${FS}c${RS}d${FS}e${RS}`), [["a", "", "c"], ["d", "e"]])
  })

  it("returns no records for empty output", () => {
    assert.deepStrictEqual(parseRecords(""), [])
  })
})
