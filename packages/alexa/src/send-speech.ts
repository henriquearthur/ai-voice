import { Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { SpeechError } from "./alexa-error.ts"
import { USER_AGENT } from "./alexa-remote.ts"
import type { SpeechSequence } from "./speech.ts"

export interface SpeechTarget {
  readonly baseUrl: string
  readonly cookie: string
  readonly csrf: string
  readonly locale: string
}

export type SendSpeech = (target: SpeechTarget, sequence: SpeechSequence) => Effect.Effect<void, SpeechError>

const PreviewResponse = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const looksLikeError = (body: typeof PreviewResponse.Type) =>
  Boolean(body.error || body.errors || body.errorMessage || body.message || body.code) || body.success === false

const notConfirmed = (message: string) => new SpeechError({ message: `${message}; playback not confirmed.` })

const unreachable = () =>
  new SpeechError({ message: "Could not reach Alexa; playback not confirmed. Do not retry automatically." })

// Bypasses the library transport, which retries some 503/throttling responses and ignores the
// HTTP status. Single attempt: a timeout or error does not justify repeating speech that may
// have been received. Error messages never echo the response, which may carry credentials.
export const makeSendSpeech = (client: HttpClient.HttpClient): SendSpeech =>
  Effect.fn("Alexa.sendSpeech")(function*(target: SpeechTarget, sequence: SpeechSequence) {
    const request = HttpClientRequest.post(`https://${target.baseUrl}/api/behaviors/preview`).pipe(
      HttpClientRequest.setHeaders({
        Cookie: target.cookie,
        csrf: target.csrf,
        "User-Agent": USER_AGENT,
        "Accept-Language": target.locale,
        Origin: `https://${target.baseUrl}`,
        Referer: `https://${target.baseUrl}/spa/index.html`
      }),
      HttpClientRequest.bodyText(
        JSON.stringify({ behaviorId: "PREVIEW", sequenceJson: JSON.stringify(sequence), status: "ENABLED" }),
        "application/json; charset=utf-8"
      )
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError(unreachable),
      // A redirect must not replay the POST.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false)
    )
    const text = yield* Effect.mapError(response.text, () => notConfirmed("Alexa response was interrupted"))
    if (response.status < 200 || response.status >= 300) {
      return yield* new SpeechError({ message: `Alexa rejected the request (HTTP ${response.status}).` })
    }
    if (!text.trim()) return
    const body = yield* Effect.mapError(
      Schema.decodeUnknownEffect(PreviewResponse)(text),
      () => notConfirmed("Unexpected Alexa response")
    )
    if (looksLikeError(body)) {
      return yield* notConfirmed("Alexa returned an error")
    }
  }, Effect.timeoutOrElse({ duration: "10 seconds", orElse: () => Effect.fail(unreachable()) }))
