import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { loadSession, saveSession } from "../src/index.ts"
import { makeMemoryFileSystem, SESSION_FILE, STATE_DIR } from "./fixtures.ts"

describe("session", () => {
  it.effect("is private on the filesystem and keeps unknown fields", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      const session = {
        localCookie: "csrf=TEST;",
        refreshToken: "fake",
        macDms: { adp_token: "x" },
        tokenDate: 1,
        deviceSerial: "ABC",
        "map-md": { nested: [1, 2] }
      }
      yield* saveSession(STATE_DIR, session).pipe(Effect.provide(fs.layer))
      assert.strictEqual(fs.entries.get(STATE_DIR)!.mode, 0o700)
      assert.strictEqual(fs.entries.get(SESSION_FILE)!.mode, 0o600)
      assert.deepStrictEqual([...fs.entries.keys()].sort(), [STATE_DIR, SESSION_FILE])
      assert.deepStrictEqual(yield* loadSession(STATE_DIR).pipe(Effect.provide(fs.layer)), session)
    }))

  it.effect("rejects a session without the renewal tokens", () =>
    Effect.gen(function*() {
      const fs = makeMemoryFileSystem()
      fs.writeSession({ localCookie: "csrf=TEST;", refreshToken: "", macDms: {} })
      const error = yield* Effect.flip(loadSession(STATE_DIR).pipe(Effect.provide(fs.layer)))
      assert.match(error.message, /Amazon session is missing or invalid/)
    }))
})
