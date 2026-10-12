import { nomeDoComando, type Processo, somar, type Tabela } from "./processos.ts"
import type { Subagente, SubagentesDaSessao } from "./subagentes.ts"

/**
 * O retrato do herdr vem de `herdr api snapshot` (socket do servidor). Ele não
 * traz PIDs: o processo de cada agente é achado na árvore do `herdr server`
 * (server → shell do pane → agente) pelo `HERDR_PANE_ID` no ambiente.
 */

export interface AgenteSnapshot {
  readonly agent?: string
  readonly agent_status?: string
  readonly name?: string
  readonly pane_id: string
  readonly workspace_id?: string
  readonly tab_id?: string
  readonly terminal_title_stripped?: string
}

export interface SnapshotHerdr {
  readonly version: string | null
  readonly workspaces: number
  readonly panes: number
  readonly agentes: ReadonlyArray<AgenteSnapshot>
}

const lista = (valor: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(valor) ? valor.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null) : []

const str = (valor: unknown): string | undefined => typeof valor === "string" && valor !== "" ? valor : undefined

/** Aceita a resposta inteira do CLI (`{result:{snapshot}}`) ou só o snapshot. */
export const parseSnapshot = (saida: string): SnapshotHerdr | undefined => {
  let raiz: unknown
  try {
    raiz = JSON.parse(saida)
  } catch {
    return undefined
  }
  if (typeof raiz !== "object" || raiz === null) return undefined
  const r = raiz as Record<string, unknown>
  const resultado = (r.result ?? r) as Record<string, unknown>
  const snap = (resultado.snapshot ?? resultado) as Record<string, unknown>
  if (!Array.isArray(snap.panes) && !Array.isArray(snap.agents)) return undefined
  const agentes: Array<AgenteSnapshot> = []
  for (const a of lista(snap.agents)) {
    const pane = str(a.pane_id)
    if (!pane) continue
    agentes.push({
      pane_id: pane,
      ...(str(a.agent) ? { agent: str(a.agent)! } : {}),
      ...(str(a.agent_status) ? { agent_status: str(a.agent_status)! } : {}),
      ...(str(a.name) ? { name: str(a.name)! } : {}),
      ...(str(a.workspace_id) ? { workspace_id: str(a.workspace_id)! } : {}),
      ...(str(a.tab_id) ? { tab_id: str(a.tab_id)! } : {}),
      ...(str(a.terminal_title_stripped) ? { terminal_title_stripped: str(a.terminal_title_stripped)! } : {})
    })
  }
  return {
    version: str(snap.version) ?? null,
    workspaces: lista(snap.workspaces).length,
    panes: lista(snap.panes).length,
    agentes
  }
}

export interface UsoProcessos {
  readonly quantidade: number
  readonly rss_bytes: number
  readonly cpu_pct: number
}

export interface AgenteHerdr {
  /** Nome do agente no herdr; sem nome, `<tipo>@<pane>`. */
  readonly nome: string
  readonly tipo: string
  readonly pane: string
  readonly workspace: string | null
  readonly tab: string | null
  readonly titulo: string | null
  /** idle, working, blocked, done ou unknown, como o herdr informa. */
  readonly estado: string
  readonly desde: string
  readonly segundos_no_estado: number
  /** false quando o coletor pegou o agente já nesse estado: `desde` é então a primeira vez que o viu. */
  readonly desde_exato: boolean
  readonly pid: number | null
  readonly comando: string | null
  readonly rss_bytes: number
  readonly cpu_pct: number
  readonly filhos: UsoProcessos
  /** sessionId do Claude Code que roda no pane; null quando não é Claude ou não deu para ligar. */
  readonly sessao: string | null
  /** Rodando primeiro, depois os mais recentes; no máximo 30. */
  readonly subagentes: ReadonlyArray<Subagente>
}

/** Acha a sessão e os subagentes do processo de um agente. */
export type BuscarSubagentes = (pid: number | null, nomeAgente: string, agora: number) => SubagentesDaSessao

const semSubagentes: BuscarSubagentes = () => ({ sessao: null, subagentes: [] })

export interface EstadoHerdr {
  readonly vivo: boolean
  readonly versao: string | null
  readonly servidor_pid: number | null
  readonly workspaces: number
  readonly panes: number
  readonly agentes: ReadonlyArray<AgenteHerdr>
  readonly erro: string | null
}

export const herdrFora = (erro: string): EstadoHerdr => ({
  vivo: false,
  versao: null,
  servidor_pid: null,
  workspaces: 0,
  panes: 0,
  agentes: [],
  erro
})

/** Lembra desde quando cada agente está no estado atual. */
export class Rastreador {
  private readonly estados = new Map<string, { estado: string; desde: number; exato: boolean }>()
  private primeiraPassada = true

