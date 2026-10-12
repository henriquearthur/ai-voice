import { observeTools } from "@jarvis/telemetry"
import { Alexa, AlexaError, Echo, MAX_TEXT_LENGTH } from "@jarvis/alexa"
import { Effect, Schema, SchemaTransformation } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { SpeakError, SpeakResult, Speaker, type SpeechOutput } from "./speaker.ts"

// The wire format stays snake_case so existing agents and prompts keep working.
export const EchoDevice = Echo.pipe(Schema.encodeKeys({ isDefault: "is_default" }))

const ListDevices = Tool.make("list_devices", {
  description: "Lists the physical Echo devices on the Amazon account without playing audio.",
  // Stateful protocol adapters omit structured output for non-object results, so agents get the JSON array as text.
  success: Schema.Array(EchoDevice),
  failure: AlexaError
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true)

const SpeakParameters = Schema.Struct({
  // Surrounding whitespace is dropped, so " SERIAL " still matches and a blank serial is invalid.
  deviceSerial: Schema.optionalKey(
    Schema.NonEmptyString.annotate({
      description: "Serial returned by list_devices. Sends the speech to that Echo instead of the default output."
    }).pipe(Schema.decodeTo(Schema.NonEmptyString, SchemaTransformation.trim()))
  ),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TEXT_LENGTH)).annotate({
    description: `Plain text, up to ${MAX_TEXT_LENGTH} UTF-16 code units; no SSML.`
  })
}).pipe(Schema.encodeKeys({ deviceSerial: "device_serial" }))

const outputDescription = (output: SpeechOutput) =>
  output === "mac"
    ? "By default speaks on this Mac's audio output and returns after playback ends (playback_confirmed true). " +
      "With device_serial, speaks on that Echo instead; long text is then split into an ordered sequence and " +
      "success only means Alexa accepted it (playback_confirmed false). "
    : "Speaks in the Alexa voice on an Echo device, the default Echo when device_serial is omitted. " +
      "Long text is split into an ordered sequence; success only means Alexa accepted it (playback_confirmed false). "

const makeSpeak = (locale: string, output: SpeechOutput) =>
  Tool.make("speak", {
    description: `Speaks text aloud, using locale ${locale}. ${outputDescription(output)}` +
      "Use when the user asks for speech; do not retry automatically after an error or timeout.",
    parameters: SpeakParameters,
    success: SpeakResult.pipe(Schema.encodeKeys({ playbackConfirmed: "playback_confirmed" })),
    failure: SpeakError
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false)
    .annotate(Tool.OpenWorld, true)

/**
 * The voice tools, with descriptions that name the configured speech locale and default output.
 */
export const makeVoiceToolkit = (locale: string, output: SpeechOutput) =>
  Toolkit.make(ListDevices, makeSpeak(locale, output))

export type VoiceToolkit = ReturnType<typeof makeVoiceToolkit>

/**
 * Binds `list_devices` to the `Alexa` service (Echoes only) and `speak` to the `Speaker` router.
 */
export const voiceHandlers = (toolkit: VoiceToolkit) =>
  toolkit.toLayer(Effect.gen(function*() {
    const alexa = yield* Alexa
    const speaker = yield* Speaker
    return toolkit.of(observeTools("mcp", {
      list_devices: () => alexa.devices,
      speak: (input) => speaker.speak(input)
    }))
  }))
