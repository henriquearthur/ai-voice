#!/usr/bin/env bun
/**
 * Coletor de telemetria do Jarvis (LaunchAgent dev.jarvis.coletor).
 *
 * - segue escuta.events.jsonl e transforma cada evento em métrica;
 * - a cada 5 s lê o herdr (agentes, estados, RAM/CPU) e os LaunchAgents dev.jarvis.*;
 * - exporta por OTLP/HTTP para 127.0.0.1:4318 como service.name=jarvis-coletor;
 * - serve o último retrato em GET 127.0.0.1:7352/estado e por SSE em /estado/ao-vivo.
 */
import { BunRuntime } from "@effect/platform-bun"
import { Cause, Effect, Layer, Logger, Schedule } from "effect"
import { coletarHerdr, coletarServicos, ColetorConfig, lerProcessos } from "./coleta.ts"
import { parseLinha, ResumoEscuta } from "./escuta.ts"
import { herdrFora, Rastreador, type EstadoHerdr } from "./herdr.ts"
import { LeitorSubagentes } from "./subagentes.ts"
import { publicarHerdr, registrarEscuta } from "./metricas.ts"
import { RelogioExecucoes, type Servico } from "./servicos.ts"
import { type Retrato, Vitrine } from "./estado.ts"
import { criarServidor } from "./servidor.ts"
import { Seguidor, ultimasLinhas } from "./tail.ts"
import { TelemetriaConfig, telemetria } from "./telemetria.ts"

const main = Effect.gen(function*() {
  const config = yield* ColetorConfig
  const { url: otlp } = yield* TelemetriaConfig
  const desde = new Date().toISOString()
  const vitrine = new Vitrine()
  const resumo = new ResumoEscuta(config.eventos)
  const rastreador = new Rastreador()
  const subagentes = new LeitorSubagentes({ claudeDir: config.claudeDir })
  let herdr: EstadoHerdr = herdrFora("primeira coleta")
  let servicos: ReadonlyArray<Servico> = []
  const relogio = new RelogioExecucoes()

  const montar = (): Retrato => ({
    gerado_em: new Date().toISOString(),
    coletor: { pid: process.pid, desde, intervalo_s: config.intervaloMs / 1000, otlp },
    escuta: resumo.estado(),
    herdr,
    servicos
  })

  // Histórico recente só preenche o /estado; métricas contam do que chega depois.
  for (const linha of ultimasLinhas(config.eventos)) {
    const evento = parseLinha(linha)
    if (evento) resumo.semear(evento)
  }
  const seguidor = new Seguidor(config.eventos, { doFim: true })

  const lerEscuta = Effect.gen(function*() {
    let novos = 0
    for (const linha of seguidor.ler()) {
      const evento = parseLinha(linha)
      if (!evento) continue
      resumo.aplicar(evento)
      yield* registrarEscuta(evento)
      novos++
    }
    if (novos > 0 && vitrine.ultimo()) vitrine.publicar(montar())
  }).pipe(Effect.catchCause((c) => Effect.logWarning("falha lendo a Escuta", Cause.squash(c))))

  const coletar = Effect.gen(function*() {
    const tabela = yield* lerProcessos
    const [h, s] = yield* Effect.all([
      coletarHerdr(config.herdr, tabela, rastreador, subagentes),
      config.servicos ? coletarServicos(config.launchAgents, tabela, relogio) : Effect.succeed([])
    ], { concurrency: 2 })
    herdr = h
    servicos = s
    yield* publicarHerdr(h)
    vitrine.publicar(montar())
  }).pipe(Effect.catchCause((c) => Effect.logWarning("falha na coleta", Cause.squash(c))))

  yield* Effect.acquireRelease(
    Effect.sync(() => criarServidor(vitrine, { porta: config.porta })),
    (servidor) => Effect.promise(() => servidor.stop(true))
  )
  yield* Effect.logInfo(`coletor em http://127.0.0.1:${config.porta}/estado, OTLP em ${otlp}`)

  yield* lerEscuta.pipe(Effect.repeat(Schedule.spaced("1 second")), Effect.forkScoped)
  yield* coletar.pipe(Effect.repeat(Schedule.spaced(`${config.intervaloMs} millis`)), Effect.forkScoped)
  return yield* Effect.never
})

main.pipe(
  Effect.scoped,
  Effect.provide(telemetria({ serviceName: "jarvis-coletor", serviceVersion: "0.1.0" })),
  Effect.tapCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(Cause.squash(cause))),
  Effect.provide(Layer.succeed(Logger.LogToStderr, true)),
  BunRuntime.runMain({ disableErrorReporting: true })
)
