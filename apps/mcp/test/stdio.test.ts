import * as BunServices from "@effect/platform-bun/BunServices"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Schema, Stream } from "effect"
import { initializeParams, stdioClient, ToolList, ToolResult } from "./mcp-client.ts"

const decodeToolList = Schema.decodeUnknownEffect(ToolList)
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult)

describe("stdio transport", () => {
  it.live("serves the voice tools without a session or audio", () =>
    Effect.gen(function*() {
      const client = yield* stdioClient()

      // Malformed input must neither crash the server nor put anything but JSON-RPC on stdout.
      yield* client.sendRaw("not json")
      yield* client.sendRaw("{}")
      const initialized = yield* client.request("initialize", initializeParams)
      assert.isUndefined(initialized.error)
      assert.include(JSON.stringify(initialized.result), "Prefer short messages in the language of locale pt-BR")
      yield* client.notify("notifications/initialized")

      const { tools } = yield* client.request("tools/list").pipe(
        Effect.flatMap((response) => decodeToolList(response.result))
      )
      assert.deepStrictEqual(tools.map((tool) => tool.name).sort(), [
        "calendar_calendars",
        "calendar_events",
        "calendar_today",
        "colmeia_enviar",
        "colmeia_log",
        "herdr_agents",
        "herdr_key",
        "herdr_read",
        "herdr_send",
        "list_devices",
        "maps_directions",
        "maps_search",
        "phone_call",
        "quadro_concluir",
        "quadro_criar",
        "quadro_listar",
        "quadro_pegar",
        "quadro_resumo",
        "reminders_add",
        "reminders_list",
        "reminders_lists",
        "speak"
      ])
      const speakTool = tools.find((tool) => tool.name === "speak")
      assert.deepStrictEqual(speakTool?.annotations, {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      })
      assert.include(speakTool?.description, "locale pt-BR")
      assert.include(JSON.stringify(speakTool?.inputSchema), "device_serial")
      assert.include(JSON.stringify(speakTool?.inputSchema), "4000")
      assert.strictEqual(tools.find((tool) => tool.name === "list_devices")?.annotations?.readOnlyHint, true)

      const speak = yield* client.request("tools/call", { name: "speak", arguments: { text: "Test" } }).pipe(
        Effect.flatMap((response) => decodeToolResult(response.result))
      )
      assert.isTrue(speak.isError)
      assert.match(speak.content[0].text, /^Speech is disabled/)

      const devices = yield* client.request("tools/call", { name: "list_devices", arguments: {} }).pipe(
        Effect.flatMap((response) => decodeToolResult(response.result))
      )
      assert.isTrue(devices.isError)
      assert.match(devices.content[0].text, /^Amazon session is missing/)

      const exitCode = yield* client.close
      assert.strictEqual(exitCode, 0)
    }).pipe(Effect.provide(BunServices.layer)), 30_000)

  // Never called here: it would POST to the webhook.
  it.live("adds grokbot_send only when the Grok Bot webhook is configured", () =>
    Effect.gen(function*() {
      const configured = yield* stdioClient({
        GROKBOT_WEBHOOK_URL: "https://grokbot.invalid/hook",
        GROKBOT_KEY: "test-key"
      })
      assert.include(yield* configured.toolNames, "grokbot_send")

      const keyOnly = yield* stdioClient({ GROKBOT_KEY: "test-key" })
      const keyOnlyTools = yield* keyOnly.toolNames
      assert.notInclude(keyOnlyTools, "grokbot_send")
      assert.include(keyOnlyTools, "speak")

      // A bad value disables the tool with a note on stderr instead of taking voice down.
      const invalid = yield* stdioClient({ GROKBOT_WEBHOOK_URL: "http://plain.invalid/hook", GROKBOT_KEY: "test-key" })
      const invalidTools = yield* invalid.toolNames
      assert.notInclude(invalidTools, "grokbot_send")
      assert.include(invalidTools, "speak")
      assert.strictEqual(yield* invalid.close, 0)
      const stderr = yield* invalid.stderr.pipe(Stream.decodeText, Stream.mkString)
      assert.include(stderr, "grokbot_send disabled")
      assert.notInclude(stderr, "test-key")
    }).pipe(Effect.provide(BunServices.layer)), 30_000)
})
