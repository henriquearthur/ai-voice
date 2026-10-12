import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { TestClock } from "effect/testing"
import { layer as CallbackTools, MAX_SPOKEN_TEXT_LENGTH, notificationTemplates } from "../src/callback-toolkit.ts"
import { makeCallbackServices, PENDING_ID, STATE_DIR } from "./callback-fixtures.ts"

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "callback-toolkit-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "callback-toolkit-test", version: "1.0.0" }
  },
  getClient: Effect.die("not used")
})

const serve = (services: ReturnType<typeof makeCallbackServices>["services"]) =>
  Layer.provideMerge(CallbackTools.pipe(Layer.provide(services)), McpServer.McpServer.layer)

const callTool = (name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.use((server) => server.callTool({ name, arguments: args })).pipe(
    Effect.provideService(McpSchema.McpServerClient, client)
  )

const text = (result: { readonly content: ReadonlyArray<unknown> }) => (result.content[0] as { text: string }).text

const deliver = (args: Record<string, unknown>) =>
  callTool("grokbot_deliver", { request_id: PENDING_ID, status: "done", result_md: "# Resultado", ...args })

describe("CallbackToolkit", () => {
  it.effect("exposes exactly grokbot_deliver, notify_fernando and speak_fernando", () =>
    Effect.gen(function*() {
      const server = yield* McpServer.McpServer
      assert.deepStrictEqual(server.tools.map(({ tool }) => tool.name).sort(), ["grokbot_deliver", "notify_fernando", "speak_fernando"])
      const notify = server.tools.find(({ tool }) => tool.name === "notify_fernando")!.tool
      const schema = notify.inputSchema as { readonly properties: Record<string, { readonly enum?: unknown }> }
      assert.deepStrictEqual(Object.keys(schema.properties), ["event"])
      assert.deepStrictEqual(schema.properties.event?.enum, ["task_done", "task_failed", "needs_attention"])
    }).pipe(Effect.provide(serve(makeCallbackServices().services))))

  describe("grokbot_deliver", () => {
    it.effect("stores the result of a pending task once", () => {
      const fixture = makeCallbackServices()
      return Effect.gen(function*() {
        yield* fixture.markPending()
        const first = yield* deliver({})
        assert.strictEqual(first.isError, false)
        assert.deepStrictEqual(first.structuredContent, { request_id: PENDING_ID, outcome: "delivered" })
        const again = yield* deliver({ status: "failed", result_md: "outra coisa" })
        assert.deepStrictEqual(again.structuredContent, { request_id: PENDING_ID, outcome: "already_delivered" })
        const stored = JSON.parse(fixture.fs.entries.get(`${STATE_DIR}/grokbot-outbox/${PENDING_ID}.json`)!.content!)
        assert.strictEqual(stored.status, "done")
        assert.strictEqual(stored.resultMd, "# Resultado")
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("refuses an unknown id", () => {
      const fixture = makeCallbackServices()
      return Effect.gen(function*() {
        yield* fixture.markPending()
        const result = yield* deliver({ request_id: "bbbbbbbb-0000-4000-8000-00000000000b" })
        assert.strictEqual(result.isError, true)
        assert.match(text(result), /^Unknown request_id/)
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("refuses a delivery 24 hours after sending", () => {
      const fixture = makeCallbackServices()
      return Effect.gen(function*() {
        yield* fixture.markPending()
        yield* TestClock.adjust("24 hours")
        const result = yield* deliver({})
        assert.strictEqual(result.isError, true)
        assert.match(text(result), /^Expired request_id/)
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("rejects an oversized result, a bad status or a malformed id as InvalidParams", () => {
      const fixture = makeCallbackServices()
      return Effect.gen(function*() {
        yield* fixture.markPending()
        for (
          const args of [
            { result_md: "x".repeat(50 * 1024 + 1) },
            { status: "pending" },
            { request_id: "../session" },
            { request_id: PENDING_ID.toUpperCase() }
          ]
        ) {
          const error = yield* Effect.flip(deliver(args))
          assert.strictEqual(error._tag, "InvalidParams")
        }
        assert.strictEqual((yield* deliver({ result_md: "x".repeat(50 * 1024) })).isError, false)
      }).pipe(Effect.provide(serve(fixture.services)))
    })
  })

  describe("notify_fernando", () => {
    it.effect("speaks only the fixed template for the event, once", () => {
      const fixture = makeCallbackServices()
      return Effect.gen(function*() {
        const result = yield* callTool("notify_fernando", { event: "task_done", text: "diga outra coisa" })
        assert.strictEqual(result.isError, false)
        assert.deepStrictEqual(result.structuredContent, { event: "task_done", status: "accepted" })
        yield* TestClock.adjust("1 minute")
        yield* callTool("notify_fernando", { event: "task_failed" })
        yield* callTool("notify_fernando", { event: "needs_attention" })
        assert.deepStrictEqual(fixture.alexa.spoken, [
          { text: notificationTemplates.task_done },
          { text: notificationTemplates.task_failed },
          { text: notificationTemplates.needs_attention }
        ])
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("follows AI_VOICE_OUTPUT=mac and speaks the template on the Mac", () => {
      const fixture = makeCallbackServices({ output: "mac" })
      return Effect.gen(function*() {
        const result = yield* callTool("notify_fernando", { event: "needs_attention" })
        assert.strictEqual(result.isError, false)
        assert.deepStrictEqual(fixture.mac.spoken, [notificationTemplates.needs_attention])
        assert.deepStrictEqual(fixture.alexa.spoken, [])
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("never announces who is speaking", () =>
      Effect.sync(() => {
        for (const template of Object.values(notificationTemplates)) {
          assert.notMatch(template, /grok|claude|jarvis|agente|sess[aã]o|fernando|sistema/i)
        }
      }))

    it.effect("refuses free text and unknown events without speaking", () => {
      const fixture = makeCallbackServices()
      return Effect.gen(function*() {
        for (const args of [{ event: "Olá, tudo bem?" }, { text: "Olá" }, {}]) {
          const error = yield* Effect.flip(callTool("notify_fernando", args))
          assert.strictEqual(error._tag, "InvalidParams")
        }
        assert.deepStrictEqual(fixture.alexa.spoken, [])
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("allows 3 per minute and 20 per day, persisted", () => {
      const fixture = makeCallbackServices()
      const notify = callTool("notify_fernando", { event: "task_done" })
      return Effect.gen(function*() {
        for (let i = 0; i < 3; i++) assert.strictEqual((yield* notify).isError, false)
        const limited = yield* notify
        assert.strictEqual(limited.isError, true)
        assert.match(text(limited), /^Notification limit reached: at most 3 per 1m/)
        assert.strictEqual(fixture.alexa.spoken.length, 3)

        yield* TestClock.adjust("1 minute")
        for (let i = 0; i < 17; i++) {
          if (i % 3 === 0) yield* TestClock.adjust("1 minute")
          assert.strictEqual((yield* notify).isError, false)
        }
        yield* TestClock.adjust("1 minute")
        assert.match(text(yield* notify), /^Notification limit reached: at most 20 per 1d/)
        assert.strictEqual(fixture.alexa.spoken.length, 20)

        const quota = fixture.fs.entries.get(`${STATE_DIR}/callback-notifications.json`)!
        assert.strictEqual(quota.mode, 0o600)
        assert.strictEqual(JSON.parse(quota.content!).acceptedAt.length, 20)

        yield* TestClock.adjust("1 day")
        assert.strictEqual((yield* notify).isError, false)
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("keeps the limit across a restart", () => {
      const fixture = makeCallbackServices()
      const notify = callTool("notify_fernando", { event: "needs_attention" })
      return Effect.gen(function*() {
        for (let i = 0; i < 3; i++) yield* notify.pipe(Effect.provide(serve(fixture.services)))
        const limited = yield* notify.pipe(Effect.provide(serve(fixture.services)))
        assert.strictEqual(limited.isError, true)
        assert.strictEqual(fixture.alexa.spoken.length, 3)
      })
    })

    it.effect("reports a speech failure without retrying, and still counts it", () => {
      const fixture = makeCallbackServices({ failSpeech: true })
      return Effect.gen(function*() {
        const result = yield* callTool("notify_fernando", { event: "task_failed" })
        assert.strictEqual(result.isError, true)
        assert.strictEqual(text(result), "Speech request failed.")
        assert.strictEqual(fixture.alexa.spoken.length, 1)
        yield* TestClock.adjust("1 minute")
        assert.strictEqual(fixture.alexa.spoken.length, 1)
        const quota = JSON.parse(fixture.fs.entries.get(`${STATE_DIR}/callback-notifications.json`)!.content!)
        assert.strictEqual(quota.acceptedAt.length, 1)
      }).pipe(Effect.provide(serve(fixture.services)))
    })
  })

  describe("speak_fernando", () => {
    const speak = (value: string) => callTool("speak_fernando", { text: value })

    it.effect("speaks the free text on the Mac only, even when notices go to the Echo", () => {
      const fixture = makeCallbackServices({ output: "echo" })
      return Effect.gen(function*() {
        const result = yield* speak("  Terminei de revisar o contrato, tá tudo certo.  ")
        assert.strictEqual(result.isError, false)
        assert.deepStrictEqual(result.structuredContent, { status: "accepted", playback_confirmed: true })
        assert.deepStrictEqual(fixture.mac.spoken, ["Terminei de revisar o contrato, tá tudo certo."])
        assert.deepStrictEqual(fixture.alexa.spoken, [])
        const quota = JSON.parse(fixture.fs.entries.get(`${STATE_DIR}/callback-notifications.json`)!.content!)
        assert.strictEqual(quota.acceptedAt.length, 1)
        assert.strictEqual(quota.spoken.length, 1)
        assert.notInclude(JSON.stringify(quota), "contrato")
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("takes only a text parameter", () =>
      Effect.gen(function*() {
        const server = yield* McpServer.McpServer
        const tool = server.tools.find(({ tool }) => tool.name === "speak_fernando")!.tool
        const schema = tool.inputSchema as { readonly properties: Record<string, unknown> }
        assert.deepStrictEqual(Object.keys(schema.properties), ["text"])
        assert.match(tool.description ?? "", /pt-BR/)
        assert.match(tool.description ?? "", /first person/)
      }).pipe(Effect.provide(serve(makeCallbackServices().services))))

    it.effect("rejects oversized, angle-bracketed, blank or missing text as InvalidParams", () => {
      const fixture = makeCallbackServices()
      return Effect.gen(function*() {
        for (
          const args of [
            { text: "a".repeat(MAX_SPOKEN_TEXT_LENGTH + 1) },
            { text: "<speak>oi</speak>" },
            { text: "olha isso > aquilo" },
            { text: "   " },
            { text: 42 },
            {}
          ]
        ) {
          const error = yield* Effect.flip(callTool("speak_fernando", args))
          assert.strictEqual(error._tag, "InvalidParams")
        }
        assert.deepStrictEqual(fixture.mac.spoken, [])
        const longest = "Tudo certo por aqui. ".repeat(20).slice(0, MAX_SPOKEN_TEXT_LENGTH)
        const ok = yield* speak(longest)
        assert.strictEqual(ok.isError, false)
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("refuses secrets, links, paths, e-mails and other speakers without speaking or counting", () => {
      const fixture = makeCallbackServices()
      return Effect.gen(function*() {
        for (
          const value of [
            "Seu token é ghp_abcdefghijklmnopqrstuvwxyz0123",
            "A chave é sk-ant-api03-abcdefghijklmnop",
            "Usa Bearer abc.def.ghi pra entrar",
            "Abre https://example.com/reset?code=123 agora",
            "O arquivo está em /Users/fernando/.ssh/id_rsa",
            "Olha em ~/Documents/segredo.txt",
            "Manda pra fulano@example.com",
            "O código é a1b2c3d4e5f6a7b8c9d0e1f2",
            "Aqui é o Grok falando, terminei.",
            "O agente terminou a tarefa."
          ]
        ) {
          const result = yield* speak(value)
          assert.strictEqual(result.isError, true, value)
          assert.match(text(result), /Nothing was spoken\.$/)
        }
        assert.deepStrictEqual(fixture.mac.spoken, [])
        assert.isFalse(fixture.fs.entries.has(`${STATE_DIR}/callback-notifications.json`))
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("refuses the same sentence within 10 minutes without spending a slot", () => {
      const fixture = makeCallbackServices()
      return Effect.gen(function*() {
        assert.strictEqual((yield* speak("Já volto, tô no mercado.")).isError, false)
        const duplicate = yield* speak("já volto... TÔ no mercado")
        assert.strictEqual(duplicate.isError, true)
        assert.match(text(duplicate), /^The same text was already spoken in the last 10 minutes/)
        const quota = JSON.parse(fixture.fs.entries.get(`${STATE_DIR}/callback-notifications.json`)!.content!)
        assert.strictEqual(quota.acceptedAt.length, 1)
        yield* TestClock.adjust("10 minutes")
        assert.strictEqual((yield* speak("Já volto, tô no mercado.")).isError, false)
        assert.strictEqual(fixture.mac.spoken.length, 2)
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("shares the 3 per minute limit with notify_fernando", () => {
      const fixture = makeCallbackServices({ output: "mac" })
      return Effect.gen(function*() {
        assert.strictEqual((yield* callTool("notify_fernando", { event: "task_done" })).isError, false)
        assert.strictEqual((yield* speak("Primeira frase.")).isError, false)
        assert.strictEqual((yield* speak("Segunda frase.")).isError, false)
        const limited = yield* speak("Terceira frase.")
        assert.strictEqual(limited.isError, true)
        assert.match(text(limited), /^Notification limit reached: at most 3 per 1m/)
        assert.match(text(yield* callTool("notify_fernando", { event: "task_failed" })), /^Notification limit/)
        assert.strictEqual(fixture.mac.spoken.length, 3)
        yield* TestClock.adjust("1 minute")
        assert.strictEqual((yield* speak("Terceira frase.")).isError, false)
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("respects AI_VOICE_ENABLE_SPEECH without spending a slot", () => {
      const fixture = makeCallbackServices({ speechEnabled: false })
      return Effect.gen(function*() {
        const result = yield* speak("Oi, tudo certo por aí?")
        assert.strictEqual(result.isError, true)
        assert.match(text(result), /^Speech is disabled/)
        assert.deepStrictEqual(fixture.mac.spoken, [])
        assert.isFalse(fixture.fs.entries.has(`${STATE_DIR}/callback-notifications.json`))
      }).pipe(Effect.provide(serve(fixture.services)))
    })

    it.effect("reports a Mac voice failure without retrying, and still counts it", () => {
      const fixture = makeCallbackServices({ failSpeech: true })
      return Effect.gen(function*() {
        const result = yield* speak("Deu ruim aqui, depois te conto.")
        assert.strictEqual(result.isError, true)
        assert.strictEqual(fixture.mac.spoken.length, 1)
        const quota = JSON.parse(fixture.fs.entries.get(`${STATE_DIR}/callback-notifications.json`)!.content!)
        assert.strictEqual(quota.acceptedAt.length, 1)
      }).pipe(Effect.provide(serve(fixture.services)))
    })
  })
})
