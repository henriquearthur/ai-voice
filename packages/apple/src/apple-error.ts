import { Schema } from "effect"

export class AutomationError extends Schema.TaggedError<AutomationError>()("AutomationError", {
  message: Schema.String
}) {}
