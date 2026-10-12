/**
 * Tabela de processos a partir do `ps -axo pid,ppid,pgid,stat,etime,%cpu,rss,uid,command`.
 * (A coluna `uid` é a única além das pedidas: garante que só se mexe em processo do dono.)
 */

export interface Proc {
  readonly pid: number
  readonly ppid: number
  readonly pgid: number
  readonly stat: string
  /** Idade em segundos (de `etime`). */
  readonly idadeS: number
  readonly cpuPct: number
  readonly rssBytes: number
  readonly uid: number
  readonly comando: string
}

export const PS_ARGS = ["-axo", "pid,ppid,pgid,stat,etime,%cpu,rss,uid,command"] as const

/** `[[dd-]hh:]mm:ss` em segundos; NaN se não for etime. */
export const parseEtime = (texto: string): number => {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(texto)
  if (!m) return Number.NaN
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4])
}

export const parsePs = (saida: string): Array<Proc> => {
  const lista: Array<Proc> = []
  for (const linha of saida.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.,]+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(linha)
    if (!m) continue
    const idadeS = parseEtime(m[5]!)
    if (Number.isNaN(idadeS)) continue
    lista.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      stat: m[4]!,
      idadeS,
      cpuPct: Number(m[6]!.replace(",", ".")),
      rssBytes: Number(m[7]) * 1024,
      uid: Number(m[8]),
      comando: m[9]!.trim()
    })
  }
  return lista
}

/** Primeiro token do comando (o executável, como o `ps` mostra). */
export const argv0 = (comando: string): string => comando.split(/\s+/)[0] ?? ""

export const nomeBase = (comando: string): string => {
  const a = argv0(comando)
  return (a.split("/").pop() ?? a).replace(/^-/, "")
}
