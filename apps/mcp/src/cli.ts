import { Alexa, AlexaConfig, login } from "@jarvis/alexa"
import { AnnounceConfig, Announcer } from "@jarvis/announce"
import { Config, Console, Effect, Layer, Option, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { FetchHttpClient } from "effect/http"
import { announce } from "./announce.ts"
import { HttpTransport } from "./http-transport.ts"
import { SpeechLive } from "./speaker.ts"
import { StdioTransport } from "./server.ts"
import { EchoDevice } from "./voice-toolkit.ts"

const AlexaLive = Alexa.layer.pipe(
  Layer.provideMerge(AlexaConfig.layer),
  Layer.provide(FetchHttpClient.layer)
)

const HttpOptions = Config.all({
  port: Config.option(Config.Port("AI_VOICE_HTTP_PORT")),
  hostname: Config.String("AI_VOICE_HTTP_HOST").pipe(Config.withDefault("127.0.0.1"))
})

const serve = Effect.gen(function*() {
  const { hostname, port } = yield* HttpOptions
  return yield* Option.match(port, {
    onNone: () => Layer.launch(StdioTransport),
    onSome: (port) => Layer.launch(HttpTransport({ hostname, port }))
  })
})

const loginCommand = Command.make("login", {}, () => login).pipe(
  Command.withDescription("Sign in to Amazon through a local proxy at http://127.0.0.1:3456/ (no audio)."),
  Command.provide(AlexaConfig.layer)
)

const encodeDevices = Schema.encodeEffect(Schema.Array(EchoDevice))

const devicesCommand = Command.make("devices", {}, () =>
  Alexa.use((alexa) => alexa.devices).pipe(
    Effect.flatMap(encodeDevices),
    // stdout carries only the JSON so it can be piped; diagnostics go to stderr.
    Effect.flatMap((devices) => Console.log(JSON.stringify(devices, null, 2)))
  )).pipe(
    Command.withDescription("Print the Echo devices on the Amazon account as JSON, without playing audio."),
    Command.provide(AlexaLive)
  )

const announceCommand = Command.make("announce", {
  body: Flag.String("body").pipe(Flag.withDescription("Text to announce; defaults to the hook message on stdin."), Flag.optional),
  title: Flag.String("title").pipe(Flag.withDescription("Notification title."), Flag.optional),
  event: Flag.String("event").pipe(
    Flag.withDescription("permission, waiting, finished or error; defaults to the hook event."),
    Flag.optional
  ),
  project: Flag.String("project").pipe(Flag.withDescription("Project name; defaults to the hook cwd."), Flag.optional),
  source: Flag.String("source").pipe(Flag.withDescription("Who is announcing."), Flag.withDefault("claude-code"))
}, announce).pipe(
  Command.withDescription(
    "Speak a short pt-BR notification from flags or a Claude Code hook JSON on stdin; skips are logged to stderr."
  ),
  Command.provide(Announcer.layer.pipe(Layer.provide(AnnounceConfig.layer))),
  Command.provide(SpeechLive)
)

/**
 * `jarvis-voice` serves MCP (stdio, or HTTP when `AI_VOICE_HTTP_PORT` is set);
 * `login` and `devices` manage the local Amazon session; `announce` speaks hook notifications
 * on the output chosen by `AI_VOICE_OUTPUT`.
 */
export const cli = Command.make("jarvis-voice", {}, () => serve).pipe(
  Command.withDescription("MCP server that lets AI agents speak on this Mac (AI_VOICE_OUTPUT=mac) or an Amazon Echo."),
  Command.provide(SpeechLive),
  Command.withSubcommands([loginCommand, devicesCommand, announceCommand])
)
