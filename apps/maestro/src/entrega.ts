import { Duration, Effect, Option, Ref, Schedule } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Fila, formatarEntrega } from "./fila.ts"
import { type AgentStatus, findAgent, promptAgent } from "./herdr.ts"

export const INTERVALO = Duration.seconds(3)

export type Decisao = "entregar" | "avisar" | "esperar"

/**
 * O que fazer com a fila agora. Só entrega com o maestro pronto (idle ou done);
 * bloqueado numa aprovação, avisa uma vez por bloqueio.
 */
export const decidir = (input: {
  readonly pendentes: number
  readonly status: Option.Option<AgentStatus>
  readonly avisado: boolean
}): Decisao => {
  if (input.pendentes === 0 || Option.isNone(input.status)) return "esperar"
  switch (input.status.value) {
    case "idle":
    case "done":
      return "entregar"
    case "blocked":
      return input.avisado ? "esperar" : "avisar"
    default:
      return "esperar"
  }
}

export const avisoBloqueado = (name: string) =>
  name === "maestro"
    ? "O maestro espera aprovação no herdr, e há eventos na fila."
    : `O agente ${name} espera aprovação no herdr, e há eventos na fila.`

/** Fala pelo jarvis-fala; uma falha só vira log. */
export const falar = (fala: string, texto: string) =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(
      ChildProcess.make(fala, [texto], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    )
    yield* handle.exitCode
  }).pipe(
    Effect.scoped,
    Effect.timeout(Duration.seconds(90)),
    Effect.catch((error) => Effect.logWarning("jarvis-fala falhou", error))
  )

/** Uma rodada: olha a fila e o estado do maestro, e entrega ou avisa. */
export const rodada = (options: { readonly name: string; readonly fala: string; readonly avisado: Ref.Ref<boolean> }) =>
  Effect.gen(function*() {
    const fila = yield* Fila
    const pendentes = yield* fila.pendentes
    if (pendentes.length === 0) return "esperar" as const
    const agent = yield* findAgent(options.name)
    const status = Option.map(agent, (a) => a.agent_status)
    if (Option.getOrUndefined(status) !== "blocked") yield* Ref.set(options.avisado, false)
    const decisao = decidir({ pendentes: pendentes.length, status, avisado: yield* Ref.get(options.avisado) })
    if (decisao === "entregar") {
      yield* promptAgent(options.name, formatarEntrega(pendentes))
      yield* fila.remover(pendentes.map((evento) => evento.id))
      yield* Effect.logInfo(`Entreguei ${pendentes.length} evento(s) a ${options.name}.`)
      // Dá tempo do herdr ver o maestro trabalhando antes da próxima rodada.
      yield* Effect.sleep(Duration.seconds(5))
    } else if (decisao === "avisar") {
      yield* Ref.set(options.avisado, true)
      yield* falar(options.fala, avisoBloqueado(options.name))
    }
    return decisao
  })

/** Roda para sempre; um erro do herdr só adia a entrega para a próxima rodada. */
export const entregador = (options: { readonly name: string; readonly fala: string }) =>
  Effect.gen(function*() {
    const avisado = yield* Ref.make(false)
    yield* rodada({ ...options, avisado }).pipe(
      Effect.catch((error) => Effect.logWarning("Entrega adiada", error.message)),
      Effect.repeat(Schedule.spaced(INTERVALO))
    )
  })
