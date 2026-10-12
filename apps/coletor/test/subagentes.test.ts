import { describe, expect, it } from "@effect/vitest"
import { Effect, Metric } from "effect"
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { montarHerdr, parseSnapshot, Rastreador } from "../src/herdr.ts"
import { publicarHerdr } from "../src/metricas.ts"
import { parsePanePorPid, parsePs, Tabela } from "../src/processos.ts"
import { cortar, LeitorSubagentes, semSegredo } from "../src/subagentes.ts"

const SESSAO = "6d36d872-9d9c-4685-9edd-87b883b059f9"
const T0 = Date.parse("2026-10-12T10:00:00Z")
const min = (n: number) => T0 + n * 60_000

const tocar = (caminho: string, t: number) => utimesSync(caminho, t / 1000, t / 1000)

interface Fixture {
  readonly raiz: string
  readonly sub: string
  readonly ledger: string
}

/** Monta um ~/.claude falso: sessions/<pid>.json, agent-ledger, projects/<proj>/<sessão>/subagents. */
const montarFixture = (): Fixture => {
  const raiz = mkdtempSync(join(tmpdir(), "coletor-subagentes-"))
  const proj = join(raiz, "projects", "-Users-f-proj")
  const sub = join(proj, SESSAO, "subagents")
  mkdirSync(sub, { recursive: true })
  mkdirSync(join(raiz, "sessions"))
  mkdirSync(join(raiz, "agent-ledger"))
  writeFileSync(join(raiz, "sessions", "51959.json"), JSON.stringify({ pid: 51959, sessionId: SESSAO, cwd: "/Users/f/proj" }))
  const tx = join(proj, `${SESSAO}.jsonl`)
  const ledger = join(raiz, "agent-ledger", `${SESSAO}.jsonl`)
  const ev = (e: object) => JSON.stringify(e)
  writeFileSync(
    ledger,
    [
      ev({ ev: "start", t: min(0), id: "aaa1", type: "general-purpose", tx }),
      ev({ ev: "start", t: min(1), id: "bbb2", type: "Explore", tx }),
      ev({ ev: "stop", t: min(3), id: "bbb2", type: "Explore", tail: "fim do explore: achei os arquivos" }),
      ev({ ev: "start", t: min(4), id: "ccc3", type: "general-purpose", tx }),
      ev({ ev: "start", t: min(5), id: "ddd4", type: "general-purpose", tx }),
      ""
    ].join("\n")
  )
  const meta = (id: string, m: object) => writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify(m))
  meta("aaa1", { agentType: "general-purpose", description: "Coletor: subagentes", spawnDepth: 1 })
  meta("bbb2", { agentType: "Explore", description: "Achar o hook", spawnDepth: 1 })
  meta("ccc3", { agentType: "general-purpose", description: "Dashboard: tela", spawnDepth: 1 })
  meta("ddd4", { agentType: "general-purpose", description: "Neto do coletor", parentAgentId: "aaa1", spawnDepth: 2 })

  const linha = (content: object[]) => JSON.stringify({ type: "assistant", message: { content } })
  // aaa1: Bash pendente com segredo no comando
  writeFileSync(
    join(sub, "agent-aaa1.jsonl"),
    [
      JSON.stringify({ type: "user", message: { content: "tarefa" } }),
      linha([{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }]),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
      linha([{
        type: "tool_use",
        id: "t2",
        name: "Bash",
        input: { command: "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 bun test --reporter verbose && echo pronto e mais um monte de texto" }
      }]),
      ""
    ].join("\n")
  )
  writeFileSync(join(sub, "agent-bbb2.jsonl"), linha([{ type: "text", text: "oi" }]) + "\n")
  // ccc3: entregou o relatório mas o ledger ainda não viu o stop
  writeFileSync(
    join(sub, "agent-ccc3.jsonl"),
    linha([{ type: "tool_use", id: "h1", name: "SubagentHandback", input: { message: "Tela pronta.\nCommit abc123." } }]) + "\n"
  )
  writeFileSync(join(sub, "agent-ddd4.jsonl"), linha([{ type: "text", text: "pensando" }]) + "\n")
  for (const id of ["aaa1", "bbb2", "ccc3", "ddd4"]) tocar(join(sub, `agent-${id}.jsonl`), min(5.5))
  return { raiz, sub, ledger }
}

