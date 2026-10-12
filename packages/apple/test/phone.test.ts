import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Osascript } from "../src/osascript.ts"
import { Phone } from "../src/phone.ts"

const fakeOsascript = () => {
  const opened: Array<string> = []
  const layer = Phone.layer.pipe(
    Layer.provide(Layer.succeed(
      Osascript,
      Osascript.of({
        run: () => Effect.die("Phone must not run AppleScript"),
        open: (url) => Effect.sync(() => void opened.push(url))
      })
    ))
  )
  return { opened, layer }
}

describe("Phone", () => {
  it.effect("opens a tel: URL by default", () => {
    const { opened, layer } = fakeOsascript()
    return Effect.gen(function*() {
      const phone = yield* Phone
      const result = yield* phone.call({ number: "+55 (11) 99999-8888" })
      assert.deepStrictEqual(result, { url: "tel:+5511999998888" })
      assert.deepStrictEqual(opened, ["tel:+5511999998888"])
    }).pipe(Effect.provide(layer))
  })

  it.effect("opens a facetime-audio: URL when asked", () => {
    const { opened, layer } = fakeOsascript()
    return Effect.gen(function*() {
      const phone = yield* Phone
      yield* phone.call({ number: "+14155550123", via: "facetime-audio" })
      assert.deepStrictEqual(opened, ["facetime-audio:+14155550123"])
    }).pipe(Effect.provide(layer))
  })

  it.effect.each([
    ["+55 11 99999-8888", "tel:+5511999998888"],
    ["＋５５ １１ ９９９９９－８８８８", "tel:+5511999998888"],
    ["+55\u00a011\u202f99999\u20118888", "tel:+5511999998888"],
    ["+55.11.99999.8888", "tel:+5511999998888"]
  ])("normalizes %j to %s", ([number, expected]) => {
    const { opened, layer } = fakeOsascript()
    return Effect.gen(function*() {
      const phone = yield* Phone
      const { url } = yield* phone.call({ number: number! })
      assert.strictEqual(url, expected)
      assert.deepStrictEqual(opened, [expected])
    }).pipe(Effect.provide(layer))
  })

  it.effect.each([
    "11999998888",
    "005511999998888",
    "0021 1 415 555 0123",
    "+55 11 ٩٩٩٩٩-8888",
    "*#06#",
    "tel:+5511999998888",
    "+1234567",
    "+1234567890123456",
    "+0123456789",
    "+55 11 9999a8888",
    "+5511999998888;phone-context=x",
    "+5511999998888\n+5511888887777"
  ])("rejects %j as not E.164", (number) => {
    const { opened, layer } = fakeOsascript()
    return Effect.gen(function*() {
      const phone = yield* Phone
      const error = yield* Effect.flip(phone.call({ number }))
      assert.strictEqual(error._tag, "AutomationError")
      assert.deepStrictEqual(opened, [])
    }).pipe(Effect.provide(layer))
  })
})
