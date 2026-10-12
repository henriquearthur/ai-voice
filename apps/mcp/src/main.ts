#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Console, Effect, Layer, Logger, Runtime, Schema } from "effect"
import { Command } from "effect/cli"
import * as Telemetry from "@jarvis/telemetry"
import { cli } from "./cli.ts"
import { version } from "./server.ts"
import { SpeakError } from "./speaker.ts"

const isSpeakError = Schema.is(SpeakError)

const reportFailure = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return Effect.void
  const error = Cause.squash(cause)
  // Alexa and Mac voice errors carry messages that are safe and actionable on their own.
  if (isSpeakError(error)) return Console.error(error.message)
  // The CLI already rendered its own help or usage errors.
  if (!Runtime.getErrorReported(error)) return Effect.void
  return Effect.logError(cause)
}

Effect.sync(() => process.umask(0o077)).pipe(
  Effect.andThen(Command.run(cli, { version })),
  Effect.tapCause(reportFailure),
  // stdout is the MCP channel: every log line must go to stderr.
  Effect.provide(Layer.mergeAll(
    BunServices.layer,
    Layer.succeed(Logger.LogToStderr, true),
    Telemetry.layer({ serviceName: "jarvis-mcp", serviceVersion: version })
  )),
  BunRuntime.runMain({
    disableErrorReporting: true,
    // The stdio transport interrupts the program when the client closes stdin; like a signal, that is a clean stop.
    teardown: (exit, onExit) => Runtime.defaultTeardown(exit, (code) => onExit(code === 130 ? 0 : code))
  })
)
