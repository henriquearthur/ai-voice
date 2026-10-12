import { Effect, Metric } from "effect"
import { booleano, type EventoEscuta, numero, texto } from "./escuta.ts"
import type { EstadoHerdr } from "./herdr.ts"

/**
 * Métricas exportadas por OTLP. O Prometheus do backend usa o nome exato do
 * código: contadores já terminam em `_total`, histogramas ganham
 * `_bucket/_sum/_count` e gauges ficam com o nome puro. Atributo nunca vai
 * vazio (some no backend) e nunca leva texto falado.
 */

const MS = [25, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 7500, 10000, 15000, 30000, 60000]
const KILL_MS = [10, 25, 50, 100, 150, 200, 250, 300, 400, 500, 750, 1000, 2000, 5000]
const CONFIANCA = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1]
const FIM_FALA_MS = [50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000, 7500, 10000]
const SEGUNDOS = [0.5, 1, 2, 3, 5, 8, 13, 20, 30, 60]

// Escuta
export const entregaMs = Metric.histogram("jarvis_escuta_entrega_ms", {
  description: "Do fim da fala até o pedido entregue (latency_ms do routed), em ms.",
  boundaries: MS
})
export const latenciaFimFalaMs = Metric.histogram("jarvis_escuta_latencia_fim_fala_ms", {
  description: "Espera entre o fim da fala e o pedido chegar ao destino (latency_ms dos routed com ok), em ms, por destino (who).",
  boundaries: FIM_FALA_MS
})
export const roteamentoMs = Metric.histogram("jarvis_escuta_roteamento_ms", {
  description: "Tempo do envio ao destino (ms do routed), em ms.",
  boundaries: MS
})
export const pedidos = Metric.counter("jarvis_escuta_pedidos_total", {
  description: "Pedidos roteados pela Escuta, por ok e destino (who).",
  incremental: true
})
export const interrupcoes = Metric.counter("jarvis_escuta_interrupcoes_total", {
  description: "Interrupções (barge_in) da fala do Jarvis, por gatilho (fala ou palavra).",
  incremental: true
})
export const interrupcaoKillMs = Metric.histogram("jarvis_escuta_interrupcao_kill_ms", {
  description: "Tempo para cortar a fala do Jarvis numa interrupção, em ms.",
  boundaries: KILL_MS
})
export const reinicios = Metric.counter("jarvis_escuta_reinicios_total", {
  description: "Reinícios do reconhecimento (origem=reconhecedor) e da Escuta (origem=escuta), por motivo.",
  incremental: true
})
export const ouvidos = Metric.counter("jarvis_escuta_ouvidos_total", {
  description: "Frases ouvidas, por wake, enviada (false = descartada) e durante_fala.",
  incremental: true
})
export const descartadas = Metric.counter("jarvis_escuta_descartadas_total", {
  description: "Frases ouvidas que não viraram pedido (ruído, fracas ou só 'para').",
  incremental: true
})
export const confianca = Metric.histogram("jarvis_escuta_confianca", {
  description: "Confiança média do reconhecimento por frase ouvida (0 a 1), por enviada.",
  boundaries: CONFIANCA
})
export const falaSegundos = Metric.histogram("jarvis_escuta_fala_segundos", {
  description: "Duração de cada frase ouvida, em segundos.",
  boundaries: SEGUNDOS
})
export const erros = Metric.counter("jarvis_escuta_erros_total", {
  description: "Eventos de erro da Escuta.",
  incremental: true
})

const bool = (valor: unknown) => booleano(valor) ? "true" : "false"

/** Atualiza as métricas de um evento da Escuta. Eventos sem métrica não fazem nada. */
export const registrarEscuta = (evento: EventoEscuta): Effect.Effect<void> => {
  switch (evento.type) {
    case "routed": {
      const atributos = { ok: bool(evento.ok), who: texto(evento.who, "desconhecido") }
      const latencia = numero(evento.latency_ms)
      const ms = numero(evento.ms)
      return Effect.all([
        Metric.update(Metric.withAttributes(pedidos, atributos), 1),
        latencia === undefined ? Effect.void : Metric.update(Metric.withAttributes(entregaMs, atributos), latencia),
        latencia === undefined || !booleano(evento.ok)
          ? Effect.void
          : Metric.update(Metric.withAttributes(latenciaFimFalaMs, { who: atributos.who }), latencia),
        ms === undefined ? Effect.void : Metric.update(Metric.withAttributes(roteamentoMs, atributos), ms)
      ], { discard: true })
    }
    case "barge_in": {
      const gatilho = typeof evento.word === "string" && evento.word !== "" ? "palavra" : "fala"
      const kill = numero(evento.kill_ms)
      return Effect.all([
        Metric.update(Metric.withAttributes(interrupcoes, { gatilho }), 1),
        kill === undefined ? Effect.void : Metric.update(Metric.withAttributes(interrupcaoKillMs, { gatilho }), kill)
      ], { discard: true })
    }
    case "recognizer":
      return Metric.update(
        Metric.withAttributes(reinicios, { reason: texto(evento.reason, "desconhecido"), origem: "reconhecedor" }),
        1
      )
    case "restart":
      return Metric.update(
        Metric.withAttributes(reinicios, { reason: texto(evento.reason, "desconhecido"), origem: "escuta" }),
        1
      )
    case "heard": {
      const enviada = bool(evento.sent)
      const conf = numero(evento.confidence)
      const segundos = numero(evento.seconds)
      return Effect.all([
        Metric.update(
          Metric.withAttributes(ouvidos, { wake: bool(evento.wake), enviada, durante_fala: bool(evento.during_speech) }),
          1
        ),
        enviada === "false" ? Metric.update(descartadas, 1) : Effect.void,
        conf === undefined || conf < 0 ? Effect.void : Metric.update(Metric.withAttributes(confianca, { enviada }), conf),
        segundos === undefined ? Effect.void : Metric.update(falaSegundos, segundos)
      ], { discard: true })
    }
    case "error":
      return Metric.update(erros, 1)
    default:
      return Effect.void
  }
}

