import { observeTools } from "@jarvis/telemetry"
import { GrokBot, GrokBotDispatch, GrokBotError, MAX_CONTEXT_LENGTH, MAX_TASK_LENGTH } from "@jarvis/grokbot"
import { Effect, Layer, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"

const GrokBotSend = Tool.make("grokbot_send", {
  description: "Dispatches a task to the user's Grok Bot routine and returns as soon as it has started. " +
    "The routine's result is not returned by this tool. " +
    "Never resend the same task after an error or timeout: the outcome is uncertain and it may already be running.",
  parameters: Schema.Struct({
    task: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TASK_LENGTH)).annotate({
      description: `What the routine should do, in plain language; up to ${MAX_TASK_LENGTH} characters.`
    }),
    context: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(MAX_CONTEXT_LENGTH)).annotate({
        description: `Background the routine needs, up to ${MAX_CONTEXT_LENGTH} characters.`
      })
    )
  }),
  success: GrokBotDispatch.pipe(Schema.encodeKeys({ requestId: "request_id" })),
  failure: GrokBotError
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)

export const GrokBotToolkit = Toolkit.make(GrokBotSend)

/**
 * Binds the Grok Bot tool to the `GrokBot` service.
 */
export const GrokBotToolkitHandlers = GrokBotToolkit.toLayer(Effect.gen(function*() {
  const grokbot = yield* GrokBot
  return GrokBotToolkit.of(observeTools("mcp", {
    grokbot_send: (input) => grokbot.send(input)
  }))
}))

/**
 * Registers the Grok Bot tool on whichever `McpServer` transport is provided.
 */
export const GrokBotToolkitLayer = McpServer.toolkit(GrokBotToolkit).pipe(Layer.provide(GrokBotToolkitHandlers))

/**
 * `GrokBotToolkitLayer` backed by the real webhook client, configured from
 * `GROKBOT_WEBHOOK_URL` and `GROKBOT_KEY`.
 */
export const layer = GrokBotToolkitLayer.pipe(Layer.provide(GrokBot.layer))
