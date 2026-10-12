import { Cause, Clock, Effect, Exit, Metric } from "effect"

/** Milliseconds, from 5 ms to about 2 minutes: covers HTTP calls, speech synthesis and playback. */
export const LATENCY_BOUNDARIES_MS: ReadonlyArray<number> = [
  5, 10, 25, 50, 75, 100, 150, 250, 400, 600, 800, 1000, 1500, 2000, 3000, 5000, 8000, 12000, 20000, 30000,
  60000, 120000
]

/** Every observed operation, by `operacao` and `resultado` (ok, erro, interrompido). */
export const operationDuration = Metric.histogram("jarvis_operacao_ms", {
  description: "Duração de cada operação do Jarvis, em milissegundos.",
  boundaries: LATENCY_BOUNDARIES_MS
})

export const operationCount = Metric.counter("jarvis_operacao_total", {
  description: "Operações do Jarvis por resultado.",
  incremental: true
})

export type Outcome = "ok" | "erro" | "interrompido"

export const outcomeOf = <A, E>(exit: Exit.Exit<A, E>): Outcome =>
  Exit.isSuccess(exit) ? "ok" : Cause.hasInterruptsOnly(exit.cause) ? "interrompido" : "erro"

const errorTag = <A, E>(exit: Exit.Exit<A, E>): string => {
  if (Exit.isSuccess(exit)) return ""
  const error = Cause.squash(exit.cause)
  if (typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string") return error._tag
  return "defeito"
}

/**
 * Wraps an effect in a span named `operacao` and records its duration and outcome in
 * `jarvis_operacao_ms` and `jarvis_operacao_total`. Attributes must be low-cardinality
 * labels (a tool name, an output): never text, ids or URLs.
 */
export const observe = (operacao: string, attributes: Readonly<Record<string, string>> = {}) =>
<A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Clock.currentTimeMillis, (start) =>
    self.pipe(
      Effect.onExit((exit) =>
        Effect.flatMap(Clock.currentTimeMillis, (end) => {
          const labels = { ...attributes, operacao, resultado: outcomeOf(exit), erro: errorTag(exit) }
          return Effect.all([
            Metric.update(Metric.withAttributes(operationDuration, labels), end - start),
            Metric.update(Metric.withAttributes(operationCount, labels), 1)
          ], { discard: true })
        })
      )
    )).pipe(Effect.withSpan(operacao, { attributes }))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handlers = Record<string, (...args: any) => Effect.Effect<any, any, any>>

/**
 * Observes every handler of an MCP toolkit as `<servidor>.<tool>`, labelled with
 * `servidor` and `ferramenta`. Only the tool name is recorded, never its parameters.
 */
export const observeTools = <H extends Handlers>(servidor: string, handlers: H): H => {
  const observed: Record<string, unknown> = {}
  for (const [ferramenta, handler] of Object.entries(handlers)) {
    observed[ferramenta] = (...args: ReadonlyArray<unknown>) =>
      observe(`${servidor}.${ferramenta}`, { servidor, ferramenta })(handler(...args))
  }
  return observed as H
}

/**
 * Records one finished operation measured outside Effect, such as an HTTP request
 * handled by SvelteKit, in `jarvis_operacao_ms` and `jarvis_operacao_total`.
 */
export const recordOperation = (
  operacao: string,
  millis: number,
  resultado: Outcome,
  attributes: Readonly<Record<string, string>> = {}
): Effect.Effect<void> => {
  const labels = { ...attributes, operacao, resultado }
  return Effect.all([
    Metric.update(Metric.withAttributes(operationDuration, labels), millis),
    Metric.update(Metric.withAttributes(operationCount, labels), 1)
  ], { discard: true })
}
