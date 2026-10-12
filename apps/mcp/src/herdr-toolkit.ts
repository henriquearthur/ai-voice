import { observeTools } from "@jarvis/telemetry"
import { Effect, Layer, Schema } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"
import { AgentInfo, DEFAULT_LINES, Herdr, HerdrError, KeyAction, MAX_LINES, MAX_TEXT_LENGTH } from "./herdr.ts"

const agentParam = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)).annotate({
  description: "Agent name or pane id (e.g. \"telemetria\" or \"w1:p3\"); must be a live herdr agent."
})

const HerdrAgents = Tool.make("herdr_agents", {
  description: "Lists the live herdr agents: name, pane, kind, state (idle, working, blocked, done, unknown) " +
    "and whether the agent is blocked on a permission or question prompt.",
  success: Schema.Array(AgentInfo),
  failure: HerdrError
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

const HerdrRead = Tool.make("herdr_read", {
  description: "Reads the tail of an agent's terminal.",
  parameters: Schema.Struct({
    agent: agentParam,
    lines: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LINES })).annotate({
        description: `How many lines from the end; defaults to ${DEFAULT_LINES}, at most ${MAX_LINES}.`
      })
    )
  }),
  success: Schema.String,
  failure: HerdrError
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false)

const HerdrSend = Tool.make("herdr_send", {
  description: "Types text into an agent's terminal and submits it. With steer=true (default) it sends ctrl+enter, " +
    "which steers an agent that is mid-turn; with steer=false it sends plain enter. " +
    "Never resend after an error: the text may already have been delivered.",
  parameters: Schema.Struct({
    agent: agentParam,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TEXT_LENGTH)).annotate({
      description: `Text to send, up to ${MAX_TEXT_LENGTH} characters.`
    }),
    steer: Schema.optionalKey(Schema.Boolean.annotate({ description: "ctrl+enter when true (default), enter when false." }))
  }),
  success: Schema.Struct({ agent: Schema.String, pane: Schema.String, sent: Schema.Boolean }),
  failure: HerdrError
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)

const HerdrKey = Tool.make("herdr_key", {
  description: "Presses one whitelisted key on an agent: approve (enter), deny (escape), cycle_mode (shift+tab), " +
    "interrupt (ctrl+c). approve and cycle_mode are refused on the caller's own pane, so an agent cannot approve " +
    "its own permission request; approving another agent is allowed. Read the agent's terminal first.",
  parameters: Schema.Struct({
    agent: agentParam,
    key: KeyAction.annotate({ description: "approve, deny, cycle_mode or interrupt." })
  }),
  success: Schema.Struct({ agent: Schema.String, pane: Schema.String, key: KeyAction }),
  failure: HerdrError
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)

export const HerdrToolkit = Toolkit.make(HerdrAgents, HerdrRead, HerdrSend, HerdrKey)

/**
 * Binds the herdr tools to the `Herdr` service.
 */
export const HerdrToolkitHandlers = HerdrToolkit.toLayer(Effect.gen(function*() {
  const herdr = yield* Herdr
  return HerdrToolkit.of(observeTools("mcp", {
    herdr_agents: () => herdr.agents,
    herdr_read: (input) => herdr.read(input),
    herdr_send: (input) => herdr.send(input),
    herdr_key: (input) => herdr.key(input)
  }))
}))

/**
 * Registers the herdr tools on whichever `McpServer` transport is provided.
 */
export const HerdrToolkitLayer = McpServer.toolkit(HerdrToolkit).pipe(Layer.provide(HerdrToolkitHandlers))

/**
 * `HerdrToolkitLayer` backed by the real `herdr` binary.
 */
export const layer = HerdrToolkitLayer.pipe(Layer.provide(Herdr.layer))
