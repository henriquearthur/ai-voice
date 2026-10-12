#!/usr/bin/env bun
/**
 * Faxina (LaunchAgent periódico dev.jarvis.faxina): uma passada por execução.
 *
 *   bun src/main.ts            passada ativa (mata só o lixo conhecido da config)
 *   bun src/main.ts --seco     só relata o que faria; não mata, não grava estado, não avisa o maestro
 *
 * Zumbis e descontrolados só geram alerta. Estado em ~/.local/share/jarvis/faxina/estado.json.
 */
import { BunRuntime } from "@effect/platform-bun"
import * as Telemetry from "@jarvis/telemetry"
import { Cause, Effect, Layer, Logger } from "effect"
import { aindaVivo, enviarEvento, lerAmbiente, lerPs, sinalizar } from "./acoes.ts"
import { lerConfig, PASTA } from "./config.ts"
import { estadoVazio, filtrarCrescimento, filtrarNovos, gravarEstado, lerEstado, registrarAcao } from "./estado.ts"
import { publicar } from "./metricas.ts"
import { type Alerta, avaliar } from "./regras.ts"

const seco = process.argv.includes("--seco") || process.env.JARVIS_FAXINA_SECO === "1"
const ESTADO = process.env.JARVIS_FAXINA_ESTADO ?? `${PASTA}/estado.json`

const passada = Effect.gen(function*() {
  const config = lerConfig()
  const procs = yield* Effect.tryPromise(lerPs)
  const estado = seco ? estadoVazio() : lerEstado(ESTADO)
  const agora = Date.now()
  const r = avaliar(procs, { config, uid: process.getuid?.() ?? 0, meuPid: process.pid, cpuAnterior: seco ? {} : estado.cpu, ambiente: lerAmbiente })

  if (seco) {
    // Em modo seco não há passadas anteriores: só o que não depende delas aparece.
    console.log(JSON.stringify({
      seco: true,
      mataria: r.matar.map((a) => ({ pid: a.proc.pid, padrao: a.padrao, motivo: a.motivo, comando: a.proc.comando.slice(0, 160) })),
      poupados: r.poupados.map((a) => ({ pid: a.proc.pid, padrao: a.padrao, motivo: a.motivo, comando: a.proc.comando.slice(0, 160) })),
      zumbis: r.zumbis,
      alertas_imediatos: r.alertas.map((a) => ({ tipo: a.tipo, conhecido: a.conhecido, detalhe: a.detalhe })),
      cpu_acima_do_limite_agora: Object.keys(r.cpuVisto).length
    }, null, 2))
    return
  }

  // Lixo: SIGTERM em todos, 5 s de espera, SIGKILL nos que ficaram.
  const mortos: typeof estado.ultima.mortos = []
  const termo = yield* Effect.promise(() => Promise.all(r.matar.map((a) => sinalizar(a.proc, "SIGTERM"))))
  const enviados = r.matar.filter((_, i) => termo[i] === "enviado")
  if (enviados.length > 0) yield* Effect.sleep(`${config.limites.esperaSigkillS} seconds`)
  for (const [i, a] of r.matar.entries()) {
    let sinal = "SIGTERM"
    let resultado: string = termo[i]!
    if (termo[i] === "enviado" && (yield* Effect.promise(() => aindaVivo(a.proc)))) {
      sinal = "SIGKILL"
      resultado = yield* Effect.promise(() => sinalizar(a.proc, "SIGKILL"))
    }
    registrarAcao(PASTA, { acao: "matar", pid: a.proc.pid, padrao: a.padrao, motivo: a.motivo, sinal, resultado, comando: a.proc.comando.slice(0, 300) })
    yield* Effect.logInfo(`matar pid ${a.proc.pid} [${a.padrao}] ${a.motivo}: ${sinal} ${resultado}`)
    if (termo[i] === "enviado") {
      mortos.push({ pid: a.proc.pid, padrao: a.padrao, motivo: a.motivo, comando: a.proc.comando.slice(0, 200) })
      estado.totais.mortos[a.padrao] = (estado.totais.mortos[a.padrao] ?? 0) + 1
    }
  }

  // Alertas com dedupe de 30 min; cada um novo vira evento ao maestro.
  const porCrescimento = (a: Alerta): a is Alerta & { item: string; rssBytes: number } => a.item !== undefined && a.rssBytes !== undefined
  const conhecidos = r.alertas.filter(porCrescimento)
  const cresc = filtrarCrescimento(conhecidos, estado.memoria, config.limites.crescimentoMemoria)
  const { novos: novosTempo, enviados: dedupe } = filtrarNovos(r.alertas.filter((a) => !porCrescimento(a)), estado.alertas, agora, config.limites.dedupeMin)
  const novos: Array<Alerta> = [...novosTempo, ...cresc.novos]
  for (const a of novos) {
    const texto = `[faxina] ${a.detalhe}${a.conhecido ? " (processo conhecido, só aviso: a faxina não mata)" : ""}`
    const via = yield* Effect.promise(() => enviarEvento(texto))
    registrarAcao(PASTA, { acao: "alerta", tipo: a.tipo, pid: a.proc.pid, detalhe: a.detalhe, maestro: via })
    yield* Effect.logWarning(`alerta ${a.tipo}: ${a.detalhe} (maestro: ${via})`)
    estado.totais.alertas[a.tipo] = (estado.totais.alertas[a.tipo] ?? 0) + 1
  }
  for (const z of r.zumbis) {
    if (!novos.some((a) => a.chave === `zumbi:${z.pid}`)) continue
    registrarAcao(PASTA, { acao: "zumbi", pid: z.pid, ppid: z.ppid, comando: z.comando, pai: z.paiComando })
  }

  const novoEstado = {
    ...estado,
    atualizado_em: new Date(agora).toISOString(),
    passadas: estado.passadas + 1,
    zumbis: [...r.zumbis],
    cpu: r.cpuVisto,
    alertas: dedupe,
    memoria: cresc.memoria,
    ultima: {
      mortos,
      poupados: r.poupados.map((a) => ({ pid: a.proc.pid, padrao: a.padrao, motivo: a.motivo })),
      alertas: r.alertas.map((a) => ({ tipo: a.tipo, detalhe: a.detalhe, novo: novos.includes(a) }))
    }
  }
  gravarEstado(ESTADO, novoEstado)
  yield* publicar(novoEstado.totais, r.zumbis.length)
  yield* Effect.logInfo(
    `passada ${novoEstado.passadas}: ${procs.length} processos, ${mortos.length} mortos, ${r.poupados.length} poupados, ${r.zumbis.length} zumbis, ${novos.length} alertas novos`
  )
})

passada.pipe(
  Effect.timeout("2 minutes"),
  Effect.tapCause((c) => Cause.hasInterruptsOnly(c) ? Effect.void : Effect.logError("falha na passada", Cause.squash(c))),
  Effect.provide(seco
    ? Layer.empty
    : Telemetry.layer({ serviceName: "jarvis-faxina", serviceVersion: "0.1.0", attributes: { "service.instance.id": "faxina" } })),
  Effect.provide(Layer.succeed(Logger.LogToStderr, true)),
  BunRuntime.runMain({ disableErrorReporting: true })
)
