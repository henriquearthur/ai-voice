import { Config, Duration, Effect, Schema } from "effect"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { LeitorSubagentes } from "./subagentes.ts"
import { herdrFora, type EstadoHerdr, montarHerdr, parseSnapshot, pidsParaAmbiente, ehServidorHerdr, Rastreador } from "./herdr.ts"
import { parsePanePorPid, parsePs, PS_ARGS, Tabela } from "./processos.ts"
import {
  type Agenda,
  type DetalheLaunchctl,
  montarServicos,
  parseAgendaPlist,
  parseLaunchctlList,
  parseLaunchctlPrint,
  PREFIXO,
  type RelogioExecucoes,
  type Servico
} from "./servicos.ts"

export const ColetorConfig = Config.all({
  eventos: Config.String("JARVIS_ESCUTA_EVENTOS").pipe(
    Config.withDefault(join(homedir(), ".local/share/jarvis/escuta/logs/escuta.events.jsonl"))
  ),
  herdr: Config.String("JARVIS_HERDR").pipe(Config.withDefault(join(homedir(), ".local/bin/herdr"))),
  porta: Config.Int("JARVIS_COLETOR_PORTA").pipe(Config.withDefault(7352)),
  intervaloMs: Config.Int("JARVIS_COLETOR_INTERVALO_MS").pipe(Config.withDefault(5000)),
  launchAgents: Config.String("JARVIS_LAUNCHAGENTS_DIR").pipe(
    Config.withDefault(join(homedir(), "Library/LaunchAgents"))
  ),
  servicos: Config.Boolean("JARVIS_COLETOR_SERVICOS").pipe(Config.withDefault(true)),
  claudeDir: Config.String("JARVIS_CLAUDE_DIR").pipe(Config.withDefault(join(homedir(), ".claude")))
})
export type ColetorConfig = Config.Success<typeof ColetorConfig>

export class ComandoFalhou extends Schema.TaggedError<ComandoFalhou>()("ComandoFalhou", {
  comando: Schema.String,
  motivo: Schema.String
}) {}

/** Roda um comando e devolve a saída padrão; código ≠ 0 ou estouro de tempo viram ComandoFalhou. */
export const rodar = (comando: string, args: ReadonlyArray<string>, timeout = Duration.seconds(4)) =>
  Effect.tryPromise({
    try: async (signal) => {
      const proc = Bun.spawn([comando, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", signal })
      const [saida, erro, codigo] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited
      ])
      if (codigo !== 0) throw new Error(`saiu com ${codigo}: ${erro.trim().slice(0, 200)}`)
      return saida
    },
    catch: (e) => new ComandoFalhou({ comando, motivo: e instanceof Error ? e.message : String(e) })
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(new ComandoFalhou({ comando, motivo: "tempo esgotado" }))
    })
  )

export const lerProcessos = rodar("/bin/ps", [...PS_ARGS]).pipe(Effect.map((s) => new Tabela(parsePs(s))))

const lerPanes = (pids: ReadonlyArray<number>) =>
  pids.length === 0
    ? Effect.succeed(new Map<number, string>())
    : rodar("/bin/ps", ["-ww", "-E", "-o", "pid=,command=", "-p", pids.join(",")]).pipe(
      Effect.map(parsePanePorPid),
      // ps sai com 1 se algum PID morreu no meio; sem o mapa, o agente só fica sem processo.
      Effect.orElseSucceed(() => new Map<number, string>())
    )

export const coletarHerdr = (
  herdr: string,
  tabela: Tabela,
  rastreador: Rastreador,
  subagentes?: LeitorSubagentes
): Effect.Effect<EstadoHerdr> =>
  Effect.gen(function*() {
    const saida = yield* rodar(herdr, ["api", "snapshot"])
    const snapshot = parseSnapshot(saida)
    if (!snapshot) return herdrFora("resposta do herdr sem snapshot")
    const servidor = tabela.encontrar(ehServidorHerdr)
    const panePorPid = servidor ? yield* lerPanes(pidsParaAmbiente(tabela, servidor.pid)) : new Map<number, string>()
    if (!subagentes) return montarHerdr(snapshot, tabela, panePorPid, rastreador, Date.now())
    const estado = montarHerdr(
      snapshot,
      tabela,
      panePorPid,
      rastreador,
      Date.now(),
      (pid, nome, agora) => subagentes.doAgente(pid, nome, agora)
    )
    subagentes.manter(new Set(estado.agentes.flatMap((a) => a.pid === null ? [] : [a.pid])))
    return estado
  }).pipe(Effect.catch((e) => Effect.succeed(herdrFora(e.motivo))))

const plistsJarvis = (dir: string): Array<string> => {
  try {
    return readdirSync(dir)
      .filter((f) => f.startsWith(PREFIXO) && f.endsWith(".plist"))
      .map((f) => f.slice(0, -".plist".length))
  } catch {
    return []
  }
}

const lerAgendas = (dir: string, labels: ReadonlyArray<string>): Map<string, Agenda> => {
  const agendas = new Map<string, Agenda>()
  for (const label of labels) {
    try {
      const agenda = parseAgendaPlist(readFileSync(join(dir, `${label}.plist`), "utf8"))
      if (agenda) agendas.set(label, agenda)
    } catch {
      // plist ilegível ou binário: o `run interval` do launchctl print ainda cobre o StartInterval.
    }
  }
  return agendas
}

const mtimeMs = (path: string | null): number | null => {
  if (path === null) return null
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

const lerLogsMs = (detalhes: ReadonlyMap<string, DetalheLaunchctl>): Map<string, number> => {
  const logs = new Map<string, number>()
  for (const [label, d] of detalhes) {
    const ms = Math.max(mtimeMs(d.stdout) ?? 0, mtimeMs(d.stderr) ?? 0)
    if (ms > 0) logs.set(label, Math.round(ms))
  }
  return logs
}

export const coletarServicos = (
  launchAgents: string,
  tabela: Tabela,
  relogio?: RelogioExecucoes
): Effect.Effect<Array<Servico>> =>
  Effect.gen(function*() {
    const lista = parseLaunchctlList(yield* rodar("/bin/launchctl", ["list"]).pipe(Effect.orElseSucceed(() => "")))
    const uid = process.getuid?.() ?? 501
    const detalhes = new Map<string, DetalheLaunchctl>()
    yield* Effect.forEach(
      lista,
      (l) =>
        rodar("/bin/launchctl", ["print", `gui/${uid}/${l.label}`]).pipe(
          Effect.map((s) => detalhes.set(l.label, parseLaunchctlPrint(s))),
          Effect.ignore
        ),
      { concurrency: 4, discard: true }
    )
    const plists = plistsJarvis(launchAgents)
    return montarServicos(plists, lista, detalhes, tabela, {
      agendas: lerAgendas(launchAgents, plists),
      logsMs: lerLogsMs(detalhes),
      ...(relogio ? { relogio } : {})
    })
  })