describe("semSegredo e cortar", () => {
  it("esconde tokens, chaves e senhas e corta no limite", () => {
    expect(semSegredo("API_KEY=abc123 curl -H 'Authorization: Bearer xyz.abc-123456'")).not.toMatch(/abc123|xyz\.abc/)
    expect(semSegredo("git clone https://user:senha123@github.com/x")).toBe("git clone https://user:***@github.com/x")
    expect(semSegredo("usa sk-ant-0123456789abcdef aqui")).toBe("usa *** aqui")
    expect(semSegredo("mysql --password hunter2 -u root")).toBe("mysql --password *** -u root")
    expect(semSegredo("bun test src/a.ts")).toBe("bun test src/a.ts")
    const caminho = "cd /Users/f/Documents/code/orgs/fernandoeeu/ai-voice/apps/-Users-fernandodudata-Documents-code-orgs"
    expect(semSegredo(caminho)).toBe(caminho)
    expect(semSegredo("x aGVsbG8gd29ybGQgdGhpcyBpcyBhIHNlY3JldCB0b2tlbjEyMw== y")).toBe("x *** y")
    const c = cortar("palavra ".repeat(40), 80)
    expect(c.length).toBe(80)
    expect(c.endsWith("…")).toBe(true)
  })
})

describe("LeitorSubagentes", () => {
  it("liga a sessão pelo PID e monta os subagentes com estado, pai e espera", () => {
    const f = montarFixture()
    const leitor = new LeitorSubagentes({ claudeDir: f.raiz })
    const agora = min(6)
    const { sessao, subagentes } = leitor.doAgente(51959, "maestro", agora)
    expect(sessao).toBe(SESSAO)
    expect(leitor.doAgente(12345, "x", agora)).toEqual({ sessao: null, subagentes: [] })
    expect(leitor.doAgente(null, "x", agora)).toEqual({ sessao: null, subagentes: [] })

    const ids = subagentes.map((s) => `${s.id}:${s.estado}`)
    // rodando primeiro (mais recentes antes), depois o resto por início
    expect(ids).toEqual(["ddd4:rodando", "aaa1:rodando", "ccc3:terminou", "bbb2:terminou"])

    const [neto, coletor, tela, explore] = subagentes
    expect(neto).toMatchObject({ pai_id: "aaa1", aberto_por: "Coletor: subagentes", descricao: "Neto do coletor", fim: null })
    expect(coletor).toMatchObject({
      tipo: "general-purpose",
      pai_id: null,
      aberto_por: "maestro",
      inicio: new Date(min(0)).toISOString(),
      duracao_s: 360,
      resumo_fim: null
    })
    expect(coletor!.aguardando).toMatch(/^Bash: GITHUB_TOKEN=\*\*\* bun test/)
    expect(coletor!.aguardando!.length).toBeLessThanOrEqual(80)
    expect(coletor!.aguardando).not.toContain("ghp_")
    expect(coletor!.ultima_atividade_em).toBe(new Date(min(5.5)).toISOString())
    expect(tela).toMatchObject({ estado: "terminou", resumo_fim: "Tela pronta. Commit abc123.", aguardando: null })
    expect(explore).toMatchObject({
      estado: "terminou",
      fim: new Date(min(3)).toISOString(),
      duracao_s: 120,
      resumo_fim: "fim do explore: achei os arquivos"
    })
  })

  it("lê só o que foi acrescentado: a ferramenta pendente resolve e o stop chega", () => {
    const f = montarFixture()
    const leitor = new LeitorSubagentes({ claudeDir: f.raiz })
    expect(leitor.daSessao(SESSAO, "maestro", min(6)).find((s) => s.id === "aaa1")?.aguardando).toMatch(/^Bash/)
    appendFileSync(
      join(f.sub, "agent-aaa1.jsonl"),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2" }] } }) + "\n"
    )
    tocar(join(f.sub, "agent-aaa1.jsonl"), min(6.5))
    expect(leitor.daSessao(SESSAO, "maestro", min(7)).find((s) => s.id === "aaa1")?.aguardando).toBeNull()
    appendFileSync(f.ledger, JSON.stringify({ ev: "stop", t: min(8), id: "agent-aaa1", type: "general-purpose", tail: "ok" }) + "\n")
    expect(leitor.daSessao(SESSAO, "maestro", min(9)).find((s) => s.id === "aaa1")).toMatchObject({
      estado: "terminou",
      duracao_s: 480,
      resumo_fim: "ok"
    })
  })

  it("marca parado quem não escreve há muito tempo ou sumiu das tarefas em background", () => {
    const f = montarFixture()
    const leitor = new LeitorSubagentes({ claudeDir: f.raiz, ociosoMs: 1 })
    const muitoDepois = min(100)
    const estados = leitor.daSessao(SESSAO, "maestro", muitoDepois).map((s) => `${s.id}:${s.estado}`)
    expect(estados).toContain("aaa1:parado")
    expect(estados).toContain("ddd4:parado")

    const f2 = montarFixture()
    appendFileSync(f2.ledger, JSON.stringify({ ev: "bg", t: min(10), tasks: [{ id: "ddd4", type: "subagent" }] }) + "\n")
    const l2 = new LeitorSubagentes({ claudeDir: f2.raiz })
    const e2 = Object.fromEntries(l2.daSessao(SESSAO, "maestro", min(11)).map((s) => [s.id, s.estado]))
    expect(e2).toMatchObject({ aaa1: "parado", ddd4: "rodando" })
  })

  it("corta em no máximo N, mantendo os rodando", () => {
    const f = montarFixture()
    const leitor = new LeitorSubagentes({ claudeDir: f.raiz, maximo: 2 })
    expect(leitor.daSessao(SESSAO, "maestro", min(6)).map((s) => s.id)).toEqual(["ddd4", "aaa1"])
  })
})

