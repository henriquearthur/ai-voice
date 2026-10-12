import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Path } from "effect"
import { AlexaConfig } from "../src/index.ts"

const load = (env: Record<string, string>) =>
  Effect.gen(function*() {
    return yield* AlexaConfig
  }).pipe(
    Effect.provide(AlexaConfig.layer.pipe(
      Layer.provide(Layer.merge(Path.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
    ))
  )

describe("AlexaConfig", () => {
  it.effect("speech is disabled by default and the defaults match the original CLI", () =>
    Effect.gen(function*() {
      const config = yield* load({ HOME: "/home/user" })
      assert.deepStrictEqual(config, {
        stateDir: "/home/user/.local/share/ai-voice",
        amazonPage: "amazon.com",
        locale: "en-US",
        alexaHost: Option.none(),
        speechEnabled: false,
        defaultDevice: Option.none(),
        speakLock: "/tmp/alexa-speak.lock"
      })
    }))

  it.effect("reads every variable, and only \"1\" enables speech", () =>
    Effect.gen(function*() {
      const config = yield* load({
        AI_VOICE_STATE_DIR: "/srv/voice/../ai-voice",
        AI_VOICE_AMAZON_PAGE: "amazon.com.br",
        AI_VOICE_LOCALE: "pt-BR",
        AI_VOICE_ALEXA_HOST: "alexa.amazon.com.br",
        AI_VOICE_ENABLE_SPEECH: "1",
        AI_VOICE_DEFAULT_DEVICE: "SERIAL",
        AI_VOICE_SPEAK_LOCK: "/var/run/../tmp/echo.lock"
      })
      assert.deepStrictEqual(config, {
        stateDir: "/srv/ai-voice",
        amazonPage: "amazon.com.br",
        locale: "pt-BR",
        alexaHost: Option.some("alexa.amazon.com.br"),
        speechEnabled: true,
        defaultDevice: Option.some("SERIAL"),
        speakLock: "/var/tmp/echo.lock"
      })
      assert.isFalse((yield* load({ HOME: "/h", AI_VOICE_ENABLE_SPEECH: "true" })).speechEnabled)
    }))
})
