import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Sobe o eventos-main de verdade (Bun) contra um herdr falso, que responde ao
 * `agent list` com o estado gravado em `status` e registra cada `agent prompt`.
 */
const dir = mkdtempSync(join(tmpdir(), "maestro-eventos-"))
const herdr = join(dir, "herdr-falso")
const fala = join(dir, "fala-falsa")
const status = join(dir, "status")
const prompts = join(dir, "prompts.log")
const falas = join(dir, "falas.log")
const port = 20000 + Math.floor(Math.random() * 20000)
const entry = new URL("../src/eventos-main.ts", import.meta.url).pathname

writeFileSync(
  herdr,
  `#!/bin/bash
case "$1 $2" in
  "agent list") s=$(cat "${status}"); echo "{\\"result\\":{\\"agents\\":[{\\"name\\":\\"maestro-x\\",\\"agent_status\\":\\"$s\\",\\"pane_id\\":\\"w9:p1\\",\\"workspace_id\\":\\"w9\\"}]}}" ;;
  "agent prompt") printf '%s\\n---\\n' "$4" >> "${prompts}"; echo '{"result":{"type":"ok"}}' ;;
  *) echo '{"error":{"code":"x","message":"x"}}' >&2; exit 1 ;;
esac
`
)
writeFileSync(fala, `#!/bin/bash\nprintf '%s\\n' "$1" >> "${falas}"\n`)
chmodSync(herdr, 0o755)
chmodSync(fala, 0o755)
writeFileSync(status, "working")

const env = {
  PATH: process.env.PATH ?? "",
  HOME: dir,
  JARVIS_MAESTRO_DIR: dir,
  JARVIS_MAESTRO_NOME: "maestro-x",
  JARVIS_HERDR: herdr,
  JARVIS_FALA: fala,
  JARVIS_EVENTOS_PORT: String(port)
}

let server: ChildProcess
let url = ""

const esperar = async (cond: () => boolean, ms = 15_000) => {
  const fim = Date.now() + ms
  while (!cond()) {
    if (Date.now() > fim) throw new Error("tempo esgotado")
    await new Promise((r) => setTimeout(r, 100))
  }
}

beforeAll(async () => {
  url = await new Promise<string>((resolve, reject) => {
    const print = spawn("bun", [entry, "--print-url"], { env })
    let out = ""
    print.stdout.on("data", (d) => (out += d))
    print.on("exit", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`print-url saiu com ${code}`))))
  })
  server = spawn("bun", [entry], { env })
  let err = ""
  server.stderr?.on("data", (d) => (err += d))
  await esperar(() => err.includes("ouvindo em"))
}, 30_000)

afterAll(() => {
  server?.kill()
})

const post = (alvo: string, body: unknown, method = "POST") =>
  fetch(alvo, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(body) : null })

describe("fila de eventos", () => {
  it("guarda o token num arquivo 0600 e só ouve em 127.0.0.1", () => {
    expect(statSync(join(dir, "eventos-token")).mode & 0o777).toBe(0o600)
    expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/evento/[A-Za-z0-9_-]{43}$`))
  })

  it("recusa caminho sem o token e corpo inválido", async () => {
    expect((await post(`http://127.0.0.1:${port}/evento/errado`, { origem: "a", texto: "b" })).status).toBe(404)
    expect((await post(`http://127.0.0.1:${port}/`, { origem: "a", texto: "b" })).status).toBe(404)
    expect((await post(url, { origem: "a" })).status).toBe(400)
    expect((await post(url, null, "GET")).status).toBe(405)
  })

  it("segura os eventos enquanto o maestro trabalha e entrega juntos quando fica idle", async () => {
    expect((await post(url, { origem: "teste", texto: "responda só ok" })).status).toBe(202)
    expect((await post(url, { origem: "outro", texto: "segundo" })).status).toBe(202)
    await new Promise((r) => setTimeout(r, 4_000))
    expect(existsSync(prompts)).toBe(false)
    writeFileSync(status, "idle")
    await esperar(() => existsSync(prompts))
    expect(readFileSync(prompts, "utf8")).toBe("[evento: teste] responda só ok\n\n[evento: outro] segundo\n---\n")
    expect(JSON.parse(readFileSync(join(dir, "fila.json"), "utf8")).eventos).toEqual([])
  }, 30_000)

  it("bloqueado, avisa pela fala uma vez e não entrega", async () => {
    writeFileSync(status, "blocked")
    await new Promise((r) => setTimeout(r, 6_000))
    expect((await post(url, { origem: "teste", texto: "terceiro" })).status).toBe(202)
    await esperar(() => existsSync(falas))
    await new Promise((r) => setTimeout(r, 7_000))
    expect(readFileSync(falas, "utf8").trim().split("\n")).toEqual([
      "O agente maestro-x espera aprovação no herdr, e há eventos na fila."
    ])
    expect(readFileSync(prompts, "utf8")).not.toContain("terceiro")
  }, 40_000)
})
