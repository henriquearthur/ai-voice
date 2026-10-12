import { Context, Duration, Effect, Layer, Metric, Schema, Semaphore, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const DEFAULT_HERDR = "herdr"
const TIMEOUT = Duration.seconds(10)
const MAX_OUTPUT = 1_000_000

export const MAX_LINES = 1000
export const DEFAULT_LINES = 60
export const MAX_TEXT_LENGTH = 20_000

/**
 * Time the TUI gets to ingest pasted text before the submit key arrives. The key
 * is a separate herdr call; if it lands while the paste is still being read, the
 * TUI loses the head of the text. Grows with the length, capped.
 */
export const settleTime = (length: number): Duration.Duration =>
  Duration.millis(Math.min(300 + length, 3000))

export class HerdrError extends Schema.TaggedError<HerdrError>()("HerdrError", {
  message: Schema.String
}) {}

export const AgentInfo = Schema.Struct({
  name: Schema.String,
  pane: Schema.String,
  kind: Schema.String,
  state: Schema.String,
  blocked: Schema.Boolean
})
export type AgentInfo = typeof AgentInfo.Type

/** Whitelist: the only keys a caller can press, each mapped to the herdr key name. */
export const KEYS = {
  approve: "enter",
  deny: "esc",
  cycle_mode: "shift+tab",
  interrupt: "ctrl+c"
} as const
export const KeyAction = Schema.Literals(["approve", "deny", "cycle_mode", "interrupt"])
export type KeyAction = typeof KeyAction.Type

/** Actions an agent must never run on its own pane: it would approve its own permission request. */
const SELF_REFUSED: ReadonlySet<KeyAction> = new Set(["approve", "cycle_mode"])

export const controlActions = Metric.counter("jarvis_controle_acoes_total", {
  description: "Ações de controle sobre agentes do herdr, por ação, agente e origem.",
  incremental: true
})

/** Runs `herdr` with these arguments (argv only, never a shell) and returns stdout. */
export type RunHerdr = (args: ReadonlyArray<string>) => Effect.Effect<string, HerdrError>

const rawAgent = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  pane_id: Schema.String,
  agent: Schema.optionalKey(Schema.String),
  agent_status: Schema.optionalKey(Schema.String)
})
const rawList = Schema.Struct({ result: Schema.Struct({ agents: Schema.Array(rawAgent) }) })

const parseAgents = (stdout: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(rawList))(stdout).pipe(
    Effect.map(({ result }) =>
      result.agents.map((agent): AgentInfo => ({
        name: agent.name ?? "",
        pane: agent.pane_id,
        kind: agent.agent ?? "unknown",
        state: agent.agent_status ?? "unknown",
        blocked: agent.agent_status === "blocked"
      }))
    ),
    Effect.mapError(() => new HerdrError({ message: "Could not understand the output of herdr agent list." }))
  )

const record = (acao: string, agente: string) =>
  Effect.all([
    Effect.logInfo("controle de agente").pipe(Effect.annotateLogs({ acao, agente, origem: "mcp" })),
    Metric.update(Metric.withAttributes(controlActions, { acao, agente, origem: "mcp" }), 1)
  ], { discard: true })

