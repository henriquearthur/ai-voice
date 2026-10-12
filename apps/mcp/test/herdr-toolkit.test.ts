import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { McpSchema, McpServer } from "effect/ai"
import { Herdr, HerdrError, settleTime, type RunHerdr } from "../src/herdr.ts"
import { HerdrToolkitLayer } from "../src/herdr-toolkit.ts"

const agent = (name: string, pane: string, status: string) => ({
  name,
  pane_id: pane,
  agent: "claude",
  agent_status: status
})
const LIST = JSON.stringify({
  result: { agents: [agent("maestro", "w1:p1", "working"), agent("telemetria", "w1:p2", "blocked")] }
})

// herdr is faked: nothing here may press a key on a real agent.
const makeFake = (callerPane: string | undefined) => {
  const calls: Array<ReadonlyArray<string>> = []
  const run: RunHerdr = (args) =>
    Effect.suspend(() => {
      calls.push(args)
      return args[1] === "list" ? Effect.succeed(LIST) : args[1] === "read" ? Effect.succeed("tail\n") : Effect.succeed("")
    })
  const layer = Layer.succeed(Herdr, Herdr.make(run, callerPane, () => Duration.zero))
  return { calls, layer }
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "herdr-toolkit-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "herdr-toolkit-test", version: "1.0.0" }
  },
  getClient: Effect.die("not used")
})

const serve = (fake: Layer.Layer<Herdr>) =>
  Layer.provideMerge(HerdrToolkitLayer.pipe(Layer.provide(fake)), McpServer.McpServer.layer)

