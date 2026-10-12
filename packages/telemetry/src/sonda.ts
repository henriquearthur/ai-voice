#!/usr/bin/env bun
/**
 * Sonda de saúde do Jarvis (LaunchAgent dev.jarvis.telemetria): a cada 15 s lê o launchd, o `ps`
 * e os endpoints HTTP de cada serviço e publica gauges OTLP como `jarvis-sonda`.
 *
 * Ao iniciar, e a cada minuto, garante o backend: se o coletor OTLP não responde, liga o OrbStack
 * (quando existe) e roda `docker compose up -d` no services/telemetria/compose.yaml.
 *
 *   jarvis_servico_vivo{servico}             1 rodando (ou periódico cuja última saída foi 0), 0 parado ou ausente
 *   jarvis_servico_execucoes{servico}        "runs" do launchd: sobe a cada (re)início
 *   jarvis_servico_ultimo_codigo_saida{servico}
 *   jarvis_servico_http_ok{servico}          1 quando o endpoint responde abaixo de 500
 *   jarvis_servico_health_ms{servico}        tempo da última checagem HTTP
 *   jarvis_servico_rss_bytes{servico}        memória do processo e dos filhos
 *   jarvis_servico_cpu_pct{servico}          CPU do processo e dos filhos (% de um núcleo)
 */
import { BunRuntime } from "@effect/platform-bun"
import { Effect, Layer, Metric, Schedule } from "effect"
import { fileURLToPath } from "node:url"
import * as Telemetry from "./telemetry.ts"

interface Servico {
  readonly servico: string
  readonly label?: string
  readonly url?: string
}

const SERVICOS: ReadonlyArray<Servico> = [
  { servico: "callback", label: "dev.jarvis.callback", url: "http://127.0.0.1:7348/" },
  { servico: "dashboard", label: "dev.jarvis.dashboard", url: "http://127.0.0.1:7350/" },
  { servico: "tts", label: "dev.jarvis.tts", url: "http://127.0.0.1:7349/health" },
  { servico: "escuta", label: "dev.jarvis.escuta" },
  { servico: "telemetria", label: "dev.jarvis.telemetria" },
  // O backend em si (contêiner jarvis-telemetria): Grafana e o coletor OTLP.
  { servico: "grafana", url: "http://127.0.0.1:7351/api/health" },
  { servico: "otlp", url: "http://127.0.0.1:4318/" }
]

const gauge = (name: string, description: string) => Metric.gauge(name, { description })

const vivo = gauge("jarvis_servico_vivo", "1 quando o LaunchAgent está rodando.")
const execucoes = gauge("jarvis_servico_execucoes", "Quantas vezes o launchd iniciou o serviço (runs).")
const ultimoCodigo = gauge("jarvis_servico_ultimo_codigo_saida", "Último código de saída visto pelo launchd.")
const httpOk = gauge("jarvis_servico_http_ok", "1 quando o endpoint HTTP do serviço responde abaixo de 500.")
const healthMs = gauge("jarvis_servico_health_ms", "Tempo da última checagem HTTP, em milissegundos.")
const rssBytes = gauge("jarvis_servico_rss_bytes", "Memória residente do serviço e dos seus filhos, em bytes.")
const cpuPct = gauge("jarvis_servico_cpu_pct", "CPU do serviço e dos seus filhos, em % de um núcleo.")

const set = (metric: Metric.Metric<number, unknown>, servico: string, value: number) =>
  Metric.update(Metric.withAttributes(metric, { servico }), value)

const run = (cmd: ReadonlyArray<string>) =>
  Effect.tryPromise(async () => {
    const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 5000, killSignal: "SIGKILL" })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    return { stdout, code }
  }).pipe(Effect.timeout("5 seconds"), Effect.orElseSucceed(() => ({ stdout: "", code: -1 })))

interface Processo {
  readonly pid: number
  readonly ppid: number
  readonly rss: number
  readonly cpu: number
}

const lerProcessos = run(["/bin/ps", "-axo", "pid=,ppid=,rss=,%cpu="]).pipe(
  Effect.map(({ stdout }) =>
    stdout.split("\n").flatMap((line): ReadonlyArray<Processo> => {
      const [pid, ppid, rss, cpu] = line.trim().split(/\s+/).map(Number)
      return pid === undefined || Number.isNaN(pid)
        ? []
        : [{ pid, ppid: ppid ?? 0, rss: (rss ?? 0) * 1024, cpu: cpu ?? 0 }]
    })
  )
)