  observar(chave: string, estado: string, agora: number): { desde: number; exato: boolean } {
    const anterior = this.estados.get(chave)
    if (anterior && anterior.estado === estado) return anterior
    const novo = { estado, desde: agora, exato: anterior !== undefined || !this.primeiraPassada }
    this.estados.set(chave, novo)
    return novo
  }

  /** Fecha uma passada: esquece quem sumiu. Agentes que aparecem depois da primeira passada têm `desde` exato. */
  manter(chaves: ReadonlySet<string>): void {
    for (const chave of [...this.estados.keys()]) if (!chaves.has(chave)) this.estados.delete(chave)
    this.primeiraPassada = false
  }
}

export const ehServidorHerdr = (p: Processo): boolean => /(^|\/)herdr\s+server(\s|$)/.test(p.comando)

/** Os PIDs cujo ambiente precisa ser lido: shells dos panes e os filhos diretos deles. */
export const pidsParaAmbiente = (tabela: Tabela, servidor: number): Array<number> =>
  tabela.filhos(servidor).flatMap((shell) => [shell.pid, ...tabela.filhos(shell.pid).map((p) => p.pid)])

/** O processo do agente no pane: filho do shell do pane, de preferência com o nome do tipo do agente. */
export const processoDoAgente = (
  tabela: Tabela,
  servidor: number,
  panePorPid: ReadonlyMap<number, string>,
  pane: string,
  tipo: string
): Processo | undefined => {
  for (const shell of tabela.filhos(servidor)) {
    const filhos = tabela.filhos(shell.pid)
    const doPane = panePorPid.get(shell.pid) === pane || filhos.some((f) => panePorPid.get(f.pid) === pane)
    if (!doPane) continue
    const candidatos = filhos.filter((f) => !panePorPid.has(f.pid) || panePorPid.get(f.pid) === pane)
    if (candidatos.length === 0) return undefined
    const t = tipo.toLowerCase()
    return candidatos.find((c) => t !== "" && nomeDoComando(c.comando).toLowerCase().includes(t))
      ?? [...candidatos].sort((a, b) => b.rssBytes - a.rssBytes)[0]
  }
  return undefined
}

export const montarHerdr = (
  snapshot: SnapshotHerdr,
  tabela: Tabela,
  panePorPid: ReadonlyMap<number, string>,
  rastreador: Rastreador,
  agora: number,
  buscarSubagentes: BuscarSubagentes = semSubagentes
): EstadoHerdr => {
  const servidor = tabela.encontrar(ehServidorHerdr)
  const chaves = new Set<string>()
  const nomesUsados = new Set<string>()
  const agentes = snapshot.agentes.map((a): AgenteHerdr => {
    const tipo = a.agent ?? "desconhecido"
    let nome = a.name ?? `${tipo}@${a.pane_id}`
    if (nomesUsados.has(nome)) nome = `${nome}@${a.pane_id}`
    nomesUsados.add(nome)
    const estado = a.agent_status ?? "unknown"
    const chave = `${a.pane_id}|${nome}`
    chaves.add(chave)
    const { desde, exato } = rastreador.observar(chave, estado, agora)
    const processo = servidor ? processoDoAgente(tabela, servidor.pid, panePorPid, a.pane_id, tipo) : undefined
    let doClaude: SubagentesDaSessao
    try {
      doClaude = buscarSubagentes(processo?.pid ?? null, nome, agora)
    } catch {
      doClaude = { sessao: null, subagentes: [] }
    }
    const filhos = processo ? somar(tabela.descendentes(processo.pid)) : { processos: 0, rssBytes: 0, cpuPct: 0 }
    return {
      nome,
      tipo,
      pane: a.pane_id,
      workspace: a.workspace_id ?? null,
      tab: a.tab_id ?? null,
      titulo: a.terminal_title_stripped ?? null,
      estado,
      desde: new Date(desde).toISOString(),
      segundos_no_estado: Math.max(0, Math.round((agora - desde) / 1000)),
      desde_exato: exato,
      pid: processo?.pid ?? null,
      comando: processo ? nomeDoComando(processo.comando) : null,
      rss_bytes: processo?.rssBytes ?? 0,
      cpu_pct: processo?.cpuPct ?? 0,
      filhos: { quantidade: filhos.processos, rss_bytes: filhos.rssBytes, cpu_pct: filhos.cpuPct },
      sessao: doClaude.sessao,
      subagentes: doClaude.subagentes
    }
  })
  rastreador.manter(chaves)
  return {
    vivo: true,
    versao: snapshot.version,
    servidor_pid: servidor?.pid ?? null,
    workspaces: snapshot.workspaces,
    panes: snapshot.panes,
    agentes,
    erro: null
  }
}
