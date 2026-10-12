import { describe, expect, it } from "@effect/vitest"
import { Effect, Metric } from "effect"
import { montarHerdr, parseSnapshot, pidsParaAmbiente, Rastreador } from "../src/herdr.ts"
import { publicarHerdr } from "../src/metricas.ts"
import { parsePanePorPid, parsePs, Tabela } from "../src/processos.ts"

const SNAPSHOT = JSON.stringify({
  id: "cli:api:snapshot",
  result: {
    type: "snapshot",
    snapshot: {
      version: "0.9.1",
      workspaces: [{ workspace_id: "wT2" }],
      panes: [{ pane_id: "wT2:p2" }, { pane_id: "wT2:pH" }, { pane_id: "wT2:p7" }],
      agents: [
        {
          agent: "claude",
          agent_status: "working",
          name: "maestro",
          pane_id: "wT2:p2",
          workspace_id: "wT2",
          tab_id: "wT2:t1",
          terminal_title_stripped: "Teste"
        },
        { agent: "codex", agent_status: "idle", pane_id: "wT2:p7", workspace_id: "wT2" }
      ]
    }
  }
})

// herdr server (96447) → shells → agentes; o claude tem dois filhos e um neto.
const PS = `
    1     0  10000   0.0 /sbin/launchd
96447     1  50000   1.5 /Users/f/.local/bin/herdr server
37273 96447    752   0.0 -zsh
15402 96447    688   0.0 -zsh
45151 96447    704   0.0 -zsh
51959 15402 400000  12,5 claude --resume
60001 51959  20000   3.0 /bin/zsh -c bun test
60002 60001  80000  40.0 bun test
60003 51959  10000   0.5 node mcp.js
70001 45151 300000   2.0 /opt/homebrew/bin/codex
`

const ENV = `
51959 claude --resume HOME=/Users/f HERDR_PANE_ID=wT2:p2 TERM=xterm
70001 /opt/homebrew/bin/codex HERDR_PANE_ID=wT2:p7
`

describe("parseSnapshot", () => {
  it("conta workspaces e panes e lê os agentes", () => {
    const s = parseSnapshot(SNAPSHOT)!
    expect(s).toMatchObject({ version: "0.9.1", workspaces: 1, panes: 3 })
    expect(s.agentes.map((a) => a.name ?? a.agent)).toEqual(["maestro", "codex"])
    expect(parseSnapshot("não é json")).toBeUndefined()
    expect(parseSnapshot("{\"result\":{}}")).toBeUndefined()
  })
})

describe("montarHerdr", () => {
  it("acha o processo de cada agente pelo HERDR_PANE_ID e soma os filhos", () => {
    const tabela = new Tabela(parsePs(PS))
    expect(pidsParaAmbiente(tabela, 96447).sort()).toEqual([15402, 37273, 45151, 51959, 70001])
    const estado = montarHerdr(parseSnapshot(SNAPSHOT)!, tabela, parsePanePorPid(ENV), new Rastreador(), 1_000_000)
    expect(estado).toMatchObject({ vivo: true, versao: "0.9.1", servidor_pid: 96447, workspaces: 1, panes: 3 })
    const [maestro, codex] = estado.agentes
    expect(maestro).toMatchObject({
      nome: "maestro",
      estado: "working",
      pid: 51959,
      comando: "claude",
      rss_bytes: 400000 * 1024,
      cpu_pct: 12.5,
      filhos: { quantidade: 3, rss_bytes: 110000 * 1024, cpu_pct: 43.5 }
    })
    expect(codex).toMatchObject({ nome: "codex@wT2:p7", pid: 70001, comando: "codex", filhos: { quantidade: 0 } })
  })

  it("sem o servidor na tabela o agente fica sem processo", () => {
    const estado = montarHerdr(parseSnapshot(SNAPSHOT)!, new Tabela([]), new Map(), new Rastreador(), 0)
    expect(estado.agentes[0]).toMatchObject({ pid: null, rss_bytes: 0, filhos: { quantidade: 0 } })
  })
})

describe("Rastreador", () => {
  it("conta o tempo no estado e só marca exato o que mudou depois da primeira passada", () => {
    const r = new Rastreador()
    expect(r.observar("a", "working", 0)).toEqual({ estado: "working", desde: 0, exato: false })
    r.manter(new Set(["a"]))
    expect(r.observar("a", "working", 5000).desde).toBe(0)
    expect(r.observar("a", "idle", 9000)).toMatchObject({ desde: 9000, exato: true })
    expect(r.observar("b", "done", 9000)).toMatchObject({ exato: true })
    r.manter(new Set(["b"]))
    expect(r.observar("a", "idle", 12000)).toMatchObject({ desde: 12000 })
  })
})

describe("publicarHerdr", () => {
  it.effect("publica as séries do contrato e apaga as de agentes que sumiram", () =>
    Effect.gen(function*() {
      const tabela = new Tabela(parsePs(PS))
      const rastreador = new Rastreador()
      const snap = parseSnapshot(SNAPSHOT)!
      yield* publicarHerdr(montarHerdr(snap, tabela, parsePanePorPid(ENV), rastreador, 0))

      let series = yield* Metric.snapshot
      const valor = (id: string, attrs: Record<string, string> = {}) =>
        series.filter((m) => m.id === id && Object.entries(attrs).every(([k, v]) => m.attributes?.[k] === v))
          .map((m) => m.type === "Gauge" ? m.state.value : undefined)

      expect(valor("jarvis_herdr_vivo")).toEqual([1])
      expect(valor("jarvis_herdr_info", { versao: "0.9.1" })).toEqual([1])
      expect(valor("jarvis_herdr_workspaces")).toEqual([1])
      expect(valor("jarvis_herdr_panes")).toEqual([3])
      expect(valor("jarvis_herdr_agente_estado", { agente: "maestro", pane: "wT2:p2", estado: "working" })).toEqual([1])
      expect(valor("jarvis_herdr_agente_rss_bytes", { agente: "maestro", processo: "agente" })).toEqual([409600000])
      expect(valor("jarvis_herdr_agente_rss_bytes", { agente: "maestro", processo: "filhos" })).toEqual([112640000])
      expect(valor("jarvis_herdr_agente_cpu_pct", { agente: "maestro", processo: "filhos" })).toEqual([43.5])
      expect(valor("jarvis_herdr_agente_filhos", { agente: "maestro" })).toEqual([3])
      expect(valor("jarvis_herdr_agente_no_estado_segundos", { agente: "codex@wT2:p7" })).toEqual([0])

      // O maestro some e o codex muda de estado: nada do maestro nem do estado antigo fica no ar.
      const depois = { ...snap, agentes: [{ ...snap.agentes[1]!, agent_status: "blocked" }] }
      yield* publicarHerdr(montarHerdr(depois, tabela, parsePanePorPid(ENV), rastreador, 7000))
      series = yield* Metric.snapshot
      expect(series.some((m) => m.attributes?.agente === "maestro")).toBe(false)
      expect(valor("jarvis_herdr_agente_estado", { agente: "codex@wT2:p7" })).toEqual([1])
      expect(series.filter((m) => m.id === "jarvis_herdr_agente_estado")[0]?.attributes?.estado).toBe("blocked")
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))
})
