import type { Tabela } from "./processos.ts"

/**
 * LaunchAgents `dev.jarvis.*`, só para o /estado. As métricas de saúde deles
 * (jarvis_servico_*) são da sonda do backend; o coletor não as exporta.
 */

export const PREFIXO = "dev.jarvis."

export interface LinhaLaunchctl {
  readonly label: string
  readonly pid: number | null
  readonly ultimaSaida: number | null
}

/** `launchctl list`: `PID\tStatus\tLabel`, com `-` quando não há PID. */
export const parseLaunchctlList = (saida: string): Array<LinhaLaunchctl> => {
  const linhas: Array<LinhaLaunchctl> = []
  for (const linha of saida.split("\n")) {
    const partes = linha.split("\t")
    if (partes.length < 3) continue
    const label = partes[2]!.trim()
    if (!label.startsWith(PREFIXO)) continue
    const pid = /^\d+$/.test(partes[0]!.trim()) ? Number(partes[0]) : null
    const status = /^-?\d+$/.test(partes[1]!.trim()) ? Number(partes[1]) : null
    linhas.push({ label, pid, ultimaSaida: status })
  }
  return linhas
}

export interface DetalheLaunchctl {
  readonly estado: string | null
  readonly execucoes: number | null
  readonly pid: number | null
  readonly ultimaSaida: string | null
  /** `run interval = 60 seconds`: o launchd roda o serviço a cada N s (StartInterval). */
  readonly intervaloS: number | null
  readonly stdout: string | null
  readonly stderr: string | null
}

/** `launchctl print gui/<uid>/<label>`: só as chaves do primeiro nível do serviço. */
export const parseLaunchctlPrint = (saida: string): DetalheLaunchctl => {
  const campo = (nome: string) => new RegExp(`^\\t${nome} = (.+)$`, "m").exec(saida)?.[1]?.trim() ?? null
  const runs = campo("runs")
  const pid = campo("pid")
  const intervalo = /^(\d+) seconds?$/.exec(campo("run interval") ?? "")?.[1]
  return {
    estado: campo("state"),
    execucoes: runs !== null && /^\d+$/.test(runs) ? Number(runs) : null,
    pid: pid !== null && /^\d+$/.test(pid) ? Number(pid) : null,
    ultimaSaida: campo("last exit code"),
    intervaloS: intervalo !== undefined ? Number(intervalo) : null,
    stdout: campo("stdout path"),
    stderr: campo("stderr path")
  }
}

/** Agenda do plist: `StartInterval` (a cada N s) ou `StartCalendarInterval` (intervaloS nulo). */
export interface Agenda {
  readonly intervaloS: number | null
}

/** Lê a agenda de um plist XML; null quando o serviço não é periódico (fica no ar o tempo todo). */
export const parseAgendaPlist = (xml: string): Agenda | null => {
  const intervalo = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(xml)?.[1]
  if (intervalo !== undefined) return { intervaloS: Number(intervalo) }
  return /<key>StartCalendarInterval<\/key>/.test(xml) ? { intervaloS: null } : null
}

/**
 * Quando cada serviço periódico rodou pela última vez. O launchd não guarda a hora, então vale a
 * melhor pista: agora, se o processo está no ar; a coleta em que o `runs` subiu; ou o mtime dos logs.
 * Logs antigos não bastam logo depois que o coletor sobe (o serviço pode rodar sem escrever nada):
 * até observar um intervalo inteiro, uma pista anterior ao início da observação e mais velha que um
 * intervalo vira null (desconhecida), em vez de parecer atraso.
 */
export class RelogioExecucoes {
  private readonly vistos = new Map<string, { runs: number | null; em: number | null; desde: number }>()

  registrar(
    label: string,
    runs: number | null,
    rodando: boolean,
    logsMs: number | null,
    agora: number,
    intervaloS: number | null = null
  ): number | null {
    const antes = this.vistos.get(label)
    const desde = antes?.desde ?? agora
    let em = antes?.em ?? null
    if (rodando || (antes !== undefined && runs !== null && antes.runs !== null && runs > antes.runs)) em = agora
    if (logsMs !== null && (em === null || logsMs > em)) em = logsMs
    this.vistos.set(label, { runs, em, desde })
    if (em === null || intervaloS === null || em >= desde) return em
    const janela = (intervaloS + 15) * 1000
    return agora - desde < janela && agora - em > janela ? null : em
  }
}

export interface Servico {
  readonly label: string
  readonly carregado: boolean
  readonly vivo: boolean
  readonly pid: number | null
  /** Rodado pelo launchd a cada intervalo (StartInterval/StartCalendarInterval): sem PID entre execuções é o normal. */
  readonly periodico: boolean
  /** Intervalo do StartInterval, em segundos; null para não periódicos e StartCalendarInterval. */
  readonly intervalo_s: number | null
  /** Execuções menos a primeira, desde que o launchd carregou o serviço; null para os periódicos. */
  readonly reinicios: number | null
  /** "runs" do launchd: quantas vezes iniciou o serviço desde que o carregou. */
  readonly execucoes: number | null
  /** Só para os periódicos: ISO da última execução conhecida, ou null. */
  readonly ultima_execucao_em: string | null
  readonly ultima_saida: string | null
  readonly rss_bytes: number
  readonly cpu_pct: number
}

export const montarServicos = (
  plists: ReadonlyArray<string>,
  lista: ReadonlyArray<LinhaLaunchctl>,
  detalhes: ReadonlyMap<string, DetalheLaunchctl>,
  tabela: Tabela,
  opcoes: {
    readonly agendas?: ReadonlyMap<string, Agenda>
    /** mtime mais recente dos logs (stdout/stderr) de cada serviço, em ms. */
    readonly logsMs?: ReadonlyMap<string, number>
    readonly relogio?: RelogioExecucoes
    readonly agora?: number
  } = {}
): Array<Servico> => {
  const agora = opcoes.agora ?? Date.now()
  const porLabel = new Map(lista.map((l) => [l.label, l]))
  const labels = [...new Set([...plists, ...porLabel.keys()])].sort()
  return labels.map((label): Servico => {
    const linha = porLabel.get(label)
    const detalhe = detalhes.get(label)
    const pid = detalhe?.pid ?? linha?.pid ?? null
    const processo = pid !== null ? tabela.porPid.get(pid) : undefined
    const ultimaSaida = detalhe?.ultimaSaida ?? (linha?.ultimaSaida != null ? String(linha.ultimaSaida) : null)
    const vivo = pid !== null && processo !== undefined
    const agenda = opcoes.agendas?.get(label)
    const periodico = agenda !== undefined || detalhe?.intervaloS != null
    const execucoes = detalhe?.execucoes ?? null
    const intervaloS = detalhe?.intervaloS ?? agenda?.intervaloS ?? null
    const ultimaExecucao = periodico
      ? opcoes.relogio
        ? opcoes.relogio.registrar(label, execucoes, vivo, opcoes.logsMs?.get(label) ?? null, agora, intervaloS)
        : opcoes.logsMs?.get(label) ?? null
      : null
    return {
      label,
      carregado: linha !== undefined,
      vivo,
      pid,
      periodico,
      intervalo_s: intervaloS,
      reinicios: !periodico && execucoes !== null ? Math.max(0, execucoes - 1) : null,
      execucoes,
      ultima_execucao_em: ultimaExecucao !== null ? new Date(ultimaExecucao).toISOString() : null,
      ultima_saida: ultimaSaida,
      rss_bytes: processo?.rssBytes ?? 0,
      cpu_pct: processo?.cpuPct ?? 0
    }
  })
}
