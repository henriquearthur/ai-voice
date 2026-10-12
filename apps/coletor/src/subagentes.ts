import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/**
 * Subagentes do Claude Code de cada sessão, com a mesma lógica do hook
 * `~/.claude/hooks/status/status.ts` (que não é importado nem alterado):
 *
 * - `~/.claude/sessions/<pid>.json` liga o processo do agente do herdr ao `sessionId`;
 * - `~/.claude/agent-ledger/<sessão>.jsonl` (gravado pelo hook) dá início, fim,
 *   retomadas, o fim da última mensagem e as tarefas em background do último turno;
 * - `<projeto>/<sessão>/subagents/agent-<id>.meta.json` dá descrição, tipo e o pai
 *   (`parentAgentId`) de quem foi lançado por outro subagente;
 * - `agent-<id>.jsonl` (transcript do subagente) dá a última escrita, a ferramenta
 *   pendente e o relatório do SubagentHandback.
 *
 * Tudo é lido de forma incremental: o ledger e os transcripts por deslocamento
 * (só os bytes novos), os `.meta.json` uma vez só, e os `sessions/*.json` só
 * quando o mtime muda. Transcript grande começa pelos últimos 512 KiB.
 */

export type EstadoSubagente = "rodando" | "terminou" | "parado"

export interface Subagente {
  readonly id: string
  readonly descricao: string
  readonly tipo: string
  readonly estado: EstadoSubagente
  readonly inicio: string
  readonly fim: string | null
  readonly duracao_s: number
  readonly ultima_atividade_em: string | null
  /** Ferramenta pendente e resumo curto, até 80 caracteres. */
  readonly aguardando: string | null
  /** Relatório do fim, até 160 caracteres. */
  readonly resumo_fim: string | null
  /** Id do subagente que lançou este; null quando foi a sessão principal. */
  readonly pai_id: string | null
  /** Quem abriu: o nome do agente do herdr ou a descrição do subagente pai. */
  readonly aberto_por: string
}

export interface SubagentesDaSessao {
  readonly sessao: string | null
  readonly subagentes: ReadonlyArray<Subagente>
}

export const MAX_SUBAGENTES = 30
const OCIOSO_MS = 8 * 60 * 1000
const JANELA_INICIAL = 512 * 1024
const LEITURA_MAXIMA = 4 * 1024 * 1024

// ---------- texto ----------

const umaLinha = (s: string) => s.replace(/\s+/g, " ").trim()

/** Tira o que parece segredo: atribuições a *TOKEN/KEY/SECRET*, Bearer, chaves com prefixo conhecido, senha em URL. */
export const semSegredo = (s: string): string =>
  s
    .replace(/\b(Bearer|Basic|Token)\s+[\w.~+/=-]{6,}/gi, "$1 ***")
    .replace(/(\b[\w-]*(?:token|secret|senha|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth|credential|cookie)[\w-]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, "$1***")
    .replace(/(--?(?:token|secret|password|passwd|senha|api-key|key|auth)[= ]+)\S+/gi, "$1***")
    .replace(/\b(?:sk|pk|rk)-[\w-]{10,}/g, "***")
    .replace(/\b(?:ghp|gho|ghs|ghu|github_pat|glpat|xox[abprs]|AKIA|ASIA|AIza)[\w-]{10,}/g, "***")
    .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+/g, "***")
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1***@")
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, "***")
    // base64 longo com letras e dígitos misturados (caminho com / ou - não casa)
    .replace(/(?<![\w/-])(?=[A-Za-z0-9+]*\d)(?=[A-Za-z0-9+]*[A-Z])(?=[A-Za-z0-9+]*[a-z])[A-Za-z0-9+]{40,}={0,2}/g, "***")

