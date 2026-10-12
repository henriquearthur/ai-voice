import { NodeServices } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Clock, Effect, FileSystem, Path, Scope, Exit } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { acquireSpeakLock, DEFAULT_SPEAK_LOCK, LOCKF } from "../src/index.ts"

// Real /usr/bin/lockf against a throwaway file. Nothing here talks to Alexa, and the shared
// /tmp/alexa-speak.lock is never touched. AI_VOICE_TEST_LOCK_DIR picks where the temp dir goes.
const lockFile = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const parent = process.env.AI_VOICE_TEST_LOCK_DIR
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "speak-lock-test-", ...(parent ? { directory: parent } : {}) })
  const file = path.join(dir, "speak.lock")
  assert.notStrictEqual(path.resolve(file), DEFAULT_SPEAK_LOCK)
  assert.notInclude(file, "alexa-speak.lock")
  return file
})

// What the shell scripts run, with a zero timeout: 0 = got the lock, 75 = already locked.
const externalTry = (file: string) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.exitCode(ChildProcess.make(LOCKF, ["-k", "-s", "-t", "0", file, "/usr/bin/true"])))

describe.skipIf(process.platform !== "darwin")("speak lock against the real lockf(1)", () => {
  it.live("excludes the external tool while held and frees it when the scope closes", () =>
    Effect.gen(function*() {
      const file = yield* lockFile
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const scope = yield* Scope.make()
      yield* acquireSpeakLock(spawner, file).pipe(Scope.provide(scope))
      assert.strictEqual(yield* externalTry(file), 75)
      yield* Scope.close(scope, Exit.void)
      assert.strictEqual(yield* externalTry(file), 0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000)

  it.live("waits for a speech held by the external tool before taking the lock", () =>
    Effect.gen(function*() {
      const file = yield* lockFile
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      // Another program speaking: lockf holds the file for 1.5 s.
      const external = yield* spawner.spawn(ChildProcess.make(LOCKF, ["-k", "-s", file, "/bin/sleep", "1.5"]))
      while ((yield* externalTry(file)) !== 75) yield* Effect.sleep("20 millis")
      const before = yield* Clock.currentTimeMillis
      yield* Effect.scoped(acquireSpeakLock(spawner, file))
      const waited = (yield* Clock.currentTimeMillis) - before
      assert.isAtLeast(waited, 800)
      assert.strictEqual(yield* external.exitCode, 0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 20_000)
})
