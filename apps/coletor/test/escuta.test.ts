import { describe, expect, it } from "@effect/vitest"
import { Effect, Metric } from "effect"
import { type EventoEscuta, parseLinha, ResumoEscuta } from "../src/escuta.ts"
import { registrarEscuta } from "../src/metricas.ts"

// Linhas no formato real de escuta.events.jsonl.
const LINHAS = [
  `{"device":"AiPod 3 Pro","profile":"A2DP estéreo","rate":48000,"ts":"2026-10-12T03:05:30Z","type":"airpods"}`,
  `{"generation":1,"reason":"início","replayed":0,"ts":"2026-10-12T03:05:34Z","type":"recognizer"}`,
  `{"locale":"pt-BR","mic":"Microfone do iPhone","open_silence":2.5,"silence":1,"ts":"2026-10-12T03:05:37Z","type":"ready","wake_word":"jarvis"}`,
  `{"confidence":0.92,"during_speech":true,"end":"silêncio","seconds":9.1,"sent":true,"text":"acelera a telemetria","ts":"2026-10-12T03:43:36Z","type":"heard","voice":true,"wake":false}`,
  `{"id":2,"text":"acelera a telemetria","ts":"2026-10-12T03:43:36Z","type":"command"}`,
  `{"detail":"","id":2,"latency_ms":2614,"mode":"prompt","ms":324,"ok":true,"pane":"wT2:p2","ts":"2026-10-12T03:43:36Z","type":"routed","who":"maestro"}`,
  `{"end":"silêncio","seconds":0.7,"text":".","ts":"2026-10-12T03:05:53Z","type":"heard","wake":false}`,
  `{"confidence":0.4,"during_speech":false,"end":"silêncio","seconds":0.5,"sent":false,"text":"é","ts":"2026-10-12T03:44:00Z","type":"heard","voice":false,"wake":false}`,
  `{"ts":"2026-10-12T03:44:33Z","type":"jarvis_speaking"}`,
  `{"audio_s":18.1,"heard":"Eu","kill_ms":207,"killed":["78236 /usr/bin/curl"],"owner":"Eu","ts":"2026-10-12T03:44:34Z","type":"barge_in"}`,
  `{"heard":"Jarvis","killed":["17878 /usr/bin/afplay"],"ts":"2026-10-12T03:27:22Z","type":"barge_in","word":"jarvis"}`,
  `{"detail":"timeout","id":3,"latency_ms":9000,"mode":"prompt","ms":5000,"ok":false,"pane":"","ts":"2026-10-12T03:45:00Z","type":"routed","who":""}`,
  `{"in":0,"reason":"menu","ts":"2026-10-12T03:11:35Z","type":"restart"}`
]

const eventos = (): Array<EventoEscuta> => LINHAS.map((l) => parseLinha(l)!)

describe("parseLinha", () => {
  it("lê o JSON e ignora linhas quebradas ou sem type", () => {
    expect(parseLinha(LINHAS[5]!)?.type).toBe("routed")
    expect(parseLinha("{\"ts\":\"x\"}")).toBeUndefined()
    expect(parseLinha("{quebrado")).toBeUndefined()
    expect(parseLinha("   ")).toBeUndefined()
  })
})

