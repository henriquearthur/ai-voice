import { assert, describe, it } from "@effect/vitest"
import { AlexaConfig } from "@jarvis/alexa"
import { ConfigProvider, Effect, Layer, Option } from "effect"
import { Speaker, SpeechOutputConfig } from "../src/speaker.ts"
import { FakeConfig, fakeSpeaker, makeFakeAlexa, makeFakeMacVoice } from "./callback-fixtures.ts"

// The real router over a fake Echo and a fake Mac voice: nothing reaches Amazon, nothing plays.
const setup = (
  output: "mac" | "echo",
  options: { readonly speechEnabled?: boolean; readonly macFails?: boolean } = {}
) => {
  const alexa = makeFakeAlexa()
  const mac = makeFakeMacVoice({ fail: options.macFails ?? false })
  const config = options.speechEnabled === false ? DisabledConfig : FakeConfig
  return { alexa, mac, layer: fakeSpeaker(output, alexa.layer, mac.layer, config) }
}

const DisabledConfig = Layer.succeed(
  AlexaConfig,
  AlexaConfig.of({
    stateDir: "/state",
    amazonPage: "amazon.com.br",
    locale: "pt-BR",
    alexaHost: Option.none(),
    speechEnabled: false,
    defaultDevice: Option.some("ECHO-1"),
    speakLock: "/state/alexa-speak.lock"
  })
)

const speak = (input: { readonly text: string; readonly deviceSerial?: string }) =>
  Speaker.use((speaker) => speaker.speak(input))

describe("Speaker", () => {
  it.effect("speaks on the Mac by default and confirms playback", () => {
    const { alexa, mac, layer } = setup("mac")
    return Effect.gen(function*() {
      const result = yield* speak({ text: "Olá" })
      assert.deepStrictEqual(result, { status: "accepted", device: "Mac", chunks: 1, playbackConfirmed: true })
      assert.deepStrictEqual(mac.spoken, ["Olá"])
      assert.deepStrictEqual(alexa.spoken, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("sends to the Echo when the caller passes device_serial, even in mac mode", () => {
    const { alexa, mac, layer } = setup("mac")
    return Effect.gen(function*() {
      const result = yield* speak({ text: "Olá", deviceSerial: "ECHO-1" })
      assert.isFalse(result.playbackConfirmed)
      assert.deepStrictEqual(alexa.spoken, [{ text: "Olá", deviceSerial: "ECHO-1" }])
      assert.deepStrictEqual(mac.spoken, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("sends everything to the Echo when AI_VOICE_OUTPUT=echo", () => {
    const { alexa, mac, layer } = setup("echo")
    return Effect.gen(function*() {
      yield* speak({ text: "Olá" })
      assert.deepStrictEqual(alexa.spoken, [{ text: "Olá" }])
      assert.deepStrictEqual(mac.spoken, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("refuses Mac speech while AI_VOICE_ENABLE_SPEECH is off", () => {
    const { mac, layer } = setup("mac", { speechEnabled: false })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(speak({ text: "Olá" }))
      assert.match(error.message, /^Speech is disabled/)
      assert.deepStrictEqual(mac.spoken, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("reports a Mac failure once, without falling back to the Echo", () => {
    const { alexa, mac, layer } = setup("mac", { macFails: true })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(speak({ text: "Olá" }))
      assert.strictEqual(error._tag, "MacVoiceError")
      assert.deepStrictEqual(mac.spoken, ["Olá"])
      assert.deepStrictEqual(alexa.spoken, [])
    }).pipe(Effect.provide(layer))
  })
})

describe("AI_VOICE_OUTPUT", () => {
  const load = (env: Record<string, string>) =>
    Effect.gen(function*() {
      return yield* SpeechOutputConfig
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))

  it.effect("defaults to mac, also when blank, and accepts echo", () =>
    Effect.gen(function*() {
      assert.strictEqual(yield* load({}), "mac")
      assert.strictEqual(yield* load({ AI_VOICE_OUTPUT: "" }), "mac")
      assert.strictEqual(yield* load({ AI_VOICE_OUTPUT: "mac" }), "mac")
      assert.strictEqual(yield* load({ AI_VOICE_OUTPUT: "echo" }), "echo")
    }))

  it.effect("rejects any other value", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(load({ AI_VOICE_OUTPUT: "alexa" }))
      assert.strictEqual(error._tag, "ConfigError")
    }))
})
