import { assert, describe, expectTypeOf, it } from "@effect/vitest"
import { Config, type Crypto, Effect, Exit, Fiber, type FileSystem, Layer, type Path } from "effect"
import type { HttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { GrokBot, GrokBotError, MAX_CONTEXT_LENGTH, MAX_TASK_LENGTH } from "../src/index.ts"
import {
  env,
  fakeHttpClient,
  FixedCrypto,
  KEY,
  makeGrokBot,
  makeMemoryFileSystem,
  OUTBOX_DIR,
  REQUEST_ID,
  type Respond,
  WEBHOOK_URL
} from "./fixtures.ts"

const send = (input: { readonly task: string; readonly context?: string }) =>
  GrokBot.use((grokbot) => grokbot.send(input))

const assertSafe = (error: GrokBotError) => {
  assert.instanceOf(error, GrokBotError)
  assert.notInclude(error.message, "SECRET")
  assert.notInclude(error.message, "grokbot.example")
}

const withGrokBot = <A, E>(
  respond: () => Respond,
  f: (requests: ReturnType<typeof makeGrokBot>["requests"]) => Effect.Effect<A, E, GrokBot>,
  options: { readonly readOnly?: boolean } = {}
) => {
  const { layer, requests } = makeGrokBot(respond, options)
  return f(requests).pipe(Effect.provide(layer))
}

describe("GrokBot", () => {
  it("needs an HttpClient, Crypto and the filesystem for its outbox, and fails only on config", () => {
    expectTypeOf(GrokBot.layer).toEqualTypeOf<
      Layer.Layer<
        GrokBot,
        Config.ConfigError,
        HttpClient.HttpClient | Crypto.Crypto | FileSystem.FileSystem | Path.Path
      >
    >()
  })

  it.effect("marks the task pending in the outbox before the POST", () => {
    const seen: Array<unknown> = []
    const { fs, layer, requests } = makeGrokBot(() => {
      seen.push(fs.readJson(`${OUTBOX_DIR}/${REQUEST_ID}.json`))
      return 202
    })
    return Effect.gen(function*() {
      yield* send({ task: "ping" })
      assert.strictEqual(requests.length, 1)
      // FixedCrypto's digest is the identity, so the hash is the hex of the trimmed task.
      assert.deepStrictEqual(seen, [{ requestId: REQUEST_ID, taskHash: "70696e67", sentAt: 0, status: "pending" }])
      assert.strictEqual(fs.entries.get(OUTBOX_DIR)!.mode, 0o700)
      assert.strictEqual(fs.entries.get(`${OUTBOX_DIR}/${REQUEST_ID}.json`)!.mode, 0o600)
    }).pipe(Effect.provide(layer))
  })

  it.effect("sends nothing when the outbox cannot record the task", () =>
    withGrokBot(() => 202, (requests) =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(send({ task: "ping" }))
        assert.match(error.message, /Could not record the task in the outbox; nothing was sent/)
        assert.strictEqual(requests.length, 0)
      }), { readOnly: true }))

  it.effect("POSTs the task once with the bearer key and our request_id", () =>
    withGrokBot(() => 202, (requests) =>
      Effect.gen(function*() {
        const dispatch = yield* send({ task: "  summarize my inbox  ", context: "only unread" })
        assert.deepStrictEqual(dispatch, { requestId: REQUEST_ID, status: "started" })
        assert.strictEqual(requests.length, 1)
        const [request] = requests
        assert.strictEqual(request!.method, "POST")
        assert.strictEqual(request!.url, WEBHOOK_URL)
        assert.deepInclude(request!.headers, {
          authorization: `Bearer ${KEY}`,
          "content-type": "application/json"
        })
        // Tracing is off for this request: no propagation headers, no url.full span attribute.
        assert.notProperty(request!.headers, "traceparent")
        assert.notProperty(request!.headers, "b3")
        assert.deepStrictEqual(request!.body, {
          task: "summarize my inbox",
          context: "only unread",
          request_id: REQUEST_ID
        })
      })))

  it.effect("omits context from the body when absent", () =>
    withGrokBot(() => 200, (requests) =>
      Effect.gen(function*() {
        yield* send({ task: "ping" })
        assert.deepStrictEqual(requests[0]!.body, { task: "ping", request_id: REQUEST_ID })
      })))

  it.effect("fails without retrying on a non-2xx answer", () =>
    Effect.gen(function*() {
      for (const status of [500, 503, 401, 302]) {
        const error = yield* withGrokBot(() => status, (requests) =>
          Effect.gen(function*() {
            const error = yield* Effect.flip(send({ task: "ping" }))
            assert.strictEqual(requests.length, 1)
            return error
          }))
        assert.include(error.message, `HTTP ${status}`)
        assert.include(error.message, "Do not resend it automatically")
        assertSafe(error)
      }
    }))

  it.effect("reports a network error as uncertain without echoing the URL or key", () =>
    withGrokBot(() => "network-error", (requests) =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(send({ task: "ping" }))
        assert.match(error.message, /Could not reach Grok Bot, so the outcome is uncertain\. Do not resend/)
        assert.strictEqual(requests.length, 1)
        assertSafe(error)
      })))

  it.effect("gives up after 15 seconds with an uncertain outcome, single attempt", () =>
    withGrokBot(() => "hang", (requests) =>
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(Effect.flip(send({ task: "ping" })))
        yield* TestClock.adjust("14999 millis")
        assert.isUndefined(fiber.pollUnsafe())
        yield* TestClock.adjust("1 millis")
        const error = yield* Fiber.join(fiber)
        assert.match(error.message, /did not answer within 15 seconds, so the outcome is uncertain\. Do not resend/)
        yield* TestClock.adjust("1 minute")
        assert.strictEqual(requests.length, 1)
        assertSafe(error)
      })))

  it.effect("validates the task before sending anything", () =>
    withGrokBot(() => 200, (requests) =>
      Effect.gen(function*() {
        const invalid = [
          { task: "" },
          { task: " \n\t " },
          { task: "x".repeat(MAX_TASK_LENGTH + 1) },
          { task: "ping", context: "x".repeat(MAX_CONTEXT_LENGTH + 1) }
        ]
        for (const input of invalid) {
          const error = yield* Effect.flip(send(input))
          assert.match(error.message, /^Invalid Grok Bot task/)
        }
        assert.strictEqual(requests.length, 0)
        yield* send({ task: ` ${"x".repeat(MAX_TASK_LENGTH)} `, context: "x".repeat(MAX_CONTEXT_LENGTH) })
        assert.strictEqual(requests.length, 1)
      })))
})

