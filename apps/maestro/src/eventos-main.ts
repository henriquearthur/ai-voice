#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Console, Effect, Layer, Logger, Schema } from "effect"
import { Command, Flag } from "effect/cli"
import { MaestroConfig, paths } from "./config.ts"
import { entregador } from "./entrega.ts"
import { Fila } from "./fila.ts"
import { Herdr } from "./herdr.ts"
import { agendador } from "./rotinas.ts"
import { EventosTransport, eventoUrl, loadToken, TokenError } from "./servidor.ts"

const printUrl = Flag.Boolean("print-url").pipe(
  Flag.withDescription("Mostra a URL local de eventos, com o token, e sai."),
  Flag.withDefault(false)
)

const cli = Command.make("jarvis-eventos", { printUrl }, ({ printUrl }) =>
  Effect.gen(function*() {
    const config = yield* MaestroConfig
    const p = paths(config.dir)
    const token = yield* loadToken(p.token)
    if (printUrl) return yield* Console.log(eventoUrl(config.port, token))
    const servicos = Layer.mergeAll(Fila.layer(p.fila), Herdr.layer(config.herdr))
    yield* Effect.all([
      Layer.launch(EventosTransport({ port: config.port, token })),
      entregador({ name: config.name, fala: config.fala }),
      agendador({ arquivo: p.rotinas, estado: p.rotinasEstado })
    ], { concurrency: "unbounded" }).pipe(Effect.provide(servicos))
  })).pipe(
    Command.withDescription(
      "Fila de eventos do maestro: recebe POST /evento/<token> em 127.0.0.1, dispara rotinas por horário " +
        "e entrega tudo ao agente do herdr quando ele estiver idle ou done."
    )
  )

const isSafeError = Schema.is(TokenError)

Effect.sync(() => process.umask(0o077)).pipe(
  Effect.andThen(Command.run(cli, { version: "0.1.0" })),
  Effect.tapCause((cause) => {
    if (Cause.hasInterruptsOnly(cause)) return Effect.void
    const error = Cause.squash(cause)
    return isSafeError(error) ? Console.error(error.message) : Effect.logError(cause)
  }),
  Effect.provide(Layer.mergeAll(BunServices.layer, Layer.succeed(Logger.LogToStderr, true))),
  BunRuntime.runMain({ disableErrorReporting: true })
)