export const cortar = (s: string, max: number): string => {
  const t = umaLinha(semSegredo(s))
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

// ---------- leitura incremental ----------

/** Lê só as linhas novas de um arquivo que só cresce; a primeira leitura pode começar pelos últimos `janela` bytes. */
class Leitor {
  private deslocamento = -1
  private inode = -1
  private resto = ""
  private pularPrimeira = false
  tamanho = 0
  mtime = 0

  constructor(readonly caminho: string, private readonly janela = Number.POSITIVE_INFINITY) {}

  private posicionar(deslocamento: number): void {
    this.deslocamento = deslocamento
    this.resto = ""
    this.pularPrimeira = deslocamento > 0 // começou no meio de uma linha
  }

  /** Linhas novas, ou undefined quando o arquivo não existe. `reiniciou` avisa que o estado anterior deve ser descartado. */
  ler(): { linhas: Array<string>; reiniciou: boolean } | undefined {
    let fd: number
    try {
      fd = openSync(this.caminho, "r")
    } catch {
      return undefined
    }
    try {
      const info = fstatSync(fd)
      this.mtime = info.mtimeMs
      this.tamanho = info.size
      let reiniciou = false
      if (this.deslocamento < 0 || info.ino !== this.inode || info.size < this.deslocamento) {
        reiniciou = true
        this.inode = info.ino
        this.posicionar(Math.max(0, info.size - this.janela))
      } else if (info.size - this.deslocamento > LEITURA_MAXIMA) {
        // Atrasado demais: pula para o fim em vez de ler tudo.
        reiniciou = true
        this.posicionar(info.size - Math.min(this.janela, LEITURA_MAXIMA))
      }
      if (info.size === this.deslocamento) return { linhas: [], reiniciou }
      const tamanho = info.size - this.deslocamento
      const buffer = Buffer.alloc(tamanho)
      const lidos = readSync(fd, buffer, 0, tamanho, this.deslocamento)
      this.deslocamento += lidos
      const linhas = (this.resto + buffer.subarray(0, lidos).toString("utf8")).split("\n")
      this.resto = linhas.pop() ?? ""
      if (this.pularPrimeira && linhas.length > 0) {
        linhas.shift()
        this.pularPrimeira = false
      }
      return { linhas: linhas.filter((l) => l !== ""), reiniciou }
    } finally {
      closeSync(fd)
    }
  }
}

const json = (linha: string): any => {
  try {
    return JSON.parse(linha)
  } catch {
    return undefined
  }
}
const lista = (x: unknown): Array<any> => (Array.isArray(x) ? x : [])
const normId = (id: string) => id.replace(/^agent-/, "")

// ---------- ledger ----------

interface RegistroLedger {
  id: string
  tipo: string
  inicio: number
  fim?: number
  cauda?: string
  tx?: string
}

interface TarefaBg {
  readonly id?: string
}

class Ledger {
  readonly agentes = new Map<string, RegistroLedger>()
  ultimoBg: { t: number; ids: Set<string> } | undefined
  /** Transcript da sessão principal, tirado de um evento de início. */
  transcriptSessao: string | undefined
  private readonly leitor: Leitor

  constructor(caminho: string) {
    this.leitor = new Leitor(caminho)
  }

  atualizar(): void {
    const r = this.leitor.ler()
    if (!r) return
    if (r.reiniciou) {
      this.agentes.clear()
      this.ultimoBg = undefined
    }
    for (const linha of r.linhas) {
      const e = json(linha)
      if (!e || typeof e.t !== "number") continue
      if (e.ev === "start" && typeof e.id === "string") {
        const id = normId(e.id)
        if (typeof e.tx === "string") this.transcriptSessao = e.tx
        const a = this.agentes.get(id)
        if (a) {
          delete a.fim
          continue
        }
        const tx = typeof e.tx === "string"
          ? join(dirname(e.tx), basename(e.tx, ".jsonl"), "subagents", `agent-${id}.jsonl`)
          : undefined
        this.agentes.set(id, { id, tipo: String(e.type ?? "?"), inicio: e.t, ...(tx ? { tx } : {}) })
      } else if (e.ev === "stop" && typeof e.id === "string") {
        const id = normId(e.id)
        const a: RegistroLedger = this.agentes.get(id) ?? { id, tipo: String(e.type ?? "?"), inicio: e.t }
        a.fim = e.t
        if (typeof e.tail === "string") a.cauda = e.tail
        if (typeof e.tx === "string") a.tx = e.tx
        this.agentes.set(id, a)
      } else if (e.ev === "bg") {
        const ids = new Set<string>()
        for (const b of lista(e.tasks) as Array<TarefaBg>) if (typeof b.id === "string") ids.add(normId(b.id))
        this.ultimoBg = { t: e.t, ids }
      }
    }
  }
}

// ---------- transcript do subagente ----------

interface Pendente {
  readonly ferramenta: string
  readonly resumo: string
}

const resumoDaEntrada = (entrada: any): string => {
  if (!entrada || typeof entrada !== "object") return ""
  for (const campo of ["command", "description", "file_path", "pattern", "url", "query", "path", "prompt"]) {
    const v = entrada[campo]
    if (typeof v === "string" && v.trim() !== "") return v
  }
  return ""
}

class Sonda {
  readonly pendentes = new Map<string, Pendente>()
  relatorio: string | undefined
  private readonly leitor: Leitor

  constructor(caminho: string) {
    this.leitor = new Leitor(caminho, JANELA_INICIAL)
  }

  get mtime(): number | undefined {
    return this.leitor.mtime || undefined
  }

  atualizar(): boolean {
    const r = this.leitor.ler()
    if (!r) return false
    if (r.reiniciou) {
      this.pendentes.clear()
      this.relatorio = undefined
    }
    for (const linha of r.linhas) {
      // Só as linhas com chamada ou resultado de ferramenta interessam; o resto nem é parseado.
      if (!linha.includes("\"tool_use") && !linha.includes("\"tool_result")) continue
      const l = json(linha)
      for (const c of lista(l?.message?.content)) {
        if (c?.type === "tool_result" && typeof c.tool_use_id === "string") this.pendentes.delete(c.tool_use_id)
        else if (c?.type === "tool_use" && typeof c.id === "string") {
          const nome = String(c.name ?? "?")
          if (nome === "SubagentHandback") this.relatorio = String(c.input?.message ?? "")
          this.pendentes.set(c.id, { ferramenta: nome, resumo: resumoDaEntrada(c.input) })
        }
      }
    }
    return true
  }

  /** A última ferramenta chamada que ainda não teve resultado. */
  aguardando(): string | null {
    const ultima = [...this.pendentes.values()].at(-1)
    if (!ultima) return null
    return cortar(ultima.resumo ? `${ultima.ferramenta}: ${ultima.resumo}` : ultima.ferramenta, 80)
  }
}

// ---------- meta ----------

interface Meta {
  readonly descricao?: string
  readonly tipo?: string
  readonly pai?: string
  readonly criado: number
}

const lerMeta = (caminho: string): Meta | undefined => {
  try {
    const m = JSON.parse(readFileSync(caminho, "utf8"))
    const st = statSync(caminho)
    return {
      ...(typeof m.description === "string" && m.description ? { descricao: m.description } : {}),
      ...(typeof m.agentType === "string" && m.agentType ? { tipo: m.agentType } : {}),
      ...(typeof m.parentAgentId === "string" && m.parentAgentId ? { pai: normId(m.parentAgentId) } : {}),
      criado: st.birthtimeMs || st.mtimeMs
    }
  } catch {
    return undefined
  }
}

// ---------- sessão ----------

interface CacheSessao {
  readonly ledger: Ledger
  readonly metas: Map<string, Meta>
  readonly sondas: Map<string, Sonda>
  dirSubagentes: string | undefined
  procurouEm: number
}

export interface OpcoesSubagentes {
  /** Raiz do Claude Code, normalmente `~/.claude`. */
  readonly claudeDir: string
  readonly maximo?: number
  readonly ociosoMs?: number
}

export class LeitorSubagentes {
  private readonly sessoesPorPid = new Map<number, { mtime: number; sessao: string | null }>()
  private readonly sessoes = new Map<string, CacheSessao>()
  private usadas = new Set<string>()
  private readonly maximo: number
  private readonly ociosoMs: number

  constructor(private readonly opcoes: OpcoesSubagentes) {
    this.maximo = opcoes.maximo ?? MAX_SUBAGENTES
    this.ociosoMs = opcoes.ociosoMs ?? OCIOSO_MS
  }

  /** O `sessionId` do processo do Claude Code, por `~/.claude/sessions/<pid>.json`. */
  sessaoDoPid(pid: number): string | null {
    const caminho = join(this.opcoes.claudeDir, "sessions", `${pid}.json`)
    let mtime: number
    try {
      mtime = statSync(caminho).mtimeMs
    } catch {
      this.sessoesPorPid.delete(pid)
      return null
    }
    const cache = this.sessoesPorPid.get(pid)
    if (cache && cache.mtime === mtime) return cache.sessao
    let sessao: string | null = null
    try {
      const s = JSON.parse(readFileSync(caminho, "utf8"))
      if (typeof s.sessionId === "string" && /^[\w-]+$/.test(s.sessionId) && (s.pid === undefined || s.pid === pid)) {
        sessao = s.sessionId
      }
    } catch {
      // arquivo sendo reescrito: tenta de novo na próxima passada
      return cache?.sessao ?? null
    }
    this.sessoesPorPid.set(pid, { mtime, sessao })
    return sessao
  }

  /** Sessão e subagentes do agente do herdr cujo processo é `pid`. */
  doAgente(pid: number | null, nomeAgente: string, agora: number): SubagentesDaSessao {
    if (pid === null) return { sessao: null, subagentes: [] }
    const sessao = this.sessaoDoPid(pid)
    if (!sessao) return { sessao: null, subagentes: [] }
    return { sessao, subagentes: this.daSessao(sessao, nomeAgente, agora) }
  }

  /** Fecha uma passada: esquece o cache de sessões e PIDs que não apareceram nela. */
  manter(pids: ReadonlySet<number>): void {
    for (const pid of [...this.sessoesPorPid.keys()]) if (!pids.has(pid)) this.sessoesPorPid.delete(pid)
    for (const s of [...this.sessoes.keys()]) if (!this.usadas.has(s)) this.sessoes.delete(s)
    this.usadas = new Set()
  }

  daSessao(sessao: string, abertoPorRaiz: string, agora: number): Array<Subagente> {
    this.usadas.add(sessao)
    let c = this.sessoes.get(sessao)
    if (!c) {
      c = {
        ledger: new Ledger(join(this.opcoes.claudeDir, "agent-ledger", `${sessao.replace(/[^\w-]/g, "_")}.jsonl`)),
        metas: new Map(),
        sondas: new Map(),
        dirSubagentes: undefined,
        procurouEm: 0
      }
      this.sessoes.set(sessao, c)
    }
    c.ledger.atualizar()
    this.acharDir(c, sessao, agora)
    this.lerMetas(c)

    const ids = new Set<string>([...c.ledger.agentes.keys(), ...c.metas.keys()])
    const caminhoTx = (id: string) =>
      c.dirSubagentes ? join(c.dirSubagentes, `agent-${id}.jsonl`) : c.ledger.agentes.get(id)?.tx
    const sonda = (id: string): Sonda | undefined => {
      const tx = caminhoTx(id)
      if (!tx) return undefined
      let s = c.sondas.get(id)
      if (!s) {
        s = new Sonda(tx)
        c.sondas.set(id, s)
      }
      return s.atualizar() ? s : undefined
    }

    interface Linha {
      id: string
      inicio: number
      fim?: number
      estado: EstadoSubagente
      sonda?: Sonda
    }
    const linhas: Array<Linha> = []
    for (const id of ids) {
      const reg = c.ledger.agentes.get(id)
      const meta = c.metas.get(id)
      const inicio = reg?.inicio ?? meta?.criado ?? agora
      if (reg?.fim !== undefined) {
        linhas.push({ id, inicio, fim: reg.fim, estado: "terminou" })
        continue
      }
      linhas.push({ id, inicio, estado: "rodando" })
    }
    // Só os abertos mais recentes são sondados agora; os terminados, depois do corte.
    linhas.sort((a, b) => b.inicio - a.inicio)
    let sondados = 0
    for (const l of linhas) {
      if (l.estado !== "rodando") continue
      const s = sondados++ < this.maximo * 2 ? sonda(l.id) : undefined
      if (s) l.sonda = s
      const bg = c.ledger.ultimoBg
      if (s?.relatorio !== undefined) {
        l.estado = "terminou"
        l.fim = s.mtime ?? agora
      } else if (c.ledger.agentes.has(l.id) && bg && bg.t > l.inicio && !bg.ids.has(l.id)) {
        l.estado = "parado" // sem registro de fim e fora das tarefas em background do último turno
      } else if (!s?.mtime || agora - s.mtime >= this.ociosoMs) {
        l.estado = "parado" // nenhuma escrita no transcript há muito tempo
      }
    }
    const ordem = (e: EstadoSubagente) => (e === "rodando" ? 0 : 1)
    linhas.sort((a, b) => ordem(a.estado) - ordem(b.estado) || b.inicio - a.inicio)
    const escolhidas = linhas.slice(0, this.maximo)

    // Sondas de quem não foi sondado nem escolhido não precisam ficar na memória.
    const manter = new Set([...escolhidas.map((l) => l.id), ...linhas.filter((l) => l.sonda).map((l) => l.id)])
    for (const id of [...c.sondas.keys()]) if (!manter.has(id)) c.sondas.delete(id)

    return escolhidas.map((l): Subagente => {
      const reg = c.ledger.agentes.get(l.id)
      const meta = c.metas.get(l.id)
      const s = l.sonda ?? sonda(l.id)
      const pai = meta?.pai ?? null
      const relatorio = s?.relatorio
      const resumoFim = l.estado !== "terminou"
        ? null
        : relatorio
        ? cortar(relatorio, 160)
        : reg?.cauda
        ? cortar(umaLinha(reg.cauda).slice(-160), 160)
        : null
      const fim = l.fim ?? null
      return {
        id: l.id,
        descricao: meta?.descricao ?? l.id.slice(0, 8),
        tipo: reg?.tipo ?? meta?.tipo ?? "?",
        estado: l.estado,
        inicio: new Date(l.inicio).toISOString(),
        fim: fim === null ? null : new Date(fim).toISOString(),
        duracao_s: Math.max(0, Math.round(((fim ?? agora) - l.inicio) / 1000)),
        ultima_atividade_em: s?.mtime ? new Date(s.mtime).toISOString() : null,
        aguardando: l.estado === "terminou" ? null : s?.aguardando() ?? null,
        resumo_fim: resumoFim,
        pai_id: pai,
        aberto_por: pai ? c.metas.get(pai)?.descricao ?? pai.slice(0, 8) : abertoPorRaiz
      }
    })
  }

  /** `<projeto>/<sessão>/subagents`: pelo ledger ou procurando `projects/*\/<sessão>.jsonl` (no máximo a cada minuto). */
  private acharDir(c: CacheSessao, sessao: string, agora: number): void {
    if (c.dirSubagentes) return
    const tx = c.ledger.transcriptSessao
    if (tx) {
      c.dirSubagentes = join(dirname(tx), basename(tx, ".jsonl"), "subagents")
      return
    }
    if (agora - c.procurouEm < 60_000) return
    c.procurouEm = agora
    const projetos = join(this.opcoes.claudeDir, "projects")
    try {
      for (const p of readdirSync(projetos)) {
        const dir = join(projetos, p, sessao)
        try {
          if (statSync(dir).isDirectory()) {
            c.dirSubagentes = join(dir, "subagents")
            return
          }
        } catch {
          // não é deste projeto
        }
      }
    } catch {
      // sem projects
    }
  }

  private lerMetas(c: CacheSessao): void {
    if (!c.dirSubagentes) return
    let nomes: Array<string>
    try {
      nomes = readdirSync(c.dirSubagentes)
    } catch {
      return
    }
    for (const nome of nomes) {
      if (!nome.endsWith(".meta.json")) continue
      const id = normId(nome.slice(0, -".meta.json".length))
      if (c.metas.has(id)) continue
      const meta = lerMeta(join(c.dirSubagentes, nome))
      if (meta) c.metas.set(id, meta)
    }
  }
}
