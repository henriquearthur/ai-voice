import { Cause, Effect, FileSystem, Queue, Schema, Stream } from "effect"
import { ChildProcess } from "effect/process"

const serverEntry = new URL("../src/main.ts", import.meta.url).pathname

const JsonRpcResponse = Schema.Struct({
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String }))
})
export type JsonRpcResponse = typeof JsonRpcResponse.Type

export const decodeJsonRpcResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcResponse))

export const ToolResult = Schema.Struct({
  isError: Schema.optionalKey(Schema.Boolean),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }))
})

export const ToolList = Schema.Struct({
  tools: Schema.Array(Schema.Struct({
    name: Schema.String,
    description: Schema.optionalKey(Schema.String),
    inputSchema: Schema.Unknown,
    annotations: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown))
  }))
})

export const initializeParams = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "jarvis-voice-test", version: "1.0.0" }
}

/**
 * Environment for a server that can never reach the real Amazon account:
 * an empty state directory, speech disabled and no inherited variables.
 */
export const isolatedEnv = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "jarvis-voice-test-" })
  return {
    PATH: process.env.PATH ?? "",
    HOME: stateDir,
    AI_VOICE_STATE_DIR: stateDir,
    AI_VOICE_ENABLE_SPEECH: "0",
    AI_VOICE_LOCALE: "pt-BR"
  }
})

/**
 * Spawns `bun src/main.ts` with extra variables over `isolatedEnv`.
 */
export const spawnServer = Effect.fnUntraced(function*(env: Record<string, string> = {}) {
  const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
  const handle = yield* ChildProcess.make("bun", [serverEntry], {
    env: { ...(yield* isolatedEnv), ...env },
    extendEnv: false,
    stdin: Stream.fromQueue(stdin)
  })
  return { handle, stdin }
})

/**
 * A newline-delimited JSON-RPC client over the stdio of a spawned server.
 * Every stdout line must decode as a JSON-RPC message, or requests time out.
 */
export const stdioClient = Effect.fnUntraced(function*(env: Record<string, string> = {}) {
  const { handle, stdin } = yield* spawnServer(env)
  const responses = yield* Queue.unbounded<JsonRpcResponse>()
  yield* handle.stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.mapEffect((line) => decodeJsonRpcResponse(line)),
    Stream.runForEach((response) => Queue.offer(responses, response)),
    Effect.forkScoped
  )
  const encoder = new TextEncoder()
  const send = (message: object) =>
    Queue.offer(stdin, encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`))
  let nextId = 0
  const request = Effect.fnUntraced(function*(method: string, params: object = {}) {
    const id = ++nextId
    yield* send({ id, method, params })
    while (true) {
      const response = yield* Queue.take(responses)
      if (response.id === id) return response
    }
  }, Effect.timeout("15 seconds"))
  const notify = (method: string) => send({ method })
  const sendRaw = (line: string) => Queue.offer(stdin, encoder.encode(`${line}\n`))
  // Closing stdin is how clients stop a stdio server.
  const close = Queue.end(stdin).pipe(Effect.andThen(handle.exitCode), Effect.timeout("15 seconds"))
  const toolNames = request("initialize", initializeParams).pipe(
    Effect.andThen(notify("notifications/initialized")),
    Effect.andThen(request("tools/list")),
    Effect.flatMap((response) => Schema.decodeUnknownEffect(ToolList)(response.result)),
    Effect.map(({ tools }) => tools.map((tool) => tool.name).sort())
  )
  return { request, notify, sendRaw, close, toolNames, stderr: handle.stderr }
})

/**
 * A Streamable HTTP MCP client over any fetch-like handler, keeping the session
 * and negotiated protocol headers between requests.
 */
export const httpClient = (url: string, handle: (request: Request) => Promise<Response>) => {
  const sessionHeaders: Record<string, string> = {}
  let nextId = 0
  const post = (body: object, headers: Record<string, string> = {}) =>
    Effect.promise(() =>
      handle(
        new Request(url, {
          method: "POST",
          headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...sessionHeaders,
            ...headers
          },
          body: JSON.stringify({ jsonrpc: "2.0", ...body })
        })
      )
    ).pipe(Effect.tap((response) =>
      Effect.sync(() => {
        const session = response.headers.get("mcp-session-id")
        if (session !== null) sessionHeaders["mcp-session-id"] = session
      })
    ))
  const request = Effect.fnUntraced(function*(method: string, params: object = {}) {
    const response = yield* post({ id: ++nextId, method, params })
    const text = yield* Effect.promise(() => response.text())
    // Responses may be framed as server-sent events; the result is the last data line.
    const payload = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).at(-1)
    return yield* decodeJsonRpcResponse(payload ?? text)
  }, Effect.timeout("15 seconds"))
  const initialize = Effect.gen(function*() {
    const response = yield* request("initialize", initializeParams)
    sessionHeaders["mcp-protocol-version"] = initializeParams.protocolVersion
    yield* post({ method: "notifications/initialized" })
    return response
  })
  const remove = Effect.promise(() =>
    handle(new Request(url, { method: "DELETE", headers: sessionHeaders }))
  )
  return { post, request, initialize, delete: remove }
}
