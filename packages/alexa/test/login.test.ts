import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, Layer } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { beforeEach, vi } from "vitest"
import { AlexaConfig, login } from "../src/index.ts"
import { makeMemoryFileSystem, SESSION_FILE, STATE_DIR, testConfig } from "./fixtures.ts"

type Callback = (error: Error | null | undefined, result: unknown) => void

const proxy = vi.hoisted(() => ({
  options: undefined as { readonly [key: string]: unknown } | undefined,
  callback: undefined as Callback | undefined,
  stops: 0
}))

vi.mock("alexa-cookie2", () => ({
  default: {
    generateAlexaCookie: (_email: undefined, _password: undefined, options: { readonly [key: string]: unknown }, callback: Callback) => {
      proxy.options = options
      proxy.callback = callback
      callback(new Error("Please open http://127.0.0.1:3456/ with your browser and login to Amazon."), null)
    },
    stopProxyServer: () => void proxy.stops++
  }
}))

beforeEach(() => {
  proxy.options = undefined
  proxy.callback = undefined
  proxy.stops = 0
})

const session = { localCookie: "csrf=TEST;", refreshToken: "token", macDms: { adp_token: "x" }, amazonPage: "amazon.com.br" }

const start = Effect.fnUntraced(function*() {
  const fs = makeMemoryFileSystem()
  const fiber = yield* Effect.forkChild(
    login.pipe(Effect.provide(Layer.merge(Layer.succeed(AlexaConfig, testConfig()), fs.layer)))
  )
  while (proxy.callback === undefined) yield* Effect.yieldNow
  return { fs, fiber }
})

describe("login", () => {
  it.effect("serves the proxy on loopback only, prints one line, saves the session and stops the proxy", () =>
    Effect.gen(function*() {
      const { fs, fiber } = yield* start()
      assert.deepInclude(proxy.options, {
        proxyOnly: true,
        proxyOwnIp: "127.0.0.1",
        proxyListenBind: "127.0.0.1",
        proxyPort: 3456,
        formerDataStorePath: `${STATE_DIR}/registration.json`
      })
      assert.notProperty(proxy.options, "logger")
      proxy.callback!(null, session)
      yield* Fiber.join(fiber)
      const lines = yield* TestConsole.errorLines
      assert.strictEqual(lines.length, 1)
      assert.include(String(lines[0]), "http://127.0.0.1:3456/")
      assert.deepStrictEqual(JSON.parse(fs.entries.get(SESSION_FILE)!.content!), session)
      assert.strictEqual(fs.entries.get(SESSION_FILE)!.mode, 0o600)
      assert.strictEqual(fs.entries.get(STATE_DIR)!.mode, 0o700)
      assert.strictEqual(proxy.stops, 1)
    }))

  it.effect("fails without saving when Amazon returns an incomplete session", () =>
    Effect.gen(function*() {
      const { fs, fiber } = yield* start()
      proxy.callback!(null, { localCookie: "SECRET-COOKIE" })
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      assert.notInclude(JSON.stringify(exit), "SECRET")
      assert.isFalse(fs.entries.has(SESSION_FILE))
      assert.strictEqual(proxy.stops, 1)
    }))

  it.effect("times out after 10 minutes and stops the proxy", () =>
    Effect.gen(function*() {
      const { fiber } = yield* start()
      yield* TestClock.adjust("10 minutes")
      const error = yield* Effect.flip(Fiber.join(fiber))
      assert.match(error.message, /timed out after 10 minutes/)
      assert.strictEqual(proxy.stops, 1)
    }))

  it.effect("stops the proxy when interrupted", () =>
    Effect.gen(function*() {
      const { fiber } = yield* start()
      yield* Fiber.interrupt(fiber)
      assert.strictEqual(proxy.stops, 1)
    }))
})
