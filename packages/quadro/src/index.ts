import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export type Kit = "backend" | "ui" | "devops" | "seguranca" | "pesquisa" | "geral"
export type Estado = "aberto" | "pego" | "feito" | "falhou" | "bloqueado"
export type Verdict = "PASS" | "ISSUES" | "BLOCKED"

export interface Card {
  id: string
  titulo: string
  brief: string
  kit: Kit
  estado: Estado
  dono: string | null
  lease_ate: number | null
  criado_por: string
  verdict: Verdict | null
  resultado: string | null
  prioridade: number
  criado_em: number
  atualizado_em: number
}
export interface Evento {
  id: number
  card_id: string
  tipo: string
  ator: string
  texto: string
  ts: number
}
export interface Mensagem {
  id: number
  de: string
  para: string
  texto: string
  ts: number
}

export const caminhoPadrao = () => join(process.env.JARVIS_DIR ?? join(homedir(), ".jarvis"), "quadro.db")

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY, titulo TEXT NOT NULL, brief TEXT NOT NULL DEFAULT '',
  kit TEXT NOT NULL DEFAULT 'geral', estado TEXT NOT NULL DEFAULT 'aberto',
  dono TEXT, lease_ate INTEGER, criado_por TEXT NOT NULL, verdict TEXT, resultado TEXT,
  prioridade INTEGER NOT NULL DEFAULT 0, criado_em INTEGER NOT NULL, atualizado_em INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, tipo TEXT NOT NULL,
  ator TEXT NOT NULL, texto TEXT NOT NULL DEFAULT '', ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS mensagens (
  id INTEGER PRIMARY KEY AUTOINCREMENT, de TEXT NOT NULL, para TEXT NOT NULL,
  texto TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_estado ON cards(estado);
CREATE INDEX IF NOT EXISTS idx_eventos_card ON eventos(card_id);
`

const conexoes = new Map<string, Database>()

/** Abre (ou reutiliza) o banco; cria diretório, WAL e tabelas de forma idempotente. */
export function abrirQuadro(path: string = caminhoPadrao()): Database {
  const existente = conexoes.get(path)
  if (existente) return existente
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path, { create: true })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA synchronous = NORMAL")
  db.exec(SCHEMA)
  conexoes.set(path, db)
  return db
}

export function fecharQuadro(path: string = caminhoPadrao()): void {
  conexoes.get(path)?.close()
  conexoes.delete(path)
}

type Opts = { db?: Database }
const bd = (o?: Opts) => o?.db ?? abrirQuadro()
const agora = () => Date.now()

function tx<T>(db: Database, fn: () => T): T {
  db.run("BEGIN IMMEDIATE")
  try {
    const r = fn()
    db.run("COMMIT")
    return r
  } catch (e) {
    try { db.run("ROLLBACK") } catch {}
    throw e
  }
}

function evento(db: Database, card_id: string, tipo: string, ator: string, texto = ""): void {
  db.query("INSERT INTO eventos (card_id,tipo,ator,texto,ts) VALUES (?,?,?,?,?)").run(card_id, tipo, ator, texto, agora())
}

const getCard = (db: Database, id: string): Card | null =>
  (db.query("SELECT * FROM cards WHERE id = ?").get(id) as Card | null) ?? null

export function obterCard(id: string, o?: Opts): Card | null {
  return getCard(bd(o), id)
}

export function criarCard(
  input: { titulo: string; brief: string; kit: Kit; criado_por: string; prioridade?: number },
  o?: Opts
): Card {
  const db = bd(o)
  return tx(db, () => {
    const r = db.query("SELECT COALESCE(MAX(CAST(SUBSTR(id,3) AS INTEGER)),0)+1 AS n FROM cards").get() as { n: number }
    const id = `J-${r.n}`
    const t = agora()
    db.query(
      "INSERT INTO cards (id,titulo,brief,kit,estado,criado_por,prioridade,criado_em,atualizado_em) VALUES (?,?,?,?,'aberto',?,?,?,?)"
    ).run(id, input.titulo, input.brief, input.kit, input.criado_por, input.prioridade ?? 0, t, t)
    evento(db, id, "criado", input.criado_por, input.titulo)
    return getCard(db, id)!
  })
}

export function listarCards(f: { estado?: Estado | undefined; dono?: string | undefined; limite?: number | undefined } = {}, o?: Opts): Card[] {
  const db = bd(o)
  const w: string[] = []
  const p: (string | number)[] = []
  if (f.estado) { w.push("estado = ?"); p.push(f.estado) }
  if (f.dono) { w.push("dono = ?"); p.push(f.dono) }
  const sql = `SELECT * FROM cards ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY prioridade DESC, CAST(SUBSTR(id,3) AS INTEGER) ASC LIMIT ?`
  return db.query(sql).all(...p, f.limite ?? 100) as Card[]
}

/** Pega atomicamente um card aberto (ou com lease vencido). id="proximo" escolhe o de maior prioridade. */
export function pegarCard(id: string | "proximo", dono: string, leaseMin = 15, o?: Opts): Card | null {
  const db = bd(o)
  return tx(db, () => {
    const t = agora()
    const livre = "(estado = 'aberto' OR (estado = 'pego' AND lease_ate IS NOT NULL AND lease_ate < ?))"
    const alvo = (
      id === "proximo"
        ? db.query(`SELECT id FROM cards WHERE ${livre} ORDER BY prioridade DESC, CAST(SUBSTR(id,3) AS INTEGER) ASC LIMIT 1`).get(t)
        : db.query(`SELECT id FROM cards WHERE id = ? AND ${livre}`).get(id, t)
    ) as { id: string } | null
    if (!alvo) return null
    db.query("UPDATE cards SET estado='pego', dono=?, lease_ate=?, atualizado_em=? WHERE id=?").run(
      dono, t + leaseMin * 60_000, t, alvo.id
    )
    evento(db, alvo.id, "pego", dono, `lease ${leaseMin}min`)
    return getCard(db, alvo.id)
  })
}

/** Renova o lease; só o dono atual com card ainda pego. Devolve o card ou null. */
export function renovarLease(id: string, dono: string, leaseMin = 15, o?: Opts): Card | null {
  const db = bd(o)
  return tx(db, () => {
    const t = agora()
    const r = db
      .query("UPDATE cards SET lease_ate=?, atualizado_em=? WHERE id=? AND estado='pego' AND dono=?")
      .run(t + leaseMin * 60_000, t, id, dono)
    if (r.changes === 0) return null
    evento(db, id, "lease_renovado", dono)
    return getCard(db, id)
  })
}

const ESTADO_POR_VERDICT: Record<Verdict, Estado> = { PASS: "feito", BLOCKED: "bloqueado", ISSUES: "falhou" }

export function concluirCard(
  id: string,
  dono: string,
  r: { verdict: Verdict; resultado: string },
  o?: Opts
): Card {
  const db = bd(o)
  return tx(db, () => {
    const c = getCard(db, id)
    if (!c) throw new Error(`card ${id} não existe`)
    if (c.estado !== "pego" || c.dono !== dono) throw new Error(`card ${id} não está pego por ${dono}`)
    const estado = ESTADO_POR_VERDICT[r.verdict]
    if (!estado) throw new Error(`verdict inválido: ${r.verdict}`)
    db.query("UPDATE cards SET estado=?, verdict=?, resultado=?, lease_ate=NULL, atualizado_em=? WHERE id=?").run(
      estado, r.verdict, r.resultado, agora(), id
    )
    evento(db, id, "concluido", dono, `${r.verdict}: ${r.resultado}`)
    return getCard(db, id)!
  })
}

/** Cards pegos com lease vencido voltam a aberto (gera evento). Devolve quantos. */
export function reconciliar(o?: Opts): number {
  const db = bd(o)
  return tx(db, () => {
    const t = agora()
    const vencidos = db
      .query("SELECT id, dono FROM cards WHERE estado='pego' AND lease_ate IS NOT NULL AND lease_ate < ?")
      .all(t) as { id: string; dono: string }[]
    for (const v of vencidos) {
      db.query("UPDATE cards SET estado='aberto', dono=NULL, lease_ate=NULL, atualizado_em=? WHERE id=?").run(t, v.id)
      evento(db, v.id, "lease_vencido", "sistema", `devolvido de ${v.dono}`)
    }
    return vencidos.length
  })
}

export function enviarMensagem(de: string, para: string, texto: string, o?: Opts): Mensagem {
  const db = bd(o)
  const r = db.query("INSERT INTO mensagens (de,para,texto,ts) VALUES (?,?,?,?)").run(de, para, texto, agora())
  return db.query("SELECT * FROM mensagens WHERE id=?").get(Number(r.lastInsertRowid)) as Mensagem
}

export function mensagens(f: { desde?: number; limite?: number } = {}, o?: Opts): Mensagem[] {
  const rows = bd(o)
    .query("SELECT * FROM mensagens WHERE id > ? ORDER BY id DESC LIMIT ?")
    .all(f.desde ?? 0, f.limite ?? 50) as Mensagem[]
  return rows.reverse()
}

export function eventosDe(card_id?: string, o?: Opts): Evento[] {
  const db = bd(o)
  return (card_id
    ? db.query("SELECT * FROM eventos WHERE card_id=? ORDER BY id").all(card_id)
    : db.query("SELECT * FROM eventos ORDER BY id").all()) as Evento[]
}

/** Export JSON de cada operação registrada em eventos. */
export function exportarEventosJson(card_id?: string, o?: Opts): string {
  return JSON.stringify(eventosDe(card_id, o), null, 2)
}

const corta = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

export function resumo(o?: Opts): string {
  const db = bd(o)
  const abertos = db.query("SELECT * FROM cards WHERE estado='aberto' ORDER BY prioridade DESC, CAST(SUBSTR(id,3) AS INTEGER)").all() as Card[]
  const pegos = db.query("SELECT * FROM cards WHERE estado='pego' ORDER BY CAST(SUBSTR(id,3) AS INTEGER)").all() as Card[]
  const msgs = mensagens({ limite: 5 }, o)
  const L: string[] = []
  L.push(`Quadro: ${abertos.length} aberto(s), ${pegos.length} pego(s).`)
  if (pegos.length) {
    L.push("Em andamento:")
    for (const c of pegos.slice(0, 10)) L.push(`- ${c.id} [${c.kit}] ${corta(c.titulo, 60)} (${c.dono})`)
  }
  if (abertos.length) {
    L.push("Abertos:")
    for (const c of abertos.slice(0, 10)) L.push(`- ${c.id} [${c.kit}] ${corta(c.titulo, 60)}`)
  }
  if (msgs.length) {
    L.push("Mensagens recentes:")
    for (const m of msgs) L.push(`- ${m.de}→${m.para}: ${corta(m.texto, 100)}`)
  }
  return corta(L.join("\n"), 1200)
}