/** RSS and CPU of `pid` and every descendant. */
const somaArvore = (processos: ReadonlyArray<Processo>, pid: number) => {
  const filhos = new Map<number, Array<Processo>>()
  for (const p of processos) filhos.set(p.ppid, [...(filhos.get(p.ppid) ?? []), p])
  let rss = 0
  let cpu = 0
  const fila = processos.filter((p) => p.pid === pid)
  const vistos = new Set<number>()
  while (fila.length > 0) {
    const p = fila.pop()!
    if (vistos.has(p.pid)) continue
    vistos.add(p.pid)
    rss += p.rss
    cpu += p.cpu
    fila.push(...(filhos.get(p.pid) ?? []))
  }
  return { rss, cpu }
}

const uid = process.getuid?.() ?? 501

const launchd = (label: string) =>
  run(["/bin/launchctl", "print", `gui/${uid}/${label}`]).pipe(
    Effect.map(({ code, stdout }) => {
      if (code !== 0) return { rodando: false, pid: undefined, runs: 0, ultimo: -1 }
      const campo = (nome: string) => new RegExp(`^\\t${nome} = (.+)$`, "m").exec(stdout)?.[1]?.trim()
      const pid = Number(campo("pid"))
      const ultimo = Number(campo("last exit code"))
      // Periódico (StartInterval): sem processo entre as execuções é o normal; saudável se a última saiu com 0.
      const periodico = campo("run interval") !== undefined
      return {
        rodando: campo("state") === "running" || (periodico && Number.isFinite(ultimo) && ultimo === 0),
        pid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
        runs: Number(campo("runs")) || 0,
        ultimo: Number.isFinite(ultimo) ? ultimo : 0
      }
    })
  )

const checarHttp = (url: string) =>
  Effect.tryPromise(async () => {
    const start = performance.now()
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: "manual" })
    await response.body?.cancel()
    return { ok: response.status < 500, ms: performance.now() - start }
  }).pipe(Effect.orElseSucceed(() => ({ ok: false, ms: 3000 })))

const coletar = Effect.gen(function*() {
  const processos = yield* lerProcessos
  yield* Effect.forEach(SERVICOS, (s) =>
    Effect.gen(function*() {
      if (s.label !== undefined) {
        const estado = yield* launchd(s.label)
        yield* set(vivo, s.servico, estado.rodando ? 1 : 0)
        yield* set(execucoes, s.servico, estado.runs)
        yield* set(ultimoCodigo, s.servico, estado.ultimo)
        const uso = estado.pid === undefined ? { rss: 0, cpu: 0 } : somaArvore(processos, estado.pid)
        yield* set(rssBytes, s.servico, uso.rss)
        yield* set(cpuPct, s.servico, uso.cpu)
      }
      if (s.url !== undefined) {
        const http = yield* checarHttp(s.url)
        yield* set(httpOk, s.servico, http.ok ? 1 : 0)
        yield* set(healthMs, s.servico, Math.round(http.ms))
        if (s.label === undefined) yield* set(vivo, s.servico, http.ok ? 1 : 0)
      }
    }), { concurrency: "unbounded", discard: true })
}).pipe(Effect.withSpan("sonda.coletar"))

const COMPOSE = fileURLToPath(new URL("../../../services/telemetria/compose.yaml", import.meta.url))
const DOCKER = ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"].find((path) => Bun.file(path).size > 0) ?? "docker"
const ORB = ["/usr/local/bin/orb", "/opt/homebrew/bin/orb"].find((path) => Bun.file(path).size > 0)

const garantirBackend = Effect.gen(function*() {
  if ((yield* checarHttp("http://127.0.0.1:4318/")).ok) return
  yield* Effect.logWarning("coletor OTLP fora do ar; subindo o contêiner jarvis-telemetria")
  if ((yield* run([DOCKER, "info"])).code !== 0 && ORB !== undefined) yield* run([ORB, "start"])
  const up = yield* Effect.tryPromise(async () => {
    const proc = Bun.spawn([DOCKER, "compose", "-f", COMPOSE, "up", "-d"], {
      stdout: "inherit",
      stderr: "inherit",
      // Sem isto o Effect.timeout abandonava o processo e, com o daemon travado, empilhava um
      // `docker compose` novo por minuto (dezenas de processos de ~35 MB cada).
      timeout: 120_000,
      killSignal: "SIGKILL"
    })
    return proc.exited
  }).pipe(Effect.timeout("130 seconds"), Effect.orElseSucceed(() => -1))
  yield* Effect.logInfo(`docker compose up -d terminou com ${up}`)
}).pipe(Effect.withSpan("sonda.garantirBackend"))

const main = Effect.all([
  garantirBackend.pipe(Effect.repeat(Schedule.spaced("1 minute"))),
  coletar.pipe(Effect.repeat(Schedule.spaced("15 seconds")))
], { concurrency: "unbounded", discard: true })

Layer.launch(Layer.effectDiscard(Effect.andThen(Effect.logInfo("sonda de saúde do Jarvis iniciada"), main))).pipe(
  Effect.provide(Telemetry.layer({ serviceName: "jarvis-sonda" })),
  BunRuntime.runMain
)
