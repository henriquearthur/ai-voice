import { Context, Duration, Effect, Layer, Option, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

/** O herdr não rodou, demorou demais ou respondeu algo que não é JSON. */
export class HerdrError extends Schema.TaggedError<HerdrError>()("HerdrError", {
  message: Schema.String
}) {}

/** O herdr respondeu com `{"error": {code, message}}` (por exemplo agent_not_found ou agent_blocked). */
export class HerdrRejected extends Schema.TaggedError<HerdrRejected>()("HerdrRejected", {
  code: Schema.String,
  message: Schema.String
}) {}

export const AgentStatus = Schema.Literals(["idle", "working", "blocked", "done", "unknown"])
export type AgentStatus = typeof AgentStatus.Type

export const Agent = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  agent_status: AgentStatus,
  pane_id: Schema.String,
  workspace_id: Schema.String
})
export type Agent = typeof Agent.Type

const Workspace = Schema.Struct({ workspace_id: Schema.String, label: Schema.optionalKey(Schema.String) })

const Pane = Schema.Struct({
  pane_id: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  agent_status: Schema.optionalKey(AgentStatus)
})
export type Pane = typeof Pane.Type

const Envelope = Schema.fromJsonString(Schema.Struct({
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String }))
}))

const decode = <S extends Schema.Constraint>(schema: S) => (input: unknown) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => new HerdrError({ message: "O herdr respondeu num formato inesperado." }))
  ) as Effect.Effect<S["Type"], HerdrError>

const TIMEOUT = Duration.seconds(30)

export interface HerdrApi {
  /** Roda `herdr <args>` e devolve `.result`, ou falha com o erro que o herdr deu. */
  readonly call: (
    args: ReadonlyArray<string>,
    timeout?: Duration.Duration
  ) => Effect.Effect<unknown, HerdrError | HerdrRejected>
}

export class Herdr extends Context.Service<Herdr, HerdrApi>()("@jarvis/maestro/Herdr") {
  /** O herdr de verdade, pelo binário em `bin` (caminho absoluto, sem shell). */
  static readonly layer = (bin: string) =>
    Layer.effect(
      Herdr,
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const call: HerdrApi["call"] = (args, timeout = TIMEOUT) =>
          Effect.gen(function*() {
            const handle = yield* spawner.spawn(
              ChildProcess.make(bin, [...args], { stdin: "ignore", forceKillAfter: Duration.seconds(2) })
            )
            const text = (bytes: typeof handle.stdout) =>
              bytes.pipe(Stream.decodeText(), Stream.runFold(() => "", (acc, chunk: string) => acc + chunk))
            const { stdout, stderr } = yield* Effect.all(
              { stdout: text(handle.stdout), stderr: text(handle.stderr), exit: handle.exitCode },
              { concurrency: "unbounded" }
            )
            // Os erros do servidor saem em JSON no stderr; o resultado, no stdout.
            const raw = stdout.trim() !== "" ? stdout.trim() : stderr.trim()
            const envelope = yield* Schema.decodeUnknownEffect(Envelope)(raw).pipe(
              Effect.mapError(() =>
                new HerdrError({ message: `herdr ${args.slice(0, 2).join(" ")}: ${raw.slice(0, 200)}` })
              )
            )
            if (envelope.error) return yield* new HerdrRejected(envelope.error)
            return envelope.result
          }).pipe(
            Effect.scoped,
            Effect.catchTag("PlatformError", () => Effect.fail(new HerdrError({ message: `Não consegui rodar ${bin}.` }))),
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.fail(new HerdrError({ message: `herdr ${args[0]} passou do tempo.` }))
            })
          )
        return { call }
      })
    )
}

/** Atalhos tipados sobre `herdr <comando>`. */
export const listAgents = Effect.gen(function*() {
  const herdr = yield* Herdr
  const result = yield* herdr.call(["agent", "list"])
  const { agents } = yield* decode(Schema.Struct({ agents: Schema.Array(Agent) }))(result)
  return agents
})

