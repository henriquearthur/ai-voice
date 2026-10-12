import { Clock, Config, Context, Crypto, Effect, Function, Layer, Redacted, Schema } from "effect"
import { Hex } from "effect/encoding"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { GrokBotError } from "./grokbot-error.ts"
import { GrokBotOutbox } from "./outbox.ts"

export const MAX_TASK_LENGTH = 8000
export const MAX_CONTEXT_LENGTH = 20000

export const GrokBotTask = Schema.Struct({
  task: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(MAX_TASK_LENGTH)),
  context: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_CONTEXT_LENGTH)))
})

/**
 * A 2xx from the webhook only means the routine started; its result is not
 * part of the response.
 */
export const GrokBotDispatch = Schema.Struct({
  requestId: Schema.String,
  status: Schema.Literal("started")
})

const WebhookBody = Schema.Struct({
  task: Schema.String,
  context: Schema.optionalKey(Schema.String),
  requestId: Schema.String
}).pipe(Schema.encodeKeys({ requestId: "request_id" }))

const HttpsUrl = Schema.String.check(
  Schema.makeFilter((url) => URL.canParse(url) && new URL(url).protocol === "https:", {
    expected: "an https URL"
  })
)

// The webhook URL may embed a token, so it stays redacted like the key.
const GrokBotConfig = Config.all({
  webhookUrl: Config.schema(Schema.Redacted(HttpsUrl), "GROKBOT_WEBHOOK_URL"),
  key: Config.Redacted("GROKBOT_KEY")
})

const TIMEOUT = "15 seconds"

const doNotResend = "Do not resend it automatically: it may already be running."

const unreachable = () =>
  new GrokBotError({ message: `Could not reach Grok Bot, so the outcome is uncertain. ${doNotResend}` })

const timedOut = () =>
  new GrokBotError({
    message: `Grok Bot did not answer within ${TIMEOUT}, so the outcome is uncertain. ${doNotResend}`
  })

const make = Effect.gen(function*() {
  const { key, webhookUrl } = yield* GrokBotConfig
  const client = yield* HttpClient.HttpClient
  const crypto = yield* Crypto.Crypto
  const outbox = yield* GrokBotOutbox

  const decodeTask = Schema.decodeUnknownEffect(GrokBotTask)

  // At most once: a single attempt with no retry, because a lost response does
  // not mean the routine did not start. Errors never carry the HttpClientError,
  // whose request holds the webhook URL and the Authorization header.
  const send = Effect.fn("GrokBot.send")(function*(input: typeof GrokBotTask.Encoded) {
    const { context, task } = yield* decodeTask(input).pipe(
      Effect.mapError((error) => new GrokBotError({ message: `Invalid Grok Bot task: ${error.message}` }))
    )
    const requestId = yield* crypto.randomUUIDv4().pipe(
      Effect.mapError(() => new GrokBotError({ message: "Could not generate a request id; nothing was sent." }))
    )
    yield* Effect.annotateCurrentSpan({ requestId })

    // Recorded before the POST, so a result can never arrive for an id the outbox does not know.
    yield* crypto.digest("SHA-256", new TextEncoder().encode(task)).pipe(
      Effect.flatMap((digest) =>
        Effect.flatMap(Clock.currentTimeMillis, (sentAt) =>
          outbox.markPending({ requestId, taskHash: Hex.encode(digest), sentAt }))
      ),
      Effect.mapError(() => new GrokBotError({ message: "Could not record the task in the outbox; nothing was sent." }))
    )

    const request = yield* HttpClientRequest.post(Redacted.value(webhookUrl)).pipe(
      HttpClientRequest.bearerToken(key),
      HttpClientRequest.acceptJson,
      HttpClientRequest.schemaBodyJson(WebhookBody)(context === undefined ? { task, requestId } : {
        task,
        context,
        requestId
      }),
      Effect.mapError(() => new GrokBotError({ message: "Could not encode the Grok Bot request; nothing was sent." }))
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(unreachable),
      Effect.timeoutOrElse({ duration: TIMEOUT, orElse: () => Effect.fail(timedOut()) }),
      // A redirect must not replay the POST.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      // Client spans record url.full, which would expose the webhook URL.
      Effect.provideService(HttpClient.TracerDisabledWhen, Function.constTrue)
    )
    if (response.status < 200 || response.status >= 300) {
      return yield* new GrokBotError({
        message: `Grok Bot answered HTTP ${response.status}, so the task was not confirmed as started. ${doNotResend}`
      })
    }
    return GrokBotDispatch.make({ requestId, status: "started" })
  })

  return GrokBot.of({ send })
})

/**
 * Dispatches tasks to the user's Grok Bot routine through its webhook.
 *
 * Reads `GROKBOT_WEBHOOK_URL` (https only) and `GROKBOT_KEY`, both redacted.
 * Each task is marked pending in the `GrokBotOutbox` before it is sent.
 */
export class GrokBot extends Context.Service<GrokBot, {
  send(input: typeof GrokBotTask.Encoded): Effect.Effect<typeof GrokBotDispatch.Type, GrokBotError>
}>()("@jarvis/grokbot/GrokBot") {
  /**
   * The webhook client over an outbox provided separately.
   */
  static readonly layerWithoutOutbox = Layer.effect(GrokBot, make)

  /**
   * The webhook client with the outbox in the Jarvis state directory.
   */
  static readonly layer = GrokBot.layerWithoutOutbox.pipe(Layer.provide(GrokBotOutbox.layer))
}