describe("GrokBot config", () => {
  const build = (overrides: Record<string, string | undefined>) =>
    Layer.build(GrokBot.layer).pipe(
      Effect.provide(
        Layer.mergeAll(fakeHttpClient(() => 200).layer, FixedCrypto, makeMemoryFileSystem().layer, env(overrides))
      ),
      Effect.scoped,
      Effect.exit
    )

  it.effect("requires an https webhook URL without echoing it", () =>
    Effect.gen(function*() {
      for (const url of ["http://grokbot.example/hooks/SECRET-PATH-TOKEN", "not a url SECRET-PATH-TOKEN"]) {
        const exit = yield* build({ GROKBOT_WEBHOOK_URL: url })
        assert.isTrue(Exit.isFailure(exit))
        const rendered = String(exit)
        assert.include(rendered, "GROKBOT_WEBHOOK_URL")
        assert.notInclude(rendered, "SECRET")
      }
    }))

  it.effect("requires both settings", () =>
    Effect.gen(function*() {
      assert.isTrue(Exit.isFailure(yield* build({ GROKBOT_KEY: undefined })))
      assert.isTrue(Exit.isFailure(yield* build({ GROKBOT_WEBHOOK_URL: undefined })))
      assert.isTrue(Exit.isSuccess(yield* build({})))
    }))
})
