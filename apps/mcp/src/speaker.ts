import { Alexa, AlexaConfig, AlexaError, speechDisabled } from "@jarvis/alexa"
import { MacVoice, MacVoiceConfig, MacVoiceError } from "@jarvis/voice"
import { Config, Context, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"

/** Where `speak`, `announce` and `notify_fernando` play by default: this Mac or the default Echo. */
export const SpeechOutput = Schema.Literals(["mac", "echo"])
export type SpeechOutput = typeof SpeechOutput.Type

/** `AI_VOICE_OUTPUT`: `mac` (default, also when blank) or `echo`. Any other value fails at startup. */
export const SpeechOutputConfig: Config.Config<SpeechOutput> = Config.Literals(["mac", "echo", ""], "AI_VOICE_OUTPUT").pipe(
  Config.withDefault(""),
  Config.map((value) => value === "" ? "mac" : value)
)

/** What `speak` reports for either output. Only the Mac confirms playback. */
export const SpeakResult = Schema.Struct({
  status: Schema.Literal("accepted"),
  device: Schema.String,
  chunks: Schema.Int,
  playbackConfirmed: Schema.Boolean
})
export type SpeakResult = typeof SpeakResult.Type

export const SpeakError = Schema.Union([AlexaError, MacVoiceError])
export type SpeakError = typeof SpeakError.Type

export interface SpeakInput {
  readonly text: string
  readonly deviceSerial?: string | undefined
}

const make = Effect.fnUntraced(function*(output: SpeechOutput) {
  const alexa = yield* Alexa
  const mac = yield* MacVoice
  const { speechEnabled } = yield* AlexaConfig

  // An explicit device_serial always means an Echo. A single attempt either way: never falls back
  // from one output to the other, which could speak the same text twice.
  const speak = Effect.fn("Speaker.speak")(function*(input: SpeakInput) {
    if (input.deviceSerial !== undefined || output === "echo") return yield* alexa.speak(input)
    if (!speechEnabled) return yield* speechDisabled()
    return yield* mac.speak(input.text)
  })

  return { output, speak }
})

/**
 * Routes speech to the Mac (`say` or the local TTS server) or to an Echo through Alexa.
 */
export class Speaker extends Context.Service<Speaker, {
  readonly output: SpeechOutput
  readonly speak: (input: SpeakInput) => Effect.Effect<SpeakResult, SpeakError>
}>()("@jarvis/mcp/Speaker") {
  static readonly layerWith = (output: SpeechOutput) => Layer.effect(Speaker, make(output))

  static readonly layer = Layer.unwrap(Effect.map(SpeechOutputConfig, Speaker.layerWith))
}

/**
 * The real speech services: `Speaker` with the Mac voice and Alexa behind it, plus `Alexa`,
 * `AlexaConfig` and `MacVoice` for the tools that use them directly. One instance serves every session.
 */
export const SpeechLive = Speaker.layer.pipe(
  Layer.provideMerge(Alexa.layer),
  Layer.provideMerge(AlexaConfig.layer),
  Layer.provideMerge(MacVoice.layer.pipe(Layer.provide(MacVoiceConfig.layer))),
  Layer.provide(FetchHttpClient.layer)
)