// herdr
export const herdrVivo = Metric.gauge("jarvis_herdr_vivo", { description: "1 se o servidor do herdr responde." })
export const herdrInfo = Metric.gauge("jarvis_herdr_info", { description: "Sempre 1, com a versão do herdr." })
export const herdrWorkspaces = Metric.gauge("jarvis_herdr_workspaces", { description: "Workspaces abertos no herdr." })
export const herdrPanes = Metric.gauge("jarvis_herdr_panes", { description: "Panes abertos no herdr." })
export const agenteEstado = Metric.gauge("jarvis_herdr_agente_estado", {
  description: "1 no estado atual do agente (idle, working, blocked, done, unknown)."
})
export const agenteNoEstado = Metric.gauge("jarvis_herdr_agente_no_estado_segundos", {
  description: "Segundos desde que o agente entrou no estado atual."
})
export const agenteRss = Metric.gauge("jarvis_herdr_agente_rss_bytes", {
  description: "RSS do agente (processo=agente) e da soma dos processos-filho (processo=filhos), em bytes."
})
export const agenteCpu = Metric.gauge("jarvis_herdr_agente_cpu_pct", {
  description: "CPU do agente e da soma dos processos-filho, em % de um núcleo."
})
export const agenteFilhos = Metric.gauge("jarvis_herdr_agente_filhos", {
  description: "Quantidade de processos-filho (todos os descendentes) do agente."
})

export const agenteSubagentes = Metric.gauge("jarvis_herdr_subagentes", {
  description: "Subagentes do Claude Code da sessão do agente (até 30 listados), por estado (rodando, terminou, parado)."
})

/** Séries com atributos que mudam (agente, versão): apagadas a cada passada para não ficarem paradas no último valor. */
const SERIES_VOLATEIS = new Set([
  "jarvis_herdr_info",
  "jarvis_herdr_agente_estado",
  "jarvis_herdr_agente_no_estado_segundos",
  "jarvis_herdr_agente_rss_bytes",
  "jarvis_herdr_agente_cpu_pct",
  "jarvis_herdr_agente_filhos",
  "jarvis_herdr_subagentes"
])

const ESTADOS_SUBAGENTE = ["rodando", "terminou", "parado"] as const

export const publicarHerdr = (herdr: EstadoHerdr): Effect.Effect<void> =>
  Effect.gen(function*() {
    const registro = yield* Metric.MetricRegistry
    for (const [chave, meta] of registro) if (SERIES_VOLATEIS.has(meta.id)) registro.delete(chave)

    yield* Metric.update(herdrVivo, herdr.vivo ? 1 : 0)
    yield* Metric.update(herdrWorkspaces, herdr.workspaces)
    yield* Metric.update(herdrPanes, herdr.panes)
    if (herdr.versao) yield* Metric.update(Metric.withAttributes(herdrInfo, { versao: herdr.versao }), 1)
    for (const a of herdr.agentes) {
      const agente = a.nome
      yield* Metric.update(Metric.withAttributes(agenteEstado, { agente, pane: a.pane, estado: a.estado }), 1)
      yield* Metric.update(Metric.withAttributes(agenteNoEstado, { agente }), a.segundos_no_estado)
      yield* Metric.update(Metric.withAttributes(agenteFilhos, { agente }), a.filhos.quantidade)
      if (a.sessao !== null) {
        for (const estado of ESTADOS_SUBAGENTE) {
          const n = a.subagentes.filter((s) => s.estado === estado).length
          yield* Metric.update(Metric.withAttributes(agenteSubagentes, { agente, estado }), n)
        }
      }
      if (a.pid !== null) {
        yield* Metric.update(Metric.withAttributes(agenteRss, { agente, processo: "agente" }), a.rss_bytes)
        yield* Metric.update(Metric.withAttributes(agenteCpu, { agente, processo: "agente" }), a.cpu_pct)
        yield* Metric.update(Metric.withAttributes(agenteRss, { agente, processo: "filhos" }), a.filhos.rss_bytes)
        yield* Metric.update(Metric.withAttributes(agenteCpu, { agente, processo: "filhos" }), a.filhos.cpu_pct)
      }
    }
  })
