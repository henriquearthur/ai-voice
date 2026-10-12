#!/usr/bin/env bun
/**
 * Vigia dos agentes do herdr (LaunchAgent dev.jarvis.maestro, StartInterval 60):
 * uma passada por execução sobre o maestro e os especialistas de agentes.json.
 * Quem sumiu é recriado no pane salvo (ou ao lado) e retoma a própria sessão.
 */
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Cause, Effect, Layer, Logger, Option } from "effect"
import { MaestroConfig } from "./config.ts"
import { Herdr } from "./herdr.ts"
import { retomarRecriados } from "./retomada.ts"
import { vigiar } from "./vigia.ts"

const main = Effect.gen(function*() {
  const config = yield* MaestroConfig
  const resultados = yield* vigiar(config).pipe(Effect.provide(Herdr.layer(config.herdr)))
  for (const resultado of resultados) {
    if (resultado._tag === "Recriado") {
      const sessao = Option.match(resultado.retomou, { onNone: () => "sessão nova", onSome: (id) => `retomou ${id}` })
      yield* Effect.logInfo(`Agente ${resultado.nome} recriado no pane ${resultado.pane} (${sessao}).`)
    } else if (resultado._tag === "Falhou") {
      yield* Effect.logWarning(`Agente ${resultado.nome} não subiu: ${resultado.erro}`)
    }
  }
  // O --resume só reabre a conversa: sem este prompt o agente fica idle para sempre.
  yield* retomarRecriados(config, resultados).pipe(Effect.provide(Herdr.layer(config.herdr)))
})

Effect.sync(() => process.umask(0o077)).pipe(
  Effect.andThen(main),
  Effect.tapCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(Cause.squash(cause))),
  Effect.provide(Layer.mergeAll(BunServices.layer, Layer.succeed(Logger.LogToStderr, true))),
  BunRuntime.runMain({ disableErrorReporting: true })
)
