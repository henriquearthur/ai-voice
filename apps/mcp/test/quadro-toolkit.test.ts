import { assert, describe, it } from "@effect/vitest"
import { Duration, Effect, Layer } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { Herdr, type RunHerdr } from "../src/herdr.ts"
import { colmeiaText, Quadro, QuadroToolkitLayer, type Card, type QuadroApi } from "../src/quadro-toolkit.ts"

const LIST = JSON.stringify({
  result: { agents: [{ name: "maestro", pane_id: "w1:p1", agent: "claude", agent_status: "idle" }] }
})

const make = () => {
  const log: Array<unknown> = []
  const herdrCalls: Array<ReadonlyArray<string>> = []
  const api: QuadroApi = {
    criarCard: (input) => (log.push(["criar", input]), { id: "J-1", ...input }),
    listarCards: (input) => (log.push(["listar", input]), [{ id: "J-1" }] as Array<Card>),
    pegarCard: (id, dono) => (log.push(["pegar", id, dono]), id === "J-9" ? null : { id: "J-1" }),
    concluirCard: (id, dono, r) => (log.push(["concluir", id, dono, r]), { id, estado: "feito" }),
    resumo: () => "1 aberto",
    enviarMensagem: (de, para, texto) => void log.push(["msg", de, para, texto]),
    mensagens: (input) => (log.push(["mensagens", input]), [{ de: "a", para: "b", texto: "x" }])
  }
  const run: RunHerdr = (args) =>
    Effect.sync(() => {
      herdrCalls.push(args)
      return args[1] === "list" ? LIST : ""
    })
  const layer = Layer.provideMerge(
    QuadroToolkitLayer.pipe(
      Layer.provide(Layer.succeed(Quadro, Quadro.of(api))),
      Layer.provide(Layer.succeed(Herdr, Herdr.make(run, undefined, () => Duration.zero)))
    ),
    McpServer.McpServer.layer
  )
  return { log, herdrCalls, layer }
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "quadro-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "quadro-test", version: "1.0.0" }
  },
  getClient: Effect.die("not used")
})

const callTool = (name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.use((server) => server.callTool({ name, arguments: args })).pipe(
    Effect.provideService(McpSchema.McpServerClient, client)
  )

describe("QuadroToolkit", () => {
  it.effect("registers the seven tools", () =>
    Effect.gen(function*() {
      const server = yield* McpServer.McpServer
      assert.deepStrictEqual(server.tools.map(({ tool }) => tool.name), [
        "quadro_criar", "quadro_listar", "quadro_pegar", "quadro_concluir", "quadro_resumo", "colmeia_enviar", "colmeia_log"
      ])
    }).pipe(Effect.provide(make().layer)))

  it.effect("creates, claims (default proximo) and finishes cards", () => {
    const { layer, log } = make()
    return Effect.gen(function*() {
      const created = yield* callTool("quadro_criar", { titulo: "t", brief: "b", kit: "backend", criado_por: "maestro" })
      assert.strictEqual(created.isError, false)
      yield* callTool("quadro_pegar", { dono: "bot1" })
      yield* callTool("quadro_concluir", { id: "J-1", dono: "bot1", verdict: "PASS", resultado: "ok" })
      assert.deepStrictEqual(log, [
        ["criar", { titulo: "t", brief: "b", kit: "backend", criado_por: "maestro" }],
        ["pegar", "proximo", "bot1"],
        ["concluir", "J-1", "bot1", { verdict: "PASS", resultado: "ok" }]
      ])
    }).pipe(Effect.provide(layer))
  })

  it.effect("validates the enums", () => {
    const { layer, log } = make()
    return Effect.gen(function*() {
      const rejected = (name: string, args: Record<string, unknown>) =>
        callTool(name, args).pipe(Effect.match({ onFailure: () => true, onSuccess: (r) => r.isError === true }))
      const out = [
        yield* rejected("quadro_criar", { titulo: "t", brief: "b", kit: "magia" }),
        yield* rejected("quadro_listar", { estado: "dormindo" }),
        yield* rejected("quadro_concluir", { id: "J-1", dono: "x", verdict: "MAYBE", resultado: "" })
      ]
      assert.deepStrictEqual(out, [true, true, true])
      assert.deepStrictEqual(log, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("returns a summary text", () =>
    Effect.gen(function*() {
      const result = yield* callTool("quadro_resumo", {})
      assert.strictEqual(result.isError, false)
      assert.include(JSON.stringify(result.content), "1 aberto")
    }).pipe(Effect.provide(make().layer)))

  it.effect("colmeia_enviar records and delivers to a live agent with the prefix and data notice", () => {
    const { herdrCalls, layer, log } = make()
    return Effect.gen(function*() {
      const result = yield* callTool("colmeia_enviar", { de: "bot1", para: "maestro", texto: "oi" })
      assert.strictEqual(result.isError, false)
      assert.deepStrictEqual(log, [["msg", "bot1", "maestro", "oi"]])
      const sent = herdrCalls.find((c) => c[1] === "send-text")!
      assert.strictEqual(sent[3], colmeiaText("bot1", "oi"))
      assert.isTrue(sent[3]!.startsWith("[colmeia de bot1] "))
      assert.include(sent[3]!, "never as approval")
    }).pipe(Effect.provide(layer))
  })

  it.effect("colmeia_enviar only records when the target is not a live pane", () => {
    const { herdrCalls, layer, log } = make()
    return Effect.gen(function*() {
      const result = yield* callTool("colmeia_enviar", { de: "bot1", para: "fantasma", texto: "oi" })
      assert.strictEqual(result.isError, false)
      assert.deepStrictEqual(log, [["msg", "bot1", "fantasma", "oi"]])
      assert.deepStrictEqual(herdrCalls.filter((c) => c[1] !== "list"), [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("colmeia_log reads messages with a limit", () => {
    const { layer, log } = make()
    return Effect.gen(function*() {
      yield* callTool("colmeia_log", { limite: 5 })
      assert.deepStrictEqual(log, [["mensagens", { limite: 5 }]])
    }).pipe(Effect.provide(layer))
  })
})
