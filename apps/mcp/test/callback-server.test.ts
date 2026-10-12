import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Option, Redacted, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { DEFAULT_PORT, loadCallbackToken, MAX_BODY_BYTES } from "../src/callback-server.ts"
import { notificationTemplates } from "../src/callback-toolkit.ts"
import { makeMemoryFileSystem, PENDING_ID, STATE_DIR } from "./callback-fixtures.ts"
import { httpClient, initializeParams, ToolList, ToolResult } from "./mcp-client.ts"

const TOKEN = "Zm9vYmFyLWNhbGxiYWNrLXRva2VuLWZvci10ZXN0cy1vbmx5"

const decodeToolList = Schema.decodeUnknownEffect(ToolList)
const decodeToolResult = Schema.decodeUnknownEffect(ToolResult)

const entry = new URL("./callback-server-entry.ts", import.meta.url).pathname

/**
 * Spawns the real server under Bun on a port the OS picks, with a fake Alexa
 * that reports each notice on stdout. The process is killed with the scope.
 */
const spawnCallbackServer = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "jarvis-callback-test-" })
  const handle = yield* ChildProcess.make("bun", [entry], {
    env: { PATH: process.env.PATH ?? "", HOME: stateDir, AI_VOICE_STATE_DIR: stateDir, JARVIS_CALLBACK_TOKEN: TOKEN },
    extendEnv: false
  })
  const spoken: Array<string> = []
  yield* handle.stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) => Effect.sync(() => spoken.push(JSON.parse(line).spoken))),
    Effect.forkScoped
  )
  const stderr: Array<string> = []
  const listening = yield* handle.stderr.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.tap((line) => Effect.sync(() => stderr.push(line))),
    Stream.filter((line) => line.includes("listening on")),
    Stream.runHead,
    Effect.timeout("15 seconds")
  )
  const base = Option.getOrThrow(listening).match(/listening on (http:\/\/127\.0\.0\.1:\d+)$/)?.[1]
  assert.isDefined(base)
  // Whatever the server logs must never carry the token.
  yield* handle.stderr.pipe(
    Stream.decodeText,
    Stream.runForEach((chunk) => Effect.sync(() => stderr.push(chunk))),
    Effect.forkScoped
  )
  return { base, spoken, stderr }
}).pipe(Effect.provide(BunServices.layer))

const initialize = (url: string, headers: Record<string, string> = {}) =>
  Effect.promise(() =>
    fetch(url, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams })
    })
  )

const swapCase = (text: string) =>
  [...text].map((char) => char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()).join("")

describe("callback server", () => {
  it.live("answers only on /mcp/<token>; everything else is an empty 404", () =>
    Effect.gen(function*() {
      const { base, stderr } = yield* spawnCallbackServer

      const valid = yield* initialize(`${base}/mcp/${TOKEN}`)
      assert.strictEqual(valid.status, 200)

      const rejected = [
        `/mcp/${TOKEN}x`,
        `/mcp/${TOKEN}/`,
        `/mcp/${TOKEN}/mcp`,
        `/mcp/${TOKEN}?x=1`,
        `/mcp/${TOKEN.slice(0, -1)}`,
        `/mcp/x${TOKEN}`,
        `/mcp/${TOKEN.slice(1)}`,
        `/mcp/${swapCase(TOKEN)}`,
        `/MCP/${TOKEN}`,
        `/mcp/wrong-token`,
        `/mcp/`,
        `/mcp`,
        `/`,
        `/${TOKEN}`,
        `/other/${TOKEN}`,
        `/x/mcp/${TOKEN}`
      ]
      for (const path of rejected) {
        for (const method of ["POST", "GET", "DELETE"]) {
          const response = method === "POST"
            ? yield* initialize(`${base}${path}`)
            : yield* Effect.promise(() => fetch(`${base}${path}`, { method }))
          assert.strictEqual(response.status, 404, `${method} ${path.replace(TOKEN, "<token>")}`)
          assert.strictEqual(yield* Effect.promise(() => response.text()), "")
        }
      }
      assert.notInclude(stderr.join("\n"), TOKEN)
    }), 30_000)

  it.live("accepts a server-side connector whatever Origin it sends", () =>
    Effect.gen(function*() {
      const { base } = yield* spawnCallbackServer
      const withOrigin = yield* initialize(`${base}/mcp/${TOKEN}`, { origin: "https://grok.com" })
      assert.strictEqual(withOrigin.status, 200)
    }), 30_000)

  it.live("refuses a body over the limit", () =>
    Effect.gen(function*() {
      const { base } = yield* spawnCallbackServer
      const response = yield* Effect.promise(() =>
        fetch(`${base}/mcp/${TOKEN}`, {
          method: "POST",
          headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
          body: "x".repeat(MAX_BODY_BYTES + 1)
        })
      )
      assert.strictEqual(response.status, 413)
    }), 30_000)

  it.live("completes an MCP handshake and serves only the two callback tools", () =>
    Effect.gen(function*() {
      const { base, spoken } = yield* spawnCallbackServer
      const client = httpClient(`${base}/mcp/${TOKEN}`, (request) => fetch(request))

      const initialized = yield* client.initialize
      assert.isUndefined(initialized.error)
      const { tools } = yield* client.request("tools/list").pipe(
        Effect.flatMap((response) => decodeToolList(response.result))
      )
      assert.deepStrictEqual(tools.map((tool) => tool.name).sort(), ["grokbot_deliver", "notify_fernando", "speak_fernando"])

      const delivered = yield* client.request("tools/call", {
        name: "grokbot_deliver",
        arguments: { request_id: PENDING_ID, status: "done", result_md: "# Pronto" }
      }).pipe(Effect.flatMap((response) => decodeToolResult(response.result)))
      assert.isFalse(delivered.isError)
      assert.deepStrictEqual(delivered.structuredContent, { request_id: PENDING_ID, outcome: "delivered" })

      const notified = yield* client.request("tools/call", {
        name: "notify_fernando",
        arguments: { event: "task_done" }
      }).pipe(Effect.flatMap((response) => decodeToolResult(response.result)))
      assert.isFalse(notified.isError)
      assert.deepStrictEqual(spoken, [notificationTemplates.task_done])

      const unknownTool = yield* client.request("tools/call", { name: "speak", arguments: { text: "Olá" } })
      assert.isDefined(unknownTool.error ?? (unknownTool.result as { isError?: boolean }).isError)
      assert.strictEqual(spoken.length, 1)

      assert.strictEqual((yield* client.delete).status, 204)
    }), 30_000)
})