/** O agente com esse nome, se estiver vivo. */
export const findAgent = (name: string) =>
  listAgents.pipe(Effect.map((agents) => Option.fromNullishOr(agents.find((agent) => agent.name === name))))

export const promptAgent = (name: string, text: string) =>
  Effect.gen(function*() {
    const herdr = yield* Herdr
    yield* herdr.call(["agent", "prompt", name, text])
  })

export const listWorkspaces = Effect.gen(function*() {
  const herdr = yield* Herdr
  const result = yield* herdr.call(["workspace", "list"])
  const { workspaces } = yield* decode(Schema.Struct({ workspaces: Schema.Array(Workspace) }))(result)
  return workspaces
})

const envArgs = (env: Readonly<Record<string, string>>) => Object.entries(env).flatMap(([k, v]) => ["--env", `${k}=${v}`])

/** Cria um workspace novo e devolve o pane raiz. */
export const createWorkspace = (options: { cwd: string; label: string; env: Readonly<Record<string, string>> }) =>
  Effect.gen(function*() {
    const herdr = yield* Herdr
    const result = yield* herdr.call([
      "workspace", "create", "--cwd", options.cwd, "--label", options.label, "--no-focus", ...envArgs(options.env)
    ])
    const { root_pane } = yield* decode(Schema.Struct({ root_pane: Pane }))(result)
    return root_pane.pane_id
  })

const WorkspacePane = Schema.Struct({
  pane_id: Schema.String,
  tab_id: Schema.String,
  focused: Schema.optionalKey(Schema.Boolean)
})

/** Os panes de um workspace. */
export const listPanes = (workspace: string) =>
  Effect.gen(function*() {
    const herdr = yield* Herdr
    const result = yield* herdr.call(["pane", "list", "--workspace", workspace])
    const { panes } = yield* decode(Schema.Struct({ panes: Schema.Array(WorkspacePane) }))(result)
    return panes
  })

/** Abre um pane novo ao lado de `pane` (à direita ou abaixo, sem tirar o foco) e devolve o id. */
export const splitPane = (options: {
  pane: string
  cwd: string
  env: Readonly<Record<string, string>>
  direction?: "right" | "down"
}) =>
  Effect.gen(function*() {
    const herdr = yield* Herdr
    const result = yield* herdr.call([
      "pane", "split", "--pane", options.pane, "--direction", options.direction ?? "right", "--cwd", options.cwd, "--no-focus",
      ...envArgs(options.env)
    ])
    const { pane } = yield* decode(Schema.Struct({ pane: Pane }))(result)
    return pane.pane_id
  })

/** O pane, se ainda existir. */
export const getPane = (paneId: string) =>
  Effect.gen(function*() {
    const herdr = yield* Herdr
    const result = yield* herdr.call(["pane", "get", paneId]).pipe(
      Effect.map(Option.some),
      Effect.catchTag("HerdrRejected", () => Effect.succeedNone)
    )
    if (Option.isNone(result)) return Option.none<Pane>()
    const { pane } = yield* decode(Schema.Struct({ pane: Pane }))(result.value)
    return Option.some(pane)
  })

/** `herdr agent start <name> --kind claude --pane <pane> -- <args>`; espera o claude ficar pronto. */
export const startClaude = (options: { name: string; pane: string; args: ReadonlyArray<string> }) =>
  Effect.gen(function*() {
    const herdr = yield* Herdr
    // O rótulo do pane é do herdr: o claude reescreve o título OSC, o rótulo não.
    yield* herdr.call(["pane", "rename", options.pane, options.name])
    yield* herdr.call(
      ["agent", "start", options.name, "--kind", "claude", "--pane", options.pane, "--timeout", "90000", "--", ...options.args],
      Duration.seconds(100)
    )
  })
