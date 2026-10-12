import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"
import { MAX_TEXT_LENGTH, SpeechText, splitSpeech } from "../src/index.ts"

const decode = Schema.decodeUnknownExit(SpeechText)

describe("SpeechText", () => {
  it.effect("rejects empty text, SSML and overlong text", () =>
    Effect.sync(() => {
      for (const text of ["", "  ", "<speak>Hello</speak>", "a > b", "a".repeat(MAX_TEXT_LENGTH + 1), 42]) {
        assert.isTrue(Exit.isFailure(decode(text)))
      }
    }))

  it.effect("trims accepted text", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(decode("  Olá, 1.25!  "), Exit.succeed("Olá, 1.25!"))
      assert.isTrue(Exit.isSuccess(decode("a".repeat(MAX_TEXT_LENGTH))))
    }))
})

describe("splitSpeech", () => {
  it.effect("splits long text without breaking words, sentences or emojis at the boundary", () =>
    Effect.sync(() => {
      const text = "A short sentence in plain English. ".repeat(60).trim()
      const parts = splitSpeech(text)
      assert.isTrue(parts.length > 1)
      assert.isTrue(parts.every((part) => part.length > 0 && part.length <= 250))
      assert.strictEqual(parts.join(" "), text)
      for (const edge of ["a".repeat(249) + "😀oi", "a".repeat(250) + ".oi", "a".repeat(4000)]) {
        const chunks = splitSpeech(edge)
        assert.isTrue(chunks.every((chunk) => chunk.length <= 250 && chunk.isWellFormed()))
        assert.strictEqual(chunks.join(""), edge)
      }
    }))

  it.effect("keeps short text in a single chunk", () =>
    Effect.sync(() => {
      assert.deepStrictEqual(splitSpeech("Olá!"), ["Olá!"])
    }))
})
