import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import {
  abrirQuadro, concluirCard, criarCard, enviarMensagem, eventosDe, exportarEventosJson, fecharQuadro,
  listarCards, obterCard, pegarCard, reconciliar, renovarLease, resumo
} from "../src/index.ts"

let dir: string
let path: string
let db: Database
const novo = (t = "tarefa") => criarCard({ titulo: t, brief: "b", kit: "backend", criado_por: "maestro" }, { db })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "quadro-"))
  path = join(dir, "quadro.db")
  db = abrirQuadro(path)
})
afterEach(() => {
  fecharQuadro(path)
  rmSync(dir, { recursive: true, force: true })
})

describe("quadro", () => {
  it("migração é idempotente e ids são J-n", () => {
    abrirQuadro(path)
    expect(novo().id).toBe("J-1")
    expect(novo().id).toBe("J-2")
  })

  it("claim concorrente: dois donos, só um ganha (conexões distintas)", () => {
    const c = novo()
    const outra = new Database(path)
    outra.run("PRAGMA busy_timeout = 5000")
    const a = pegarCard(c.id, "ana", 15, { db })
    const b = pegarCard(c.id, "bia", 15, { db: outra })
    expect([a, b].filter(Boolean)).toHaveLength(1)
    expect(a?.dono).toBe("ana")
    expect(b).toBeNull()
    outra.close()
  })

  it("proximo respeita prioridade", () => {
    novo("baixa")
    criarCard({ titulo: "alta", brief: "", kit: "ui", criado_por: "m", prioridade: 5 }, { db })
    expect(pegarCard("proximo", "ana", 15, { db })?.titulo).toBe("alta")
  })

  it("lease vencido: reconciliar devolve a aberto e gera evento; pego vencido também é pegável", () => {
    const c = novo()
    pegarCard(c.id, "ana", 15, { db })
    expect(reconciliar({ db })).toBe(0)
    db.run("UPDATE cards SET lease_ate = ? WHERE id = ?", [Date.now() - 1000, c.id])
    expect(pegarCard(c.id, "bia", 15, { db })?.dono).toBe("bia")
    db.run("UPDATE cards SET lease_ate = ? WHERE id = ?", [Date.now() - 1000, c.id])
    expect(reconciliar({ db })).toBe(1)
    const r = obterCard(c.id, { db })!
    expect(r.estado).toBe("aberto")
    expect(r.dono).toBeNull()
    expect(eventosDe(c.id, { db }).map((e) => e.tipo)).toContain("lease_vencido")
  })

  it("renovarLease só para o dono", () => {
    const c = novo()
    pegarCard(c.id, "ana", 1, { db })
    expect(renovarLease(c.id, "bia", 15, { db })).toBeNull()
    expect(renovarLease(c.id, "ana", 30, { db })!.lease_ate!).toBeGreaterThan(Date.now() + 25 * 60_000)
  })

  it("concluir por verdict", () => {
    const m = { PASS: "feito", BLOCKED: "bloqueado", ISSUES: "falhou" } as const
    for (const v of ["PASS", "BLOCKED", "ISSUES"] as const) {
      const c = novo(v)
      pegarCard(c.id, "ana", 15, { db })
      const r = concluirCard(c.id, "ana", { verdict: v, resultado: "ok" }, { db })
      expect(r.estado).toBe(m[v])
      expect(r.verdict).toBe(v)
    }
    const x = novo()
    expect(() => concluirCard(x.id, "ana", { verdict: "PASS", resultado: "" }, { db })).toThrow()
    pegarCard(x.id, "ana", 15, { db })
    expect(() => concluirCard(x.id, "bia", { verdict: "PASS", resultado: "" }, { db })).toThrow()
    expect(listarCards({ estado: "feito" }, { db })).toHaveLength(1)
  })

  it("resumo e export JSON", () => {
    const a = novo("um")
    novo("dois")
    pegarCard(a.id, "ana", 15, { db })
    enviarMensagem("ana", "maestro", "começando", { db })
    const s = resumo({ db })
    expect(s).toContain("1 aberto(s), 1 pego(s)")
    expect(s).toContain("J-1")
    expect(s).toContain("ana")
    expect(s).toContain("começando")
    expect(s.length).toBeLessThanOrEqual(1200)
    expect(JSON.parse(exportarEventosJson(undefined, { db })).length).toBeGreaterThanOrEqual(3)
  })
})
