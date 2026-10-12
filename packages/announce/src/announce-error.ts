import { Schema } from "effect"

export class AnnounceConfigError extends Schema.TaggedError<AnnounceConfigError>()("AnnounceConfigError", {
  message: Schema.String
}) {}
