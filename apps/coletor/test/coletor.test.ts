import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { type ChildProcess, spawn } from "node:child_process"
import { appendFileSync, chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Sobe o main.ts de verdade (Bun) com um herdr falso, um arquivo de eventos
 * temporário e um receptor OTLP falso, e confere /estado, o SSE e o OTLP.
 */
const dir = mkdtempSync(join(tmpdir(), "coletor-"))
const eventos = join(dir, "escuta.events.jsonl")
const herdr = join(dir, "herdr-falso")
const porta = 20000 + Math.floor(Math.random() * 20000)
const entry = new URL("../src/main.ts", import.meta.url).pathname
const recebidos: Array<string> = []
let otlp: Server
let coletor: ChildProcess
let otlpUrl = ""

writeFileSync(
  herdr,
  `#!/bin/bash
[ "$1 $2" = "api snapshot" ] || exit 2
echo '{"result":{"type":"snapshot","snapshot":{"version":"9.9.9","workspaces":[{},{}],"panes":[{},{},{}],"agents":[{"agent":"claude","agent_status":"blocked","name":"maestro","pane_id":"w1:p1","workspace_id":"w1"}]}}}'
`
)
chmodSync(herdr, 0o755)
writeFileSync(eventos, `{"ts":"2026-10-12T03:00:00Z","type":"ready","mic":"Mic antigo"}\n`)

const esperar = async <A>(f: () => Promise<A | undefined>, ms = 15_000): Promise<A> => {
  const fim = Date.now() + ms
  while (Date.now() < fim) {
    const v = await f().catch(() => undefined)
    if (v !== undefined) return v
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error("tempo esgotado esperando")
}

const estado = async (): Promise<any> => {
  const r = await fetch(`http://127.0.0.1:${porta}/estado`)
  return r.ok ? r.json() : undefined
}

beforeAll(async () => {
  otlp = createServer((req, res) => {
    let corpo = ""
    req.on("data", (c) => (corpo += c))
    req.on("end", () => {
      recebidos.push(`${req.url} ${corpo}`)
      res.writeHead(200, { "content-type": "application/json" }).end("{}")
    })
  })
  await new Promise<void>((r) => otlp.listen(0, "127.0.0.1", r))
  const endereco = otlp.address()
  otlpUrl = `http://127.0.0.1:${typeof endereco === "object" && endereco ? endereco.port : 0}`
  coletor = spawn("bun", [entry], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      JARVIS_ESCUTA_EVENTOS: eventos,
      JARVIS_HERDR: herdr,
      JARVIS_COLETOR_PORTA: String(porta),
      JARVIS_COLETOR_INTERVALO_MS: "500",
      JARVIS_COLETOR_SERVICOS: "false",
      JARVIS_OTLP_URL: otlpUrl
    },
    stdio: ["ignore", "ignore", "inherit"]
  })
})

afterAll(async () => {
  coletor?.kill("SIGTERM")
  await new Promise<void>((r) => otlp.close(() => r()))
})

describe("coletor", () => {
  it("serve o retrato com herdr e Escuta, ao vivo por SSE, e exporta por OTLP", async () => {
    const primeiro = await esperar(estado)
    expect(primeiro.herdr).toMatchObject({ vivo: true, versao: "9.9.9", workspaces: 2, panes: 3 })
    expect(primeiro.herdr.agentes[0]).toMatchObject({ nome: "maestro", estado: "blocked", pid: null })
    expect(primeiro.escuta.microfone).toBe("Mic antigo")
    expect(primeiro.escuta.contadores.pedidos).toBe(0)
    expect(primeiro.coletor.otlp).toBe(otlpUrl)

    // SSE: o primeiro evento chega na hora.
    const controle = new AbortController()
    const sse = await fetch(`http://127.0.0.1:${porta}/estado/ao-vivo`, { signal: controle.signal })
    expect(sse.headers.get("content-type")).toContain("text/event-stream")
    const leitor = sse.body!.getReader()
    let texto = ""
    while (!texto.includes("event: estado\ndata: ")) texto += new TextDecoder().decode((await leitor.read()).value)
    controle.abort()

    appendFileSync(
      eventos,
      `{"detail":"","id":1,"latency_ms":1800,"mode":"prompt","ms":300,"ok":true,"pane":"w1:p1","ts":"2026-10-12T03:01:00Z","type":"routed","who":"maestro"}\n` +
        `{"audio_s":3,"heard":"Eu","kill_ms":210,"killed":[],"owner":"Eu","ts":"2026-10-12T03:01:05Z","type":"barge_in"}\n`
    )
    const depois = await esperar(async () => {
      const e = await estado()
      return e?.escuta.contadores.pedidos === 1 ? e : undefined
    })
    expect(depois.escuta.contadores.interrupcoes).toBe(1)
    expect(depois.escuta.entrega_ms.ultima).toBe(1800)

    const metricas = await esperar(async () => {
      const m = recebidos.filter((r) => r.startsWith("/v1/metrics") && r.includes("jarvis_escuta_pedidos_total"))
      return m.length > 0 ? m.at(-1)! : undefined
    }, 20_000)
    for (const nome of ["jarvis_escuta_entrega_ms", "jarvis_escuta_interrupcao_kill_ms", "jarvis_herdr_vivo", "jarvis_herdr_agente_estado"]) {
      expect(metricas).toContain(nome)
    }
    expect(metricas).toContain("\"jarvis-coletor\"")
    expect(metricas).toContain("service.namespace")
  }, 40_000)
})
