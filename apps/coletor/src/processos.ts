/**
 * Tabela de processos a partir do `ps`, com a árvore pai → filhos.
 *
 * `ps -A -o pid=,ppid=,rss=,%cpu=,args=`: rss em KiB, %cpu é a média recente
 * do próprio ps (pode passar de 100 com vários núcleos).
 */

export interface Processo {
  readonly pid: number
  readonly ppid: number
  readonly rssBytes: number
  readonly cpuPct: number
  readonly comando: string
}

export const PS_ARGS = ["-A", "-o", "pid=,ppid=,rss=,%cpu=,args="] as const

export const parsePs = (saida: string): Array<Processo> => {
  const processos: Array<Processo> = []
  for (const linha of saida.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(.*)$/.exec(linha)
    if (!m) continue
    processos.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssBytes: Number(m[3]) * 1024,
      cpuPct: Number(m[4]!.replace(",", ".")),
      comando: m[5]!.trim()
    })
  }
  return processos
}

/** Nome curto do executável: `/Users/x/.local/bin/claude --resume` → `claude`, `-zsh` → `zsh`. */
export const nomeDoComando = (comando: string): string => {
  const primeiro = comando.split(/\s+/)[0] ?? ""
  return (primeiro.split("/").pop() ?? primeiro).replace(/^-/, "")
}

export class Tabela {
  readonly porPid = new Map<number, Processo>()
  private readonly filhosDe = new Map<number, Array<Processo>>()

  constructor(processos: ReadonlyArray<Processo>) {
    for (const p of processos) {
      this.porPid.set(p.pid, p)
      const irmaos = this.filhosDe.get(p.ppid)
      if (irmaos) irmaos.push(p)
      else this.filhosDe.set(p.ppid, [p])
    }
  }

  filhos(pid: number): ReadonlyArray<Processo> {
    return this.filhosDe.get(pid) ?? []
  }

  /** Todos os descendentes de `pid`, sem ele mesmo. */
  descendentes(pid: number): Array<Processo> {
    const saida: Array<Processo> = []
    const vistos = new Set<number>([pid])
    const fila = [...this.filhos(pid)]
    while (fila.length > 0) {
      const p = fila.shift()!
      if (vistos.has(p.pid)) continue
      vistos.add(p.pid)
      saida.push(p)
      fila.push(...this.filhos(p.pid))
    }
    return saida
  }

  encontrar(predicado: (p: Processo) => boolean): Processo | undefined {
    for (const p of this.porPid.values()) if (predicado(p)) return p
    return undefined
  }
}

export interface Uso {
  readonly processos: number
  readonly rssBytes: number
  readonly cpuPct: number
}

export const somar = (processos: ReadonlyArray<Processo>): Uso => ({
  processos: processos.length,
  rssBytes: processos.reduce((s, p) => s + p.rssBytes, 0),
  cpuPct: Math.round(processos.reduce((s, p) => s + p.cpuPct, 0) * 10) / 10
})

/**
 * `ps -ww -E -o pid=,command= -p …` imprime o ambiente depois do comando; daqui
 * só sai o `HERDR_PANE_ID` de cada processo (o resto do ambiente é ignorado).
 */
export const parsePanePorPid = (saida: string): Map<number, string> => {
  const mapa = new Map<number, string>()
  for (const linha of saida.split("\n")) {
    const pid = /^\s*(\d+)\s/.exec(linha)
    const pane = /(?:^|\s)HERDR_PANE_ID=(\S+)/.exec(linha)
    if (pid && pane) mapa.set(Number(pid[1]), pane[1]!)
  }
  return mapa
}
