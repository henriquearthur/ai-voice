import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import { GrokBotOutbox, GrokBotOutboxError, MAX_ENTRIES, MAX_RESULT_BYTES } from "../src/index.ts"
import { makeMemoryFileSystem, OUTBOX_DIR, STATE_DIR } from "./fixtures.ts"

const ID = "aaaaaaaa-1111-4111-8111-11111111111b"
const OTHER = "22222222-2222-4222-8222-222222222222"

const idAt = (index: number) => `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`

const withOutbox = <A, E>(
  f: (outbox: GrokBotOutbox["Service"], fs: ReturnType<typeof makeMemoryFileSystem>) => Effect.Effect<A, E>
) => {
  const fs = makeMemoryFileSystem()
  return GrokBotOutbox.use((outbox) => f(outbox, fs)).pipe(
    Effect.provide(GrokBotOutbox.layerAt(STATE_DIR)),
    Effect.provide(fs.layer)
  )
}

const pending = (outbox: GrokBotOutbox["Service"], requestId = ID) =>
  Effect.flatMap(
    Clock.currentTimeMillis,
    (sentAt) => outbox.markPending({ requestId, taskHash: "hash", sentAt })
  )

describe("GrokBotOutbox", () => {
  it.effect("keeps a private file per pending task", () =>
    withOutbox((outbox, fs) =>
      Effect.gen(function*() {
        yield* pending(outbox)
        assert.strictEqual(fs.entries.get(STATE_DIR)!.mode, 0o700)
        assert.strictEqual(fs.entries.get(OUTBOX_DIR)!.mode, 0o700)
        assert.deepStrictEqual(fs.files(OUTBOX_DIR), [`${OUTBOX_DIR}/${ID}.json`])
        assert.strictEqual(fs.entries.get(`${OUTBOX_DIR}/${ID}.json`)!.mode, 0o600)
        assert.deepStrictEqual(yield* outbox.get(ID), Option.some({
          requestId: ID,
          taskHash: "hash",
          sentAt: 0,
          status: "pending" as const
        }))
      })
    ))

  it.effect("accepts one delivery for a pending id and keeps it on duplicates", () =>
    withOutbox((outbox) =>
      Effect.gen(function*() {
        yield* pending(outbox)
        yield* TestClock.adjust("1 hour")
        assert.strictEqual(yield* outbox.deliver({ requestId: ID, status: "done", resultMd: "# ok" }), "delivered")
        yield* TestClock.adjust("1 minute")
        assert.strictEqual(
          yield* outbox.deliver({ requestId: ID, status: "failed", resultMd: "overwrite" }),
          "already_delivered"
        )
        const entry = Option.getOrThrow(yield* outbox.get(ID))
        assert.deepStrictEqual(entry, {
          requestId: ID,
          taskHash: "hash",
          sentAt: 0,
          status: "done",
          resultMd: "# ok",
          deliveredAt: 3_600_000
        })
      })
    ))

  it.effect("serializes concurrent deliveries for the same id", () =>
    withOutbox((outbox) =>
      Effect.gen(function*() {
        yield* pending(outbox)
        const outcomes = yield* Effect.forEach(
          ["first", "second", "third"],
          (resultMd) => outbox.deliver({ requestId: ID, status: "done", resultMd }),
          { concurrency: "unbounded" }
        )
        assert.deepStrictEqual([...outcomes].sort(), ["already_delivered", "already_delivered", "delivered"])
      })
    ))

  it.effect("rejects an unknown id", () =>
    withOutbox((outbox) =>
      Effect.gen(function*() {
        yield* pending(outbox)
        const error = yield* Effect.flip(outbox.deliver({ requestId: OTHER, status: "done", resultMd: "x" }))
        assert.instanceOf(error, GrokBotOutboxError)
        assert.match(error.message, /^Unknown request_id/)
      })
    ))

  it.effect("rejects a delivery 24 hours after sending", () =>
    withOutbox((outbox) =>
      Effect.gen(function*() {
        yield* pending(outbox)
        yield* TestClock.adjust("24 hours")
        const error = yield* Effect.flip(outbox.deliver({ requestId: ID, status: "done", resultMd: "late" }))
        assert.match(error.message, /^Expired request_id/)
        assert.strictEqual(Option.getOrThrow(yield* outbox.get(ID)).status, "pending")
      })
    ))

  it.effect("validates the id, status and size before touching the outbox", () =>
    withOutbox((outbox) =>
      Effect.gen(function*() {
        yield* pending(outbox)
        const invalid = [
          { requestId: ID.toUpperCase(), status: "done", resultMd: "x" },
          { requestId: "../session", status: "done", resultMd: "x" },
          { requestId: ID, status: "pending", resultMd: "x" },
          { requestId: ID, status: "done", resultMd: "é".repeat(MAX_RESULT_BYTES / 2 + 1) }
        ]
        for (const input of invalid) {
          const error = yield* Effect.flip(outbox.deliver(input as never))
          assert.match(error.message, /^Invalid delivery/)
        }
        assert.strictEqual(Option.getOrThrow(yield* outbox.get(ID)).status, "pending")
        const atLimit = "x".repeat(MAX_RESULT_BYTES)
        assert.strictEqual(yield* outbox.deliver({ requestId: ID, status: "failed", resultMd: atLimit }), "delivered")
      })
    ))

  it.effect("lists newest first and ignores ids that are not UUIDs", () =>
    withOutbox((outbox) =>
      Effect.gen(function*() {
        yield* pending(outbox, ID)
        yield* TestClock.adjust("1 second")
        yield* pending(outbox, OTHER)
        assert.deepStrictEqual((yield* outbox.list).map((entry) => entry.requestId), [OTHER, ID])
        assert.isTrue(Option.isNone(yield* outbox.get("../session")))
      })
    ))

  it.effect("prunes entries past the retention period", () =>
    withOutbox((outbox, fs) =>
      Effect.gen(function*() {
        yield* pending(outbox, ID)
        yield* TestClock.adjust("8 days")
        yield* pending(outbox, OTHER)
        assert.deepStrictEqual(fs.files(OUTBOX_DIR), [`${OUTBOX_DIR}/${OTHER}.json`])
      })
    ))

  it.effect("keeps at most MAX_ENTRIES, dropping the oldest", () =>
    withOutbox((outbox, fs) =>
      Effect.gen(function*() {
        for (let index = 0; index <= MAX_ENTRIES; index++) {
          yield* pending(outbox, idAt(index))
          yield* TestClock.adjust("1 second")
        }
        assert.strictEqual(fs.files(OUTBOX_DIR).length, MAX_ENTRIES)
        assert.isTrue(Option.isNone(yield* outbox.get(idAt(0))))
        assert.isTrue(Option.isSome(yield* outbox.get(idAt(MAX_ENTRIES))))
      })
    ), 30_000)
})
