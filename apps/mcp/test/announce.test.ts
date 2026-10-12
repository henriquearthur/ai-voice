import { assert, describe, it } from "@effect/vitest"
import { Alexa } from "@jarvis/alexa"
import { Announcer } from "@jarvis/announce"
import { Effect, Layer, Option, Ref, Stdio, Stream } from "effect"
import { makeMemoryFileSystem, testConfig } from "../../../packages/announce/test/fixtures.ts"
import { fakeSpeaker, makeFakeMacVoice } from "./callback-fixtures.ts"
import { AnnounceConfig } from "@jarvis/announce"
import { announce, type AnnounceFlags } from "../src/announce.ts"

const flags = (overrides: Partial<AnnounceFlags> = {}): AnnounceFlags => ({
  body: Option.none(),
  title: Option.none(),
  event: Option.none(),
  project: Option.none(),
  source: "claude-code",
  ...overrides
})

// Fake Alexa and Mac voice behind the real Speaker router: records every speak call, never
// reaches Amazon and never plays sound. The tests default to the Echo; `output: "mac"` routes to the Mac.
const harness = (
  options: { readonly stdin?: string; readonly terminal?: boolean; readonly output?: "mac" | "echo" } = {}
) =>
  Effect.gen(function*() {
    const spoken = yield* Ref.make<ReadonlyArray<string>>([])
    const alexa = Layer.succeed(
      Alexa,
      Alexa.of({
        devices: Effect.succeed([]),
        speak: ({ text }) =>
          Ref.update(spoken, (all) => [...all, text]).pipe(
            Effect.as({ status: "accepted", device: "Fake", chunks: 1, playbackConfirmed: false } as const)
          )
      })
    )
    const mac = makeFakeMacVoice()
    const speaker = fakeSpeaker(options.output ?? "echo", alexa, mac.layer)
    const stdio = Stdio.layerTest({
      stdinIsTerminal: Effect.succeed(options.terminal ?? false),
      stdin: options.terminal ? Stream.never : Stream.make(new TextEncoder().encode(options.stdin ?? ""))
    })
    const announcer = Announcer.layer.pipe(
      Layer.provide(Layer.merge(makeMemoryFileSystem().layer, Layer.succeed(AnnounceConfig, testConfig({ quietHours: Option.none() }))))
    )
    const run = (value: AnnounceFlags) =>
      announce(value).pipe(Effect.provide(Layer.mergeAll(speaker, stdio, announcer, makeMemoryFileSystem().layer)))
    return { run, spoken: Ref.get(spoken), macSpoken: Effect.sync(() => [...mac.spoken]) }
  })

describe("announce", () => {
  it.effect("speaks the pt-BR text from flags exactly once", () =>
    Effect.gen(function*() {
      const { run, spoken } = yield* harness({ stdin: "" })
      yield* run(flags({ body: Option.some("Reunião com o time em cinco minutos"), event: Option.some("waiting") }))
      assert.strictEqual((yield* spoken).length, 1)
      assert.include((yield* spoken)[0], "Reunião com o time em cinco minutos")
    }))

  it.effect("follows AI_VOICE_OUTPUT=mac and speaks on the Mac, not the Echo", () =>
    Effect.gen(function*() {
      const { run, spoken, macSpoken } = yield* harness({ stdin: "", output: "mac" })
      yield* run(flags({ body: Option.some("Reunião com o time em cinco minutos"), event: Option.some("waiting") }))
      assert.deepStrictEqual(yield* spoken, [])
      assert.strictEqual((yield* macSpoken).length, 1)
      assert.include((yield* macSpoken)[0], "Reunião com o time em cinco minutos")
    }))

  it.effect("skips without speaking and without failing", () =>
    Effect.gen(function*() {
      const { run, spoken } = yield* harness({ stdin: "" })
      yield* run(flags({ body: Option.some("   ") }))
      assert.deepStrictEqual(yield* spoken, [])
    }))

  it.effect("never speaks English input", () =>
    Effect.gen(function*() {
      const { run, spoken } = yield* harness({ stdin: "" })
      // Unclassifiable English is skipped; classified English becomes a pt-BR template.
      yield* run(flags({ body: Option.some("Refactoring the parser module for better readability") }))
      yield* run(flags({ body: Option.some("The build finished and all of the tests are passing now") }))
      assert.deepStrictEqual(yield* spoken, ["Pronto, terminei."])
    }))

  it.effect("does not block when stdin is a terminal", () =>
    Effect.gen(function*() {
      const { run, spoken } = yield* harness({ terminal: true })
      yield* run(flags())
      assert.deepStrictEqual(yield* spoken, [])
    }).pipe(Effect.timeout("2 seconds")))

  it.effect("parses the Stop hook JSON from stdin", () =>
    Effect.gen(function*() {
      const hook = JSON.stringify({ hook_event_name: "Stop", cwd: "/work/ai-voice" })
      const { run, spoken } = yield* harness({ stdin: hook })
      yield* run(flags({ body: Option.some("Tarefa concluída com sucesso") }))
      const all = yield* spoken
      assert.strictEqual(all.length, 1)
      assert.include(all[0], "Tarefa concluída com sucesso")
    }))

  it.effect("maps a permission_prompt hook to a permission announcement", () =>
    Effect.gen(function*() {
      const hook = JSON.stringify({
        hook_event_name: "Notification",
        notification_type: "permission_prompt",
        message: "Claude precisa da sua permissão para usar o Bash",
        cwd: "/work/ai-voice"
      })
      const { run, spoken } = yield* harness({ stdin: hook })
      yield* run(flags())
      const all = yield* spoken
      assert.strictEqual(all.length, 1)
      assert.include(all[0], "permissão")
    }))

  it.effect("rejects a stdin that is not hook JSON", () =>
    Effect.gen(function*() {
      const { run, spoken } = yield* harness({ stdin: "not json" })
      const error = yield* run(flags()).pipe(Effect.flip)
      assert.strictEqual(error._tag, "AnnounceInputError")
      assert.deepStrictEqual(yield* spoken, [])
    }))
})
