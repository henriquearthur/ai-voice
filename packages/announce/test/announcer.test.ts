import { assert, describe, it } from "@effect/vitest"
import { AlexaConfig } from "@jarvis/alexa"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import { AnnounceConfig } from "../src/index.ts"
import { announcer, decide, makeMemoryFileSystem, setLocalTime, speak, STATE_DIR, STATE_FILE } from "./fixtures.ts"

const MESSAGE = { source: "agenda", body: "Reunião com o time em cinco minutos" }
const SPOKEN = "Reunião com o time em cinco minutos."

describe("Announcer quiet hours", () => {
  const at = (local: string) =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      yield* setLocalTime(local)
      return yield* decide(MESSAGE).pipe(Effect.provide(announcer(fs)))
    })

  it.effect("speaks at 22:59 and 07:00, stays quiet at 23:00 and 06:59", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* at("2026-10-12T22:59"), speak(SPOKEN))
      assert.deepStrictEqual(yield* at("2026-10-12T23:00"), { _tag: "skip", reason: "quiet-hours" })
      assert.deepStrictEqual(yield* at("2026-10-13T02:30"), { _tag: "skip", reason: "quiet-hours" })
      assert.deepStrictEqual(yield* at("2026-10-13T06:59"), { _tag: "skip", reason: "quiet-hours" })
      assert.deepStrictEqual(yield* at("2026-10-13T07:00"), speak(SPOKEN))
    }))

  it.effect("can be turned off", () =>
    Effect.gen(function*() {
      yield* setLocalTime("2026-10-13T03:00")
      const result = yield* decide(MESSAGE).pipe(Effect.provide(announcer(makeMemoryFileSystem(), {
        quietHours: Option.none()
      })))
      assert.deepStrictEqual(result, speak(SPOKEN))
    }))

  it.effect("does not touch the state file when quiet", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      yield* setLocalTime("2026-10-13T01:00")
      yield* decide(MESSAGE).pipe(Effect.provide(announcer(fs)))
      assert.isFalse(fs.entries.has(STATE_FILE))
    }))
})

describe("Announcer dedup and rate limit", () => {
  it.effect("skips the same content for 10 minutes, then speaks it again", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      const run = (input: typeof MESSAGE) => decide(input).pipe(Effect.provide(announcer(fs)))
      yield* setLocalTime("2026-10-12T12:00")
      assert.deepStrictEqual(yield* run(MESSAGE), speak(SPOKEN))
      yield* TestClock.adjust("5 minutes")
      // Case, accents and punctuation do not make it new content.
      assert.deepStrictEqual(yield* run({ source: "agenda", body: "reuniao com o TIME em cinco minutos!!" }), {
        _tag: "skip",
        reason: "duplicate"
      })
      yield* TestClock.adjust("4 minutes")
      assert.deepStrictEqual(yield* run(MESSAGE), { _tag: "skip", reason: "duplicate" })
      yield* TestClock.adjust("1 minute")
      assert.deepStrictEqual(yield* run(MESSAGE), speak(SPOKEN))
    }))

  it.effect("allows at most N announcements per minute", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      const run = (n: number) =>
        decide({ source: "agenda", body: `Lembrete número ${n} para hoje` }).pipe(Effect.provide(announcer(fs)))
      yield* setLocalTime("2026-10-12T12:00")
      for (const n of [1, 2, 3]) assert.strictEqual((yield* run(n))._tag, "speak")
      assert.deepStrictEqual(yield* run(4), { _tag: "skip", reason: "rate-limited" })
      yield* TestClock.adjust("59 seconds")
      assert.deepStrictEqual(yield* run(5), { _tag: "skip", reason: "rate-limited" })
      yield* TestClock.adjust("1 second")
      assert.strictEqual((yield* run(6))._tag, "speak")
    }))

  it.effect("respects a custom limit", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      const run = (n: number) =>
        decide({ source: "agenda", body: `Lembrete número ${n} para hoje` }).pipe(
          Effect.provide(announcer(fs, { maxPerMinute: 1 }))
        )
      yield* setLocalTime("2026-10-12T12:00")
      assert.strictEqual((yield* run(1))._tag, "speak")
      assert.deepStrictEqual(yield* run(2), { _tag: "skip", reason: "rate-limited" })
    }))
})

