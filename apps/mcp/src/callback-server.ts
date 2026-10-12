import { BunHttpServer } from "@effect/platform-bun"
import { Config, Console, Crypto, Effect, FileSystem, Function, Layer, Option, Path, Random, Redacted, Schema } from "effect"
import { McpServer } from "effect/ai"
import { Base64Url } from "effect/encoding"
import { Headers, HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { timingSafeEqual } from "node:crypto"
import { layer as CallbackTools } from "./callback-toolkit.ts"
import { protocols, version } from "./server.ts"

export const name = "Jarvis Callback"

export const HOSTNAME = "127.0.0.1"

export const DEFAULT_PORT = 7348

// grokbot_deliver carries at most 50 KB of Markdown, which JSON escaping can inflate several times.
export const MAX_BODY_BYTES = 512 * 1024

const TOKEN_FILE = "callback-token"

const TOKEN_BYTES = 32

const PREFIX = "/mcp/"

// The internal route; the secret path never reaches the router, MCP or any span.
const INTERNAL_PATH = "/mcp"

export class CallbackTokenError extends Schema.TaggedError<CallbackTokenError>()("CallbackTokenError", {
  message: Schema.String
}) {}

// 32 random bytes are 43 base64url characters without padding.
const isToken = (token: string) => /^[A-Za-z0-9_-]{43,}$/.test(token)

export const CallbackConfig = Config.all({
  port: Config.Port("JARVIS_CALLBACK_PORT").pipe(Config.withDefault(DEFAULT_PORT)),
  token: Config.Redacted("JARVIS_CALLBACK_TOKEN").pipe(
    Config.option,
    Config.map(Option.filter((token) => Redacted.value(token) !== ""))
  )
})

const readOrCreateToken = Effect.fnUntraced(function*(stateDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const file = path.join(stateDir, TOKEN_FILE)
  const read = fs.readFileString(file).pipe(Effect.map((contents) => contents.trim()))
  const existing = yield* read.pipe(
    Effect.map(Option.some),
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeedNone)
  )
  if (Option.isSome(existing)) return existing.value

  yield* fs.makeDirectory(stateDir, { recursive: true, mode: 0o700 })
  yield* fs.chmod(stateDir, 0o700)
  const token = Base64Url.encode(yield* crypto.randomBytes(TOKEN_BYTES))
  const temporary = `${file}.${yield* Random.nextInt}.tmp`
  // A hard link publishes the complete file and fails if another process created one first.
  const created = yield* Effect.gen(function*() {
    yield* fs.writeFileString(temporary, token, { mode: 0o600 })
    yield* fs.chmod(temporary, 0o600)
    return yield* fs.link(temporary, file).pipe(
      Effect.as(true),
      Effect.catchIf((error) => error.reason._tag === "AlreadyExists", () => Effect.succeed(false))
    )
  }).pipe(Effect.ensuring(Effect.ignore(fs.remove(temporary))))
  return created ? token : yield* read
})

/**
 * The secret path segment: `JARVIS_CALLBACK_TOKEN`, or else
 * `<stateDir>/callback-token`, created with 32 random bytes on first use.
 */
export const loadCallbackToken = Effect.fn("loadCallbackToken")(function*(stateDir: string) {
  const { token } = yield* CallbackConfig
  if (Option.isSome(token)) {
    if (!isToken(Redacted.value(token.value))) {
      return yield* new CallbackTokenError({
        message: "JARVIS_CALLBACK_TOKEN must be at least 43 base64url characters (32 random bytes)."
      })
    }
    return token.value
  }
  const stored = yield* readOrCreateToken(stateDir).pipe(
    Effect.mapError(() =>
      new CallbackTokenError({ message: `Could not read or create ${TOKEN_FILE} in the state directory.` })
    )
  )
  if (!isToken(stored)) {
    return yield* new CallbackTokenError({
      message: `${TOKEN_FILE} in the state directory is not a valid token. Delete it to generate a new one.`
    })
  }
  return Redacted.make(stored)
})

export const callbackUrl = (port: number, token: Redacted.Redacted<string>) =>
  `http://${HOSTNAME}:${port}${PREFIX}${Redacted.value(token)}`

const utf8 = new TextEncoder()

/**
 * Whether a request URL is exactly `/mcp/<token>`, compared in constant time
 * over SHA-256 digests so the comparison never depends on the candidate length.
 */
export const makeAuthorizer = Effect.fnUntraced(function*(token: Redacted.Redacted<string>) {
  const crypto = yield* Crypto.Crypto
  const expected = yield* crypto.digest("SHA-256", utf8.encode(Redacted.value(token)))
  return (url: string): Effect.Effect<boolean> => {
    if (!url.startsWith(PREFIX)) return Effect.succeed(false)
    return crypto.digest("SHA-256", utf8.encode(url.slice(PREFIX.length))).pipe(
      Effect.map((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected)),
      Effect.orElseSucceed(() => false)
    )
  }
})

/**
 * Registers the callback MCP endpoint, at an internal path, on the `HttpRouter`.
 */
export const CallbackRoutes = CallbackTools.pipe(
  Layer.provide(McpServer.layerHttp({
    name,
    version,
    instructions: "Deliver task results with grokbot_deliver. Use notify_fernando for a short fixed spoken notice, " +
      "or speak_fernando for one short pt-BR sentence spoken on the Mac; both share a rate limit and must not be retried.",
    protocols,
    path: INTERNAL_PATH,
    allowSessionTermination: true
  }))
)

const notFound = HttpServerResponse.empty({ status: 404 })

const serveCallback = (token: Redacted.Redacted<string>) =>
  Effect.gen(function*() {
    const app = yield* HttpRouter.toHttpEffect(CallbackRoutes)
    const isAuthorized = yield* makeAuthorizer(token)
    yield* HttpServer.serveEffect(Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!(yield* isAuthorized(request.url))) return notFound
      // The path secret is the authentication, so Origin adds nothing here, and a
      // server-side connector may send its own Origin that no allowlist can predict.
      const forwarded = request.modify({ url: INTERNAL_PATH, headers: Headers.remove(request.headers, "origin") })
      return yield* app.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, forwarded))
    }))
  })

/**
 * Serves the callback tools on `http://127.0.0.1:<port>/mcp/<token>` only;
 * every other path answers 404 with an empty body.
 *
 * Nothing logs or traces request URLs, which carry the token.
 */
export const CallbackServer = (options: { readonly port: number; readonly token: Redacted.Redacted<string> }) =>
  Layer.effectDiscard(serveCallback(options.token)).pipe(
    Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen, Function.constTrue)),
    Layer.provideMerge(BunHttpServer.layerServer({
      hostname: HOSTNAME,
      port: options.port,
      maxRequestBodySize: MAX_BODY_BYTES
    }))
  )

/**
 * `CallbackServer`, announcing on stderr where it listens, without the path.
 */
export const CallbackTransport = (options: { readonly port: number; readonly token: Redacted.Redacted<string> }) =>
  Layer.effectDiscard(HttpServer.addressFormattedWith((url) => Console.error(`${name} listening on ${url}`))).pipe(
    Layer.provideMerge(CallbackServer(options))
  )
