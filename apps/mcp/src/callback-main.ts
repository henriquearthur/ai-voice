#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { AlexaConfig } from "@jarvis/alexa"
import { GrokBotOutbox } from "@jarvis/grokbot"
import * as Telemetry from "@jarvis/telemetry"
import { Cause, Console, Effect, Layer, Logger, Runtime, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { CallbackConfig, CallbackTokenError, CallbackTransport, callbackUrl, loadCallbackToken } from "./callback-server.ts"
import { version } from "./server.ts"
import { SpeechLive } from "./speaker.ts"

// One Speaker for every session, so its speech locks serialize all notices.
const Services = Layer.unwrap(AlexaConfig.useSync(({ stateDir }) => GrokBotOutbox.layerAt(stateDir))).pipe(
  Layer.provideMerge(SpeechLive)
)

const printUrl = Flag.Boolean("print-url").pipe(
  Flag.withDescription("Print the local callback URL, token included, once to stdout and exit."),
  Flag.withDefault(false)
)

const cli = Command.make("jarvis-callback", { printUrl }, ({ printUrl }) =>
  Effect.gen(function*() {
    const { port } = yield* CallbackConfig
    const token = yield* AlexaConfig.use(({ stateDir }) => loadCallbackToken(stateDir))
    if (printUrl) return yield* Console.log(callbackUrl(port, token))
    return yield* Layer.launch(CallbackTransport({ port, token }))
  })).pipe(
    Command.withDescription(
      "Serves grokbot_deliver, notify_fernando and speak_fernando on http://127.0.0.1:<port>/mcp/<token> for the Grok Bot connector."
    ),
    Command.provide(Services)
  )

const isSafeError = Schema.is(CallbackTokenError)

const reportFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  const error = Cause.squash(cause)
  if (isSafeError(error)) return Console.error(error.message)
  if (!Runtime.getErrorReported(error)) return Effect.void
  return Effect.logError(cause)
}

Effect.sync(() => process.umask(0o077)).pipe(
  Effect.andThen(Command.run(cli, { version })),
  Effect.tapCause(reportFailure),
  // stdout carries only the --print-url output.
  Effect.provide(Layer.mergeAll(
    BunServices.layer,
    Layer.succeed(Logger.LogToStderr, true),
    Telemetry.layer({ serviceName: "jarvis-callback", serviceVersion: version })
  )),
  BunRuntime.runMain({ disableErrorReporting: true })
)
