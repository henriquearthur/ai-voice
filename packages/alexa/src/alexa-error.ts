import { Schema } from "effect"

export class SessionError extends Schema.TaggedError<SessionError>()("SessionError", {
  message: Schema.String
}) {}

export class DeviceError extends Schema.TaggedError<DeviceError>()("DeviceError", {
  message: Schema.String
}) {}

export class SpeechError extends Schema.TaggedError<SpeechError>()("SpeechError", {
  message: Schema.String
}) {}

/** AI_VOICE_ENABLE_SPEECH is not "1". It gates every speech output: Echo and Mac. */
export const speechDisabled = () =>
  new SpeechError({
    message: "Speech is disabled. Once the user authorizes it, set AI_VOICE_ENABLE_SPEECH=1 and restart the MCP server."
  })

export const AlexaError = Schema.Union([SessionError, DeviceError, SpeechError])
export type AlexaError = typeof AlexaError.Type
