import { AlexaConfig } from "@jarvis/alexa"
import { Config, Console, Effect, Layer, Option } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import pkg from "../package.json" with { type: "json" }
import { layer as AppleTools } from "./apple-toolkit.ts"
import { layer as GrokBotTools } from "./grokbot-toolkit.ts"
import { layer as HerdrTools } from "./herdr-toolkit.ts"
import { layer as QuadroTools } from "./quadro-toolkit.ts"
import { Speaker, type SpeechOutput } from "./speaker.ts"
import { makeVoiceToolkit, voiceHandlers } from "./voice-toolkit.ts"

export const name = "Jarvis Voice"

export const { version } = pkg

// Newest first: an initialize offering an unknown version falls back to the first stateful adapter.
export const protocols = [
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05
] as const

export const instructions = (locale: string, output: SpeechOutput) =>
  `Use speak when the user asks for a spoken reply. Prefer short messages in the language of locale ${locale}. ` +
  "Listing devices plays no sound. Do not send unprompted test speech and do not repeat speech after an error or timeout. " +
  (output === "mac"
    ? "speak plays on this Mac and succeeds only after playback ends. With device_serial it goes to that Echo, " +
      "where success means the Alexa API accepted the request, not that the user heard it."
    : "speak plays on an Echo; success means the Alexa API accepted the request, not that the user heard it.")

const speechSettings = Effect.all({
  locale: AlexaConfig.useSync(({ locale }) => locale),
  output: Speaker.useSync(({ output }) => output)
})

/**
 * The MCP server identity, with instructions for the configured speech locale and output.
 */
export const serverOptions = Effect.map(speechSettings, ({ locale, output }) => ({
  name,
  version,
  instructions: instructions(locale, output),
  protocols
}))

/**
 * Registers the voice toolkit on whichever `McpServer` transport is provided.
 */
export const VoiceTools = Layer.unwrap(Effect.map(speechSettings, ({ locale, output }) => {
  const toolkit = makeVoiceToolkit(locale, output)
  return McpServer.toolkit(toolkit).pipe(Layer.provide(voiceHandlers(toolkit)))
}))

// Empty values count as unset, so a client config with blank placeholders behaves like one without them.
const GrokBotConfigured = Config.all([
  Config.option(Config.String("GROKBOT_WEBHOOK_URL")),
  Config.option(Config.String("GROKBOT_KEY"))
]).pipe(Config.map(([url, key]) => Option.isSome(url) && Option.isSome(key)))

/**
 * Registers `grokbot_send` only when `GROKBOT_WEBHOOK_URL` and `GROKBOT_KEY`
 * are both set. Without them, or with an invalid value, the server starts with
 * the other tools: a Grok Bot setting must never take voice down.
 */
export const OptionalGrokBotTools = Layer.unwrap(Effect.map(GrokBotConfigured, (configured) =>
  configured
    ? GrokBotTools.pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.catchTag("ConfigError", (error) =>
        Layer.effectDiscard(Console.error(`grokbot_send disabled: invalid Grok Bot configuration. ${error.message}`)))
    )
    : Layer.empty
))

/**
 * Board and hive tools; if the board cannot open, the server starts without them.
 */
export const OptionalQuadroTools = QuadroTools.pipe(
  Layer.catchTag("QuadroError", (error) =>
    Layer.effectDiscard(Console.error(`quadro tools disabled: ${error.message}`)))
)

/**
 * Serves MCP over stdin/stdout, the default transport for agents that spawn the server.
 *
 * Only stdio carries the Apple tools (reminders, calendar, maps, phone_call), the herdr tools and
 * the optional `grokbot_send`: the client that spawned the process already runs
 * as the user on this Mac. The HTTP transport has no authentication, so it stays
 * voice-only.
 */
export const StdioTransport = Layer.unwrap(Effect.map(serverOptions, (options) =>
  Layer.mergeAll(VoiceTools, AppleTools, HerdrTools, OptionalQuadroTools, OptionalGrokBotTools).pipe(Layer.provide(McpServer.layerStdio(options)))
))
