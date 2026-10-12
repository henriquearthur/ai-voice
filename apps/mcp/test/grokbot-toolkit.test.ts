import { assert, describe, expectTypeOf, it } from "@effect/vitest"
import { GrokBot, GrokBotError } from "@jarvis/grokbot"
import { type Config, type Crypto, Effect, type FileSystem, Layer, type Path } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import type { HttpClient } from "effect/http"
import { GrokBotToolkitLayer, layer } from "../src/grokbot-toolkit.ts"

const REQUEST_ID = "00000000-0000-4000-8000-000000000000"

const uncertain = new GrokBotError({
  message: "Grok Bot did not answer within 15 seconds, so the outcome is uncertain. " +
    "Do not resend it automatically: it may already be running."
})

// The service is faked: the real one would trigger the user's routine.
const makeFake = (options: { readonly fail?: boolean } = {}) => {
  const calls: Array<unknown> = []
  const fake = Layer.succeed(
    GrokBot,
    GrokBot.of({
      send: (input) =>
        Effect.suspend(() => {
          calls.push(input)
          return options.fail === true
            ? Effect.fail(uncertain)
            : Effect.succeed({ requestId: REQUEST_ID, status: "started" as const })
        })
    })
  )
  return { calls, layer: fake }
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "grokbot-toolkit-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "grokbot-toolkit-test", version: "1.0.0" }
  },
  getClient: Effect.die("not used")
})

const serve = (fake: Layer.Layer<GrokBot>) =>
  Layer.provideMerge(GrokBotToolkitLayer.pipe(Layer.provide(fake)), McpServer.McpServer.layer)

const tool = Effect.map(McpServer.McpServer, (server) => server.tools.map(({ tool }) => tool)[0]!)

const callTool = (args: Record<string, unknown>) =>
  McpServer.McpServer.use((server) => server.callTool({ name: "grokbot_send", arguments: args })).pipe(
    Effect.provideService(McpSchema.McpServerClient, client)
  )

describe("GrokBotToolkit", () => {
  it("needs an HttpClient, Crypto and the outbox filesystem when backed by the real service", () => {
    expectTypeOf(layer).toEqualTypeOf<
      Layer.Layer<
        never,
        Config.ConfigError,
        HttpClient.HttpClient | Crypto.Crypto | FileSystem.FileSystem | Path.Path
      >
    >()
  })

  it.effect("declares a non-idempotent, open-world tool that warns against resending", () =>
    Effect.gen(function*() {
      const { annotations, description, inputSchema, name } = yield* tool
      assert.strictEqual(name, "grokbot_send")
      assert.deepStrictEqual(annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      })
      assert.match(description ?? "", /result is not returned by this tool/)
      assert.match(description ?? "", /Never resend/)
      const schema = inputSchema as {
        readonly properties: Record<string, { readonly maxLength?: number }>
        readonly required: ReadonlyArray<string>
      }
      assert.deepStrictEqual(Object.keys(schema.properties), ["task", "context"])
      assert.deepStrictEqual(schema.required, ["task"])
      assert.strictEqual(schema.properties.task?.maxLength, 8000)
      assert.strictEqual(schema.properties.context?.maxLength, 20000)
    }).pipe(Effect.provide(serve(makeFake().layer))))

  it.effect("passes the task through and answers with snake_case fields", () => {
    const { calls, layer } = makeFake()
    return Effect.gen(function*() {
      const result = yield* callTool({ task: "summarize my inbox", context: "only unread" })
      assert.strictEqual(result.isError, false)
      assert.deepStrictEqual(result.structuredContent, { request_id: REQUEST_ID, status: "started" })
      yield* callTool({ task: "ping" })
      assert.deepStrictEqual(calls, [{ task: "summarize my inbox", context: "only unread" }, { task: "ping" }])
    }).pipe(Effect.provide(serve(layer)))
  })

  it.effect("rejects arguments outside the limits as InvalidParams without calling the service", () => {
    const { calls, layer } = makeFake()
    return Effect.gen(function*() {
      for (const args of [{}, { task: "" }, { task: "x".repeat(8001) }, { task: "ping", context: "x".repeat(20001) }]) {
        const error = yield* Effect.flip(callTool(args))
        assert.strictEqual(error._tag, "InvalidParams")
      }
      assert.deepStrictEqual(calls, [])
    }).pipe(Effect.provide(serve(layer)))
  })

  it.effect("surfaces GrokBotError as an error result with its message", () =>
    Effect.gen(function*() {
      const result = yield* callTool({ task: "ping" })
      assert.strictEqual(result.isError, true)
      assert.deepStrictEqual(result.content, [{ type: "text", text: uncertain.message }])
    }).pipe(Effect.provide(serve(makeFake({ fail: true }).layer))))
})