const callTool = (name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.use((server) => server.callTool({ name, arguments: args })).pipe(
    Effect.provideService(McpSchema.McpServerClient, client)
  )

describe("HerdrToolkit", () => {
  it.effect("registers the four tools", () =>
    Effect.gen(function*() {
      const server = yield* McpServer.McpServer
      assert.deepStrictEqual(server.tools.map(({ tool }) => tool.name), [
        "herdr_agents",
        "herdr_read",
        "herdr_send",
        "herdr_key"
      ])
    }).pipe(Effect.provide(serve(makeFake(undefined).layer))))

  it.effect("lists agents with their state and blocked flag", () =>
    Effect.gen(function*() {
      const result = yield* callTool("herdr_agents", {})
      assert.deepStrictEqual(result.structuredContent, [
        { name: "maestro", pane: "w1:p1", kind: "claude", state: "working", blocked: false },
        { name: "telemetria", pane: "w1:p2", kind: "claude", state: "blocked", blocked: true }
      ])
    }).pipe(Effect.provide(serve(makeFake(undefined).layer))))

  it.effect("reads by name or pane id with a clamped line count", () => {
    const { calls, layer } = makeFake(undefined)
    return Effect.gen(function*() {
      const result = yield* callTool("herdr_read", { agent: "telemetria", lines: 5 })
      assert.strictEqual(result.isError, false)
      yield* callTool("herdr_read", { agent: "w1:p1" })
      assert.deepStrictEqual(calls.filter((c) => c[1] === "read"), [
        ["agent", "read", "w1:p2", "--source", "recent-unwrapped", "--lines", "5"],
        ["agent", "read", "w1:p1", "--source", "recent-unwrapped", "--lines", "60"]
      ])
    }).pipe(Effect.provide(serve(layer)))
  })

  it.effect("rejects unknown agents without sending anything", () => {
    const { calls, layer } = makeFake(undefined)
    return Effect.gen(function*() {
      const result = yield* callTool("herdr_send", { agent: "fantasma", text: "oi" })
      assert.strictEqual(result.isError, true)
      assert.deepStrictEqual(calls, [["agent", "list"]])
    }).pipe(Effect.provide(serve(layer)))
  })

  it.effect("sends text then ctrl+enter, or enter with steer=false, as argv", () => {
    const { calls, layer } = makeFake(undefined)
    return Effect.gen(function*() {
      yield* callTool("herdr_send", { agent: "maestro", text: "--rm; echo $HOME" })
      yield* callTool("herdr_send", { agent: "maestro", text: "oi", steer: false })
      assert.deepStrictEqual(calls.filter((c) => c[1] !== "list"), [
        ["pane", "send-text", "w1:p1", "--rm; echo $HOME"],
        ["agent", "send-keys", "w1:p1", "ctrl+enter"],
        ["pane", "send-text", "w1:p1", "oi"],
        ["agent", "send-keys", "w1:p1", "enter"]
      ])
    }).pipe(Effect.provide(serve(layer)))
  })

  it.effect("serializes concurrent sends to the same pane: text and key never interleave", () => {
    const calls: Array<string> = []
    const run: RunHerdr = (args) =>
      Effect.gen(function*() {
        if (args[1] === "list") return LIST
        calls.push(`${args[1]}:${args[3]}`)
        yield* Effect.yieldNow
        return ""
      })
    return Effect.gen(function*() {
      const herdr = yield* Herdr
      yield* Effect.all([
        herdr.send({ agent: "maestro", text: "A" }),
        herdr.send({ agent: "maestro", text: "B" })
      ], { concurrency: "unbounded" })
      assert.deepStrictEqual(calls, ["send-text:A", "send-keys:ctrl+enter", "send-text:B", "send-keys:ctrl+enter"])
    }).pipe(Effect.provide(Layer.succeed(Herdr, Herdr.make(run, undefined, () => Duration.zero))))
  })

  it.effect("waits for the text to settle before pressing the key", () => {
    const calls: Array<string> = []
    const run: RunHerdr = (args) =>
      Effect.sync(() => {
        if (args[1] === "list") return LIST
        calls.push(args[1]!)
        return ""
      })
    return Effect.gen(function*() {
      const herdr = yield* Herdr
      const fiber = yield* Effect.forkChild(herdr.send({ agent: "maestro", text: "x".repeat(1000) }))
      yield* Effect.yieldNow
      assert.deepStrictEqual(calls, ["send-text"])
      yield* TestClock.adjust(settleTime(1000))
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(calls, ["send-text", "send-keys"])
    }).pipe(Effect.provide(Layer.succeed(Herdr, Herdr.make(run, undefined))))
  })

  it.effect("maps whitelisted keys and rejects anything else", () => {
    const { calls, layer } = makeFake("w1:p1")
    return Effect.gen(function*() {
      for (const key of ["approve", "deny", "cycle_mode", "interrupt"]) {
        yield* callTool("herdr_key", { agent: "telemetria", key })
      }
      assert.deepStrictEqual(calls.filter((c) => c[1] === "send-keys"), [
        ["agent", "send-keys", "w1:p2", "enter"],
        ["agent", "send-keys", "w1:p2", "esc"],
        ["agent", "send-keys", "w1:p2", "shift+tab"],
        ["agent", "send-keys", "w1:p2", "ctrl+c"]
      ])
      const error = yield* Effect.flip(callTool("herdr_key", { agent: "telemetria", key: "ctrl+d" }))
      assert.strictEqual(error._tag, "InvalidParams")
    }).pipe(Effect.provide(serve(layer)))
  })

  it.effect("refuses approve and cycle_mode on the caller's own pane, by name or id", () => {
    const { calls, layer } = makeFake("w1:p1")
    return Effect.gen(function*() {
      for (const target of ["maestro", "w1:p1"]) {
        for (const key of ["approve", "cycle_mode"]) {
          const result = yield* callTool("herdr_key", { agent: target, key })
          assert.strictEqual(result.isError, true)
        }
      }
      assert.deepStrictEqual(calls.filter((c) => c[1] === "send-keys"), [])
      // deny and interrupt on oneself stay allowed.
      const denied = yield* callTool("herdr_key", { agent: "maestro", key: "deny" })
      assert.strictEqual(denied.isError, false)
    }).pipe(Effect.provide(serve(layer)))
  })

  it("exposes HerdrError as a tagged error", () => {
    assert.strictEqual(new HerdrError({ message: "x" })._tag, "HerdrError")
  })
})