describe("Announcer state file", () => {
  it.effect("is private, atomic and stores only hashes", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      yield* setLocalTime("2026-10-12T12:00")
      yield* decide(MESSAGE).pipe(Effect.provide(announcer(fs)))
      assert.deepStrictEqual([...fs.entries.keys()].sort(), [STATE_DIR, STATE_FILE])
      assert.strictEqual(fs.entries.get(STATE_DIR)!.mode, 0o700)
      assert.strictEqual(fs.entries.get(STATE_FILE)!.mode, 0o600)
      const content = fs.entries.get(STATE_FILE)!.content!
      assert.notInclude(content.toLowerCase(), "reuni")
      const state = JSON.parse(content)
      assert.strictEqual(state.version, 1)
      assert.lengthOf(state.spoken, 1)
      assert.match(state.spoken[0].hash, /^[0-9a-f]{32}$/)
    }))

  it.effect("prunes entries older than the dedup window", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      const run = (n: number) =>
        decide({ source: "agenda", body: `Lembrete número ${n} para hoje` }).pipe(Effect.provide(announcer(fs)))
      yield* setLocalTime("2026-10-12T12:00")
      yield* run(1)
      yield* run(2)
      yield* TestClock.adjust("11 minutes")
      yield* run(3)
      assert.lengthOf(JSON.parse(fs.entries.get(STATE_FILE)!.content!).spoken, 1)
    }))

  for (const corrupt of ["{not json", "null", "{\"version\":2,\"spoken\":[]}", "{\"version\":1,\"spoken\":\"x\"}"]) {
    it.effect(`starts fresh from a corrupt file: ${corrupt}`, () =>
      Effect.gen(function*() {
        const fs = makeMemoryFileSystem()
        fs.entries.set(STATE_DIR, { directory: true, mode: 0o700 })
        fs.entries.set(STATE_FILE, { directory: false, mode: 0o600, content: corrupt })
        yield* setLocalTime("2026-10-12T12:00")
        assert.deepStrictEqual(yield* decide(MESSAGE).pipe(Effect.provide(announcer(fs))), speak(SPOKEN))
        assert.strictEqual(JSON.parse(fs.entries.get(STATE_FILE)!.content!).version, 1)
      }))
  }

  it.effect("tightens an existing state directory to 0700", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      fs.entries.set(STATE_DIR, { directory: true, mode: 0o755 })
      yield* setLocalTime("2026-10-12T12:00")
      yield* decide(MESSAGE).pipe(Effect.provide(announcer(fs)))
      assert.strictEqual(fs.entries.get(STATE_DIR)!.mode, 0o700)
    }))
})

describe("AnnounceConfig", () => {
  const load = (env: Record<string, string>) =>
    Effect.gen(function*() {
      return yield* AnnounceConfig
    }).pipe(
      Effect.provide(AnnounceConfig.layer.pipe(
        Layer.provide(Layer.succeed(AlexaConfig, AlexaConfig.of({
          stateDir: "/state",
          amazonPage: "amazon.com.br",
          locale: "pt-BR",
          alexaHost: Option.none(),
          speechEnabled: true,
          defaultDevice: Option.none(),
          speakLock: "/state/alexa-speak.lock"
        }))),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env })))
      ))
    )

  it.effect("defaults to no quiet hours and 3 per minute", () =>
    Effect.gen(function*() {
      const config = yield* load({})
      assert.strictEqual(config.stateDir, "/state")
      assert.isTrue(Option.isNone(config.quietHours))
      assert.strictEqual(config.maxPerMinute, 3)
    }))

  it.effect("reads the variables, and \"off\" disables quiet hours", () =>
    Effect.gen(function*() {
      const config = yield* load({ JARVIS_ANNOUNCE_QUIET: "off", JARVIS_ANNOUNCE_MAX_PER_MINUTE: "5" })
      assert.isTrue(Option.isNone(config.quietHours))
      assert.strictEqual(config.maxPerMinute, 5)
      const custom = yield* load({ JARVIS_ANNOUNCE_QUIET: "22:30-06:15" })
      assert.deepStrictEqual(custom.quietHours, Option.some({ start: 22 * 60 + 30, end: 6 * 60 + 15 }))
    }))

  it.effect("rejects an invalid window", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(load({ JARVIS_ANNOUNCE_QUIET: "tarde" }))
      assert.strictEqual(error._tag, "AnnounceConfigError")
    }))
})
