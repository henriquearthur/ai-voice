import { BunHttpServer } from "@effect/platform-bun"
import { Console, Crypto, Effect, FileSystem, Function, Layer, Option, Path, Random, Redacted, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import { HttpMiddleware, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { timingSafeEqual } from "node:crypto"
import { HOSTNAME } from "./config.ts"
import { Fila, MAX_TEXTO } from "./fila.ts"

export const MAX_BODY_BYTES = 64 * 1024

export const PREFIX = "/evento/"

const TOKEN_BYTES = 32

export class TokenError extends Schema.TaggedError<TokenError>()("TokenError", { message: Schema.String }) {}

const isToken = (token: string) => /^[A-Za-z0-9_-]{43,}$/.test(token)

/**
 * O token do caminho secreto, em `<arquivo>` (0600, numa pasta 0700), criado
 * com 32 bytes aleatórios no primeiro uso. Mesmo esquema do callback-server do apps/mcp.
 */
export const loadToken = Effect.fn("loadToken")(function*(file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crypto = yield* Crypto.Crypto
  const read = fs.readFileString(file).pipe(Effect.map((contents) => contents.trim()))
  const existing = yield* read.pipe(
    Effect.map(Option.some),
    Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeedNone)
  )
  let token: string
  if (Option.isSome(existing)) {
    token = existing.value
  } else {
    const dir = path.dirname(file)
    yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
    yield* fs.chmod(dir, 0o700)
    const fresh = Base64Url.encode(yield* crypto.randomBytes(TOKEN_BYTES))
    const temporary = `${file}.${yield* Random.nextInt}.tmp`
    // O hard link publica o arquivo completo e falha se outro processo criou um antes.
    const created = yield* Effect.gen(function*() {
      yield* fs.writeFileString(temporary, fresh, { mode: 0o600 })
      yield* fs.chmod(temporary, 0o600)
      return yield* fs.link(temporary, file).pipe(
        Effect.as(true),
        Effect.catchIf((error) => error.reason._tag === "AlreadyExists", () => Effect.succeed(false))
      )
    }).pipe(Effect.ensuring(Effect.ignore(fs.remove(temporary))))
    token = created ? fresh : yield* read
  }
  if (!isToken(token)) {
    return yield* new TokenError({ message: `O token em ${file} é inválido. Apague o arquivo para gerar outro.` })
  }
  return Redacted.make(token)
}, Effect.catchTag("PlatformError", (error) => Effect.fail(new TokenError({ message: `Não consegui ler ou criar o token: ${error.message}` }))))

export const eventoUrl = (port: number, token: Redacted.Redacted<string>) =>
  `http://${HOSTNAME}:${port}${PREFIX}${Redacted.value(token)}`

const utf8 = new TextEncoder()

/** Se o caminho é exatamente `/evento/<token>`, comparado em tempo constante sobre SHA-256. */
export const makeAuthorizer = Effect.fnUntraced(function*(token: Redacted.Redacted<string>) {
  const crypto = yield* Crypto.Crypto
  const expected = yield* crypto.digest("SHA-256", utf8.encode(Redacted.value(token)))
  return (url: string): Effect.Effect<boolean> => {
    const pathname = url.split("?")[0]!
    if (!pathname.startsWith(PREFIX)) return Effect.succeed(false)
    return crypto.digest("SHA-256", utf8.encode(pathname.slice(PREFIX.length))).pipe(
      Effect.map((candidate) => candidate.length === expected.length && timingSafeEqual(candidate, expected)),
      Effect.orElseSucceed(() => false)
    )
  }
})

export const EventoBody = Schema.Struct({
  origem: Schema.String.check(Schema.isMinLength(1)),
  texto: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_TEXTO))
})

const notFound = HttpServerResponse.empty({ status: 404 })

const serve = (token: Redacted.Redacted<string>) =>
  Effect.gen(function*() {
    const isAuthorized = yield* makeAuthorizer(token)
    const fila = yield* Fila
    yield* HttpServer.serveEffect(Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      if (!(yield* isAuthorized(request.url))) return notFound
      if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } })
      const body = yield* HttpServerRequest.schemaBodyJson(EventoBody).pipe(Effect.option)
      if (Option.isNone(body)) {
        return HttpServerResponse.jsonUnsafe(
          { erro: "Mande JSON {\"origem\": \"...\", \"texto\": \"...\"}." },
          { status: 400 }
        )
      }
      const evento = yield* fila.adicionar(body.value.origem, body.value.texto)
      return HttpServerResponse.jsonUnsafe({ id: evento.id, origem: evento.origem }, { status: 202 })
    }))
  })

/**
 * Recebe eventos em `POST http://127.0.0.1:<port>/evento/<token>`; qualquer
 * outro caminho responde 404 vazio. Nada registra a URL, que leva o token.
 */
export const EventosServer = (options: { readonly port: number; readonly token: Redacted.Redacted<string> }) =>
  Layer.effectDiscard(serve(options.token)).pipe(
    Layer.provide(Layer.succeed(HttpMiddleware.TracerDisabledWhen, Function.constTrue)),
    Layer.provideMerge(BunHttpServer.layerServer({
      hostname: HOSTNAME,
      port: options.port,
      maxRequestBodySize: MAX_BODY_BYTES
    }))
  )

export const EventosTransport = (options: { readonly port: number; readonly token: Redacted.Redacted<string> }) =>
  Layer.effectDiscard(HttpServer.addressFormattedWith((url) => Console.error(`Fila de eventos ouvindo em ${url}`))).pipe(
    Layer.provideMerge(EventosServer(options))
  )