describe("ResumoEscuta", () => {
  it("conta pedidos, descartes, interrupções e reinícios", () => {
    const r = new ResumoEscuta("/tmp/x")
    for (const e of eventos()) r.aplicar(e)
    const s = r.estado()
    expect(s.contadores).toEqual({
      ouvidos: 3,
      descartadas: 2,
      pedidos: 2,
      entregues: 1,
      falhas: 1,
      interrupcoes: 2,
      reinicios_reconhecimento: 1,
      reinicios_escuta: 1,
      erros: 0
    })
    expect(s.entrega_ms).toMatchObject({ amostras: 2, ultima: 9000, maxima: 9000, p50: 2614 })
    // Só o pedido que chegou (ok) conta na espera do fim da fala.
    expect(s.latencia_fim_fala_ms).toMatchObject({ amostras: 1, p50: 2614, p95: 2614 })
    expect(s.interrupcao_kill_ms).toMatchObject({ amostras: 1, ultima: 207 })
    expect(s.confianca).toMatchObject({ amostras: 2, media: 0.66 })
    expect(s.microfone).toBe("Microfone do iPhone")
    expect(s.saida).toBe("AiPod 3 Pro")
    expect(s.fase).toBe("jarvis_falando")
    expect(s.ultimos_eventos[0]).toMatchObject({ type: "restart" })
    expect(s.ultimos_eventos.some((e) => "killed" in e)).toBe(false)
  })

  it("semear preenche o estado sem contar nada", () => {
    const r = new ResumoEscuta("/tmp/x")
    for (const e of eventos()) r.semear(e)
    const s = r.estado()
    expect(s.contadores.pedidos).toBe(0)
    expect(s.entrega_ms.amostras).toBe(0)
    expect(s.latencia_fim_fala_ms).toMatchObject({ amostras: 1, p50: 2614 })
    expect(s.ultimos_eventos).toHaveLength(LINHAS.length)
    expect(s.microfone).toBe("Microfone do iPhone")
  })
})

describe("registrarEscuta", () => {
  it.effect("gera as métricas com os nomes e atributos do contrato", () =>
    Effect.gen(function*() {
      for (const e of eventos()) yield* registrarEscuta(e)
      const snap = yield* Metric.snapshot
      const serie = (id: string, attrs: Record<string, string> = {}) =>
        snap.filter((m) => m.id === id && Object.entries(attrs).every(([k, v]) => m.attributes?.[k] === v))

      const pedidos = serie("jarvis_escuta_pedidos_total")
      expect(pedidos.map((m) => m.attributes)).toEqual(
        expect.arrayContaining([{ ok: "true", who: "maestro" }, { ok: "false", who: "desconhecido" }])
      )
      const entrega = serie("jarvis_escuta_entrega_ms", { ok: "true" })[0]!
      expect(entrega.type === "Histogram" && entrega.state.sum).toBe(2614)
      expect(serie("jarvis_escuta_roteamento_ms")).toHaveLength(2)
      const fimFala = serie("jarvis_escuta_latencia_fim_fala_ms")
      expect(fimFala.map((m) => m.attributes)).toEqual([{ who: "maestro" }])
      expect(fimFala[0]!.type === "Histogram" && fimFala[0]!.state.sum).toBe(2614)

      const interrupcoes = serie("jarvis_escuta_interrupcoes_total")
      expect(interrupcoes.map((m) => m.attributes?.gatilho).sort()).toEqual(["fala", "palavra"])
      const kill = serie("jarvis_escuta_interrupcao_kill_ms")[0]!
      expect(kill.type === "Histogram" && kill.state.count).toBe(1)

      expect(serie("jarvis_escuta_reinicios_total", { reason: "início", origem: "reconhecedor" })).toHaveLength(1)
      expect(serie("jarvis_escuta_reinicios_total", { reason: "menu", origem: "escuta" })).toHaveLength(1)

      const descartadas = serie("jarvis_escuta_descartadas_total")[0]!
      expect(descartadas.type === "Counter" && descartadas.state.count).toBe(2)
      const ouvidosDescartados = serie("jarvis_escuta_ouvidos_total", { wake: "false", enviada: "false" })
      expect(ouvidosDescartados.reduce((s, m) => s + (m.type === "Counter" ? Number(m.state.count) : 0), 0)).toBe(2)
      const conf = serie("jarvis_escuta_confianca")
      expect(conf.reduce((s, m) => s + (m.type === "Histogram" ? m.state.count : 0), 0)).toBe(2)

      // Nenhum atributo vazio e nenhum texto falado nas séries.
      for (const m of snap) {
        for (const valor of Object.values(m.attributes ?? {})) {
          expect(valor).not.toBe("")
          expect(String(valor)).not.toContain("telemetria")
        }
      }
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))
})
