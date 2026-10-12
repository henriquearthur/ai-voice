import { Schema } from "effect"

/** Speech on the Mac was refused, timed out or failed. The message is safe to show to the caller. */
export class MacVoiceError extends Schema.TaggedError<MacVoiceError>()("MacVoiceError", {
  message: Schema.String
}) {}