export class Herdr extends Context.Service<Herdr, {
  readonly agents: Effect.Effect<ReadonlyArray<AgentInfo>, HerdrError>
  readonly read: (input: { readonly agent: string; readonly lines?: number | undefined }) => Effect.Effect<string, HerdrError>
  readonly send: (
    input: { readonly agent: string; readonly text: string; readonly steer?: boolean | undefined }
  ) => Effect.Effect<{ readonly agent: string; readonly pane: string; readonly sent: true }, HerdrError>
  readonly key: (
    input: { readonly agent: string; readonly key: KeyAction }
  ) => Effect.Effect<{ readonly agent: string; readonly pane: string; readonly key: KeyAction }, HerdrError>
}>()("@jarvis/mcp/Herdr") {
  /**
   * Builds the service on top of `run`. `callerPane` is the pane of the agent
   * that owns this MCP server (`HERDR_PANE_ID`); `approve` and `cycle_mode` are
   * refused against it so no agent can approve its own permission request.
   */
  static readonly make = (
    run: RunHerdr,
    callerPane: string | undefined,
    settle: (length: number) => Duration.Duration = settleTime
  ) => {
    // One send at a time per pane: two interleaved paste+key sequences mix their texts.
    const locks = new Map<string, Semaphore.Semaphore>()
    const lockFor = (pane: string) => {
      const found = locks.get(pane)
      if (found !== undefined) return found
      const created = Semaphore.makeUnsafe(1)
      locks.set(pane, created)
      return created
    }

    const agents = run(["agent", "list"]).pipe(Effect.flatMap(parseAgents))

    const resolve = (target: string) =>
      Effect.flatMap(agents, (live) => {
        const found = live.find((agent) => agent.name === target || agent.pane === target)
        if (found !== undefined) return Effect.succeed(found)
        const names = live.map((agent) => agent.name === "" ? agent.pane : agent.name).join(", ")
        return Effect.fail(new HerdrError({ message: `No live agent "${target}". Live agents: ${names || "none"}.` }))
      })

    const label = (agent: AgentInfo) => agent.name === "" ? agent.pane : agent.name

    const read = Effect.fn("Herdr.read")(function*(input: { readonly agent: string; readonly lines?: number | undefined }) {
      const agent = yield* resolve(input.agent)
      const lines = Math.min(Math.max(Math.trunc(input.lines ?? DEFAULT_LINES), 1), MAX_LINES)
      const out = yield* run(["agent", "read", agent.pane, "--source", "recent-unwrapped", "--lines", String(lines)])
      yield* record("read", label(agent))
      return out
    })

    const send = Effect.fn("Herdr.send")(function*(
      input: { readonly agent: string; readonly text: string; readonly steer?: boolean | undefined }
    ) {
      const agent = yield* resolve(input.agent)
      yield* Effect.gen(function*() {
        yield* run(["pane", "send-text", agent.pane, input.text])
        yield* Effect.sleep(settle(input.text.length))
        yield* run(["agent", "send-keys", agent.pane, input.steer === false ? "enter" : "ctrl+enter"])
      }).pipe(lockFor(agent.pane).withPermits(1))
      yield* record(input.steer === false ? "send" : "steer", label(agent))
      return { agent: label(agent), pane: agent.pane, sent: true as const }
    })

    const key = Effect.fn("Herdr.key")(function*(input: { readonly agent: string; readonly key: KeyAction }) {
      const agent = yield* resolve(input.agent)
      if (SELF_REFUSED.has(input.key) && callerPane !== undefined && agent.pane === callerPane) {
        yield* Effect.logWarning("controle recusado: agente não pode usar a própria permissão").pipe(
          Effect.annotateLogs({ acao: input.key, agente: label(agent), origem: "mcp" })
        )
        return yield* new HerdrError({
          message: `Refused: "${input.key}" cannot target the caller's own pane (${agent.pane}). ` +
            "An agent may not approve its own permission request."
        })
      }
      yield* run(["agent", "send-keys", agent.pane, KEYS[input.key]])
      yield* record(input.key, label(agent))
      return { agent: label(agent), pane: agent.pane, key: input.key }
    })

    return Herdr.of({ agents, read, send, key })
  }

  static readonly layer = Layer.effect(
    Herdr,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const bin = process.env.HERDR_BIN_PATH ?? DEFAULT_HERDR
      const collect = (bytes: Stream.Stream<Uint8Array, unknown>) =>
        bytes.pipe(
          Stream.decodeText(),
          Stream.runFold(() => "", (output, chunk: string) => (output + chunk).slice(0, MAX_OUTPUT))
        )
      const run: RunHerdr = (args) =>
        Effect.gen(function*() {
          const handle = yield* spawner.spawn(
            ChildProcess.make(bin, [...args], { stdin: "ignore", forceKillAfter: Duration.seconds(2) })
          )
          return yield* Effect.all({
            stdout: collect(handle.stdout),
            stderr: collect(handle.stderr),
            exitCode: handle.exitCode
          }, { concurrency: "unbounded" })
        }).pipe(
          Effect.scoped,
          Effect.catch(() => Effect.fail(new HerdrError({ message: "Could not run herdr." }))),
          Effect.timeoutOrElse({
            duration: TIMEOUT,
            orElse: () => Effect.fail(new HerdrError({ message: "herdr did not answer within 10 seconds." }))
          }),
          Effect.flatMap(({ exitCode, stderr, stdout }) =>
            exitCode === ChildProcessSpawner.ExitCode(0)
              ? Effect.succeed(stdout)
              : Effect.fail(new HerdrError({ message: `herdr failed: ${(stderr || stdout).trim().slice(0, 500)}` }))
          )
        )
      return Herdr.make(run, process.env.HERDR_PANE_ID)
    })
  )
}
