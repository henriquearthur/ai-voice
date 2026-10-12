import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { makeSendSpeech, type SpeechSequence } from "../src/index.ts"

const target = { baseUrl: "alexa.example", cookie: "SECRET-COOKIE", csrf: "SECRET-CSRF", locale: "pt-BR" }
const sequence: SpeechSequence = {
  "@type": "com.amazon.alexa.behaviors.model.Sequence",
  startNode: { operationPayload: { textToSpeak: "Oi" } }
}

const fakeClient = (respond: () => { readonly status: number; readonly body: string } | undefined) => {
  const requests: Array<{ readonly url: URL; readonly headers: Record<string, string>; readonly body: unknown }> = []
  const client = HttpClient.make((request, url) => {
    const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : null
    requests.push({ url, headers: request.headers, body })
    const response = respond()
    return response === undefined
      ? Effect.never
      : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(response.body, { status: response.status })))
  })
  return { send: makeSendSpeech(client), requests }
}

describe("sendSpeech", () => {
  it.effect("POSTs the sequence once with the session headers", () =>
    Effect.gen(function*() {
      const { send, requests } = fakeClient(() => ({ status: 200, body: "" }))
      yield* send(target, sequence)
      assert.strictEqual(requests.length, 1)
      const [request] = requests
      assert.strictEqual(request!.url.href, "https://alexa.example/api/behaviors/preview")
      assert.deepInclude(request!.headers, {
        cookie: "SECRET-COOKIE",
        csrf: "SECRET-CSRF",
        "accept-language": "pt-BR",
        "content-type": "application/json; charset=utf-8"
      })
      assert.notProperty(request!.headers, "traceparent")
      assert.notProperty(request!.headers, "b3")
      assert.deepStrictEqual(request!.body, {
        behaviorId: "PREVIEW",
        sequenceJson: JSON.stringify(sequence),
        status: "ENABLED"
      })
    }))

  it.effect("checks HTTP status and JSON errors, does not retry and does not leak credentials", () =>
    Effect.gen(function*() {
      let response = { status: 403, body: "{\"message\":\"SECRET-COOKIE\"}" }
      const { send, requests } = fakeClient(() => response)
      const rejected = yield* Effect.flip(send(target, sequence))
      assert.match(rejected.message, /HTTP 403/)
      response = { status: 200, body: "{\"message\":\"SECRET-COOKIE\"}" }
      assert.match((yield* Effect.flip(send(target, sequence))).message, /returned an error/)
      response = { status: 200, body: "{\"success\":false}" }
      assert.match((yield* Effect.flip(send(target, sequence))).message, /returned an error/)
      for (const body of ["<html>login</html>", "[]", "\"ok\""]) {
        response = { status: 200, body }
        assert.match((yield* Effect.flip(send(target, sequence))).message, /Unexpected/)
      }
      response = { status: 200, body: "{\"ok\":true}" }
      yield* send(target, sequence)
      assert.strictEqual(requests.length, 7)
      assert.notInclude(rejected.message, "SECRET")
    }))

  it.effect("gives up after 10 seconds without retrying", () =>
    Effect.gen(function*() {
      const { send, requests } = fakeClient(() => undefined)
      const fiber = yield* Effect.forkChild(Effect.flip(send(target, sequence)))
      yield* TestClock.adjust("10 seconds")
      const error = yield* Fiber.join(fiber)
      assert.match(error.message, /Could not reach Alexa; playback not confirmed. Do not retry/)
      assert.strictEqual(requests.length, 1)
    }))
})
