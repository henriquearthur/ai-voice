import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Maps } from "../src/maps.ts"
import { Osascript } from "../src/osascript.ts"

const fakeOsascript = () => {
  const opened: Array<string> = []
  const layer = Maps.layer.pipe(
    Layer.provide(Layer.succeed(
      Osascript,
      Osascript.of({
        run: () => Effect.die("Maps must not run AppleScript"),
        open: (url) => Effect.sync(() => void opened.push(url))
      })
    ))
  )
  return { opened, layer }
}

describe("Maps", () => {
  it.effect("encodes the search query", () => {
    const { opened, layer } = fakeOsascript()
    return Effect.gen(function*() {
      const maps = yield* Maps
      const { url } = yield* maps.search({ query: "  café & pão, São Paulo #1  " })
      assert.strictEqual(url, "https://maps.apple.com/?q=caf%C3%A9+%26+p%C3%A3o%2C+S%C3%A3o+Paulo+%231")
      assert.deepStrictEqual(opened, [url])
      assert.strictEqual(new URL(url).searchParams.get("q"), "café & pão, São Paulo #1")
    }).pipe(Effect.provide(layer))
  })

  it.effect("builds directions with origin and travel mode", () => {
    const { layer } = fakeOsascript()
    return Effect.gen(function*() {
      const maps = yield* Maps
      const { url } = yield* maps.directions({ to: "Av. Paulista, 1000", from: "Casa&q=x", mode: "transit" })
      const params = new URL(url).searchParams
      assert.deepStrictEqual([...params], [["saddr", "Casa&q=x"], ["daddr", "Av. Paulista, 1000"], ["dirflg", "r"]])
    }).pipe(Effect.provide(layer))
  })

  it.effect("omits origin and mode when not given", () => {
    const { layer } = fakeOsascript()
    return Effect.gen(function*() {
      const maps = yield* Maps
      const { url } = yield* maps.directions({ to: "Ibirapuera" })
      assert.strictEqual(url, "https://maps.apple.com/?daddr=Ibirapuera")
    }).pipe(Effect.provide(layer))
  })

  it.effect("keeps hostile text inside the query value", () => {
    const { opened, layer } = fakeOsascript()
    return Effect.gen(function*() {
      const maps = yield* Maps
      const query = "x&saddr=evil#frag\n\u0000 -a Calculator"
      const { url } = yield* maps.search({ query })
      const parsed = new URL(url)
      assert.strictEqual(parsed.origin, "https://maps.apple.com")
      assert.strictEqual(parsed.hash, "")
      assert.deepStrictEqual([...parsed.searchParams], [["q", query]])
      assert.deepStrictEqual(opened, [url])
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects a query longer than 500 characters", () => {
    const { opened, layer } = fakeOsascript()
    return Effect.gen(function*() {
      const maps = yield* Maps
      const error = yield* Effect.flip(maps.search({ query: "a".repeat(501) }))
      assert.strictEqual(error._tag, "AutomationError")
      assert.deepStrictEqual(opened, [])
    }).pipe(Effect.provide(layer))
  })

  it.effect("rejects a blank query without opening anything", () => {
    const { opened, layer } = fakeOsascript()
    return Effect.gen(function*() {
      const maps = yield* Maps
      const error = yield* Effect.flip(maps.search({ query: "   " }))
      assert.strictEqual(error._tag, "AutomationError")
      assert.deepStrictEqual(opened, [])
    }).pipe(Effect.provide(layer))
  })
})