describe("callback token", () => {
  const load = (env: Record<string, string>, fs = makeMemoryFileSystem()) =>
    loadCallbackToken(STATE_DIR).pipe(
      Effect.provide(Layer.mergeAll(fs.layer, BunCrypto.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
    )

  it.effect("creates a private 32-byte token once and reuses it", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      const first = Redacted.value(yield* load({}, fs))
      assert.match(first, /^[A-Za-z0-9_-]{43}$/)
      const file = fs.entries.get(`${STATE_DIR}/callback-token`)!
      assert.strictEqual(file.mode, 0o600)
      assert.strictEqual(fs.entries.get(STATE_DIR)!.mode, 0o700)
      assert.strictEqual(Redacted.value(yield* load({}, fs)), first)
      assert.deepStrictEqual([...fs.entries.keys()].sort(), [STATE_DIR, `${STATE_DIR}/callback-token`])
    }))

  it.effect("prefers JARVIS_CALLBACK_TOKEN and validates it without echoing it", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      assert.strictEqual(Redacted.value(yield* load({ JARVIS_CALLBACK_TOKEN: TOKEN }, fs)), TOKEN)
      assert.isFalse(fs.entries.has(`${STATE_DIR}/callback-token`))
      const exit = yield* Effect.exit(load({ JARVIS_CALLBACK_TOKEN: "short-SECRET" }))
      assert.isTrue(Exit.isFailure(exit))
      assert.notInclude(String(exit), "SECRET")
    }))

  it.effect("refuses a corrupt token file instead of replacing it", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      fs.entries.set(STATE_DIR, { directory: true, mode: 0o700 })
      fs.entries.set(`${STATE_DIR}/callback-token`, { directory: false, mode: 0o600, content: "SECRET" })
      const error = yield* Effect.flip(load({}, fs))
      assert.match(error.message, /not a valid token/)
      assert.notInclude(error.message, "SECRET")
      assert.strictEqual(fs.entries.get(`${STATE_DIR}/callback-token`)!.content, "SECRET")
    }))
})

describe("callback-main --print-url", () => {
  it.live("prints the URL once on stdout and exits", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "jarvis-callback-test-" })
      const handle = yield* ChildProcess.make("bun", [new URL("../src/callback-main.ts", import.meta.url).pathname, "--print-url"], {
        env: { PATH: process.env.PATH ?? "", HOME: stateDir, AI_VOICE_STATE_DIR: stateDir, AI_VOICE_ENABLE_SPEECH: "0" },
        extendEnv: false
      })
      const [stdout, stderr, exitCode] = yield* Effect.all([
        handle.stdout.pipe(Stream.decodeText, Stream.mkString),
        handle.stderr.pipe(Stream.decodeText, Stream.mkString),
        handle.exitCode
      ], { concurrency: "unbounded" })
      assert.strictEqual(exitCode, 0)
      assert.strictEqual(stderr, "")
      const stored = (yield* fs.readFileString(`${stateDir}/callback-token`)).trim()
      assert.strictEqual(stdout, `http://127.0.0.1:${DEFAULT_PORT}/mcp/${stored}\n`)
      assert.strictEqual((yield* fs.stat(`${stateDir}/callback-token`)).mode & 0o777, 0o600)
    }).pipe(Effect.provide(BunServices.layer)), 30_000)
})