const SNAPSHOT = JSON.stringify({
  version: "0.9.1",
  workspaces: [{}],
  panes: [{ pane_id: "wT2:p2" }],
  agents: [{ agent: "claude", agent_status: "working", name: "maestro", pane_id: "wT2:p2" }]
})
const PS = `
96447     1  50000   1.5 /Users/f/.local/bin/herdr server
15402 96447    688   0.0 -zsh
51959 15402 400000  12.5 claude
`

describe("integração com o herdr", () => {
  it.effect("o agente ganha sessao e subagentes, e a métrica conta por estado", () =>
    Effect.gen(function*() {
      const f = montarFixture()
      const leitor = new LeitorSubagentes({ claudeDir: f.raiz })
      const estado = montarHerdr(
        parseSnapshot(SNAPSHOT)!,
        new Tabela(parsePs(PS)),
        parsePanePorPid("51959 claude HERDR_PANE_ID=wT2:p2"),
        new Rastreador(),
        min(6),
        (pid, nome, agora) => leitor.doAgente(pid, nome, agora)
      )
      const maestro = estado.agentes[0]!
      expect(maestro.sessao).toBe(SESSAO)
      expect(maestro.subagentes).toHaveLength(4)

      yield* publicarHerdr(estado)
      const series = yield* Metric.snapshot
      const valor = (estado: string) =>
        series.find((m) =>
          m.id === "jarvis_herdr_subagentes" && m.attributes?.agente === "maestro" && m.attributes?.estado === estado
        )
      const v = (e: string) => {
        const m = valor(e)
        return m?.type === "Gauge" ? m.state.value : undefined
      }
      expect([v("rodando"), v("terminou"), v("parado")]).toEqual([2, 2, 0])
    }).pipe(Effect.provideService(Metric.MetricRegistry, new Map())))
})
