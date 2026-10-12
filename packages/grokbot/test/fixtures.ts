import { ConfigProvider, Crypto, Effect, FileSystem, Layer, Path, PlatformError } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { GrokBot, GrokBotOutbox } from "../src/index.ts"

export const STATE_DIR = "/state"
export const OUTBOX_DIR = `${STATE_DIR}/grokbot-outbox`

export interface Entry {
  readonly directory: boolean
  readonly mode: number
  readonly content?: string
}

// In-memory FileSystem covering the calls the outbox makes, recording file modes.
export const makeMemoryFileSystem = (options: { readonly readOnly?: boolean } = {}) => {
  const entries = new Map<string, Entry>()
  const notFound = (method: string, path: string) =>
    PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: path })
  const layer = FileSystem.layerNoop({
    makeDirectory: (path, options) =>
      Effect.sync(() => {
        if (!entries.has(path)) entries.set(path, { directory: true, mode: options?.mode ?? 0o755 })
      }),
    chmod: (path, mode) =>
      Effect.suspend(() => {
        const entry = entries.get(path)
        if (entry === undefined) return Effect.fail(notFound("chmod", path))
        entries.set(path, { ...entry, mode })
        return Effect.void
      }),
    writeFileString: (path, content, writeOptions) =>
      options.readOnly === true
        ? Effect.fail(
          PlatformError.systemError({ _tag: "PermissionDenied", module: "FileSystem", method: "writeFileString" })
        )
        : Effect.sync(() => {
          entries.set(path, {
            directory: false,
            content,
            mode: entries.get(path)?.mode ?? writeOptions?.mode ?? 0o644
          })
        }),
    readFileString: (path) =>
      Effect.suspend(() => {
        const content = entries.get(path)?.content
        return content === undefined ? Effect.fail(notFound("readFileString", path)) : Effect.succeed(content)
      }),
    readDirectory: (path) =>
      Effect.suspend(() =>
        entries.get(path)?.directory === true
          ? Effect.succeed([...entries.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => key.slice(path.length + 1)))
          : Effect.fail(notFound("readDirectory", path))
      ),
    rename: (from, to) =>
      Effect.suspend(() => {
        const entry = entries.get(from)
        if (entry === undefined) return Effect.fail(notFound("rename", from))
        entries.delete(from)
        entries.set(to, entry)
        return Effect.void
      }),
    remove: (path) => Effect.sync(() => void entries.delete(path))
  })
  const files = (directory: string) => [...entries.keys()].filter((key) => key.startsWith(`${directory}/`)).sort()
  const readJson = (path: string): unknown => JSON.parse(entries.get(path)?.content ?? "null")
  return { entries, files, readJson, layer: Layer.merge(layer, Path.layer) }
}

export const WEBHOOK_URL = "https://grokbot.example/hooks/SECRET-PATH-TOKEN"
export const KEY = "SECRET-GROKBOT-KEY"
export const REQUEST_ID = "00000000-0000-4000-8000-000000000000"

export interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

export type Respond = "network-error" | "hang" | number

/**
 * A fake HttpClient that records each request and answers with the given
 * status, a transport error, or never; nothing reaches the network.
 */
export const fakeHttpClient = (respond: () => Respond) => {
  const requests: Array<RecordedRequest> = []
  const client = HttpClient.make((request, url) => {
    const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : null
    requests.push({ method: request.method, url: url.href, headers: request.headers, body })
    const outcome = respond()
    if (outcome === "hang") return Effect.never
    if (outcome === "network-error") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: new Error(`connect ECONNREFUSED ${url.href}`) })
        })
      )
    }
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}", { status: outcome })))
  })
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) }
}

// All-zero bytes make randomUUIDv4 deterministic: REQUEST_ID.
export const FixedCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data)
  })
)

export const env = (overrides: Record<string, string | undefined> = {}) => {
  const values: Record<string, string> = {}
  const defaults = { GROKBOT_WEBHOOK_URL: WEBHOOK_URL, GROKBOT_KEY: KEY, AI_VOICE_STATE_DIR: STATE_DIR }
  for (const [name, value] of Object.entries({ ...defaults, ...overrides })) {
    if (value !== undefined) values[name] = value
  }
  return ConfigProvider.layer(ConfigProvider.fromEnv({ env: values }))
}

export const makeGrokBot = (respond: () => Respond, options: { readonly readOnly?: boolean } = {}) => {
  const http = fakeHttpClient(respond)
  const fs = makeMemoryFileSystem(options)
  return {
    requests: http.requests,
    fs,
    layer: GrokBot.layerWithoutOutbox.pipe(
      Layer.provide(GrokBotOutbox.layerAt(STATE_DIR)),
      Layer.provide(Layer.mergeAll(http.layer, FixedCrypto, fs.layer, env()))
    )
  }
}
