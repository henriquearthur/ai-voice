import { Duration, Effect, Exit, Option, Scope, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { SpeechError } from "./alexa-error.ts"

export const LOCKF = "/usr/bin/lockf"
export const CAT = "/bin/cat"
export const LOCK_TIMEOUT = Duration.seconds(90)
// The preview POST returns as soon as Alexa queues the sequence, before the Echo starts talking.
// Holding the lock about one second per spoken node covers that dispatch gap, so a speech sent
// right after ours lands behind it on the Echo, while a long text does not block the other
// scripts for its whole playback.
export const HOLD_PER_CHUNK = Duration.seconds(1)

// lockf(1) exit status when the timeout expires before the lock is free (sysexits EX_TEMPFAIL).
const EX_TEMPFAIL = 75
const PROBE = new Uint8Array([10])

const busy = () =>
  new SpeechError({
    message: "Echo ocupado: another program kept speaking for 90 seconds. Nothing was sent; do not retry automatically."
  })

const unavailable = () =>
  new SpeechError({ message: `Could not take the speech lock with ${LOCKF}. Nothing was sent.` })

/**
 * Holds the same flock(2) lock that `lockf -t 90 <path> <command>` takes in the shell scripts,
 * until the surrounding scope closes. Fails with "Echo ocupado" after 90 seconds.
 *
 * lockf runs `cat` only once it owns the lock, so the byte written to stdin comes back on
 * stdout exactly when the lock is held. `cat` then waits on stdin: closing the scope kills the
 * process group, and if this process dies the pipe closes and `cat` exits, so the kernel always
 * releases the lock. `-k` keeps the file, because removing it would let a waiting process lock
 * a deleted inode.
 */
export const acquireSpeakLock = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  path: string
): Effect.Effect<void, SpeechError, Scope.Scope> =>
  Effect.gen(function*() {
    const seconds = String(Duration.toSeconds(LOCK_TIMEOUT))
    const handle = yield* spawner.spawn(ChildProcess.make(LOCKF, ["-k", "-s", "-t", seconds, path, CAT], {
      stdin: Stream.concat(Stream.make(PROBE), Stream.never),
      stdout: "pipe",
      stderr: "ignore"
    }))
    if (Option.isSome(yield* Stream.runHead(handle.stdout))) return
    const code = yield* handle.exitCode
    return yield* (code === EX_TEMPFAIL ? busy() : unavailable())
  }).pipe(
    Effect.catchTag("PlatformError", () => Effect.fail(unavailable())),
    Effect.timeoutOrElse({ duration: LOCK_TIMEOUT, orElse: () => Effect.fail(busy()) }),
    Effect.withSpan("Alexa.speakLock")
  )

/**
 * Runs `send` while holding the speech lock. After an accepted send, keeps the lock for
 * `chunks` × HOLD_PER_CHUNK; on any failure or interruption releases it at once.
 */
export const withSpeakLock = <A, E, R>(
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  path: string,
  chunks: number,
  send: Effect.Effect<A, E, R>
): Effect.Effect<A, E | SpeechError, R> =>
  Effect.scoped(Effect.gen(function*() {
    yield* acquireSpeakLock(spawner, path)
    // Finalizers run in reverse order: this hold runs before the lock process is killed.
    yield* Effect.addFinalizer((exit) =>
      Exit.isSuccess(exit) ? Effect.sleep(Duration.times(HOLD_PER_CHUNK, chunks)) : Effect.void
    )
    return yield* send
  }))
