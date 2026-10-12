import { Schema } from "effect"

export class GrokBotError extends Schema.TaggedError<GrokBotError>()("GrokBotError", {
  message: Schema.String
}) {}
