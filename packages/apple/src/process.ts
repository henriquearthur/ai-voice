import { Duration, Effect, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { AutomationError } from "./apple-error.ts"

// SIGTERM first; a process that ignores it is SIGKILLed after this grace period.
const FORCE_KILL_AFTER = Duration.seconds(2)
// Upper bound, in UTF-16 code units, for what is kept from stdout or stderr.
const MAX_OUTPUT = 1_000_000

/** Options every child process of this package is spawned with: no stdin, no shell. */
export const spawnOptions = { stdin: "ignore", forceKillAfter: FORCE_KILL_AFTER } as const

/** Builds a command from an absolute executable path and argv only (never a shell string). */
export const command = (file: string, args: ReadonlyArray<string>): ChildProcess.Command =>
  ChildProcess.make(file, [...args], spawnOptions)

export interface Completed {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: ChildProcessSpawner.ExitCode
}

const collect = (bytes: Stream.Stream<Uint8Array, PlatformError>, label: string) =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.runFoldEffect(() => "", (output, chunk: string) =>
      output.length + chunk.length > MAX_OUTPUT
        ? Effect.fail(new AutomationError({ message: `${label} produced too much output.` }))
        : Effect.succeed(output + chunk))
  )

/**
 * Runs `command` to completion and returns its output and exit code. The
 * process lives in a scope: on success, failure, timeout or interruption the
 * scope closes and the spawner kills its process group.
 */
export const execute = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  command: ChildProcess.Command,
  label: string,
  timeout: Duration.Duration
): Effect.Effect<Completed, AutomationError> =>
  Effect.gen(function*() {
    const handle = yield* spawner.spawn(command)
    return yield* Effect.all({
      stdout: collect(handle.stdout, label),
      stderr: collect(handle.stderr, label),
      exitCode: handle.exitCode
    }, { concurrency: "unbounded" })
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", () => Effect.fail(new AutomationError({ message: `Could not run ${label}.` }))),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () =>
        Effect.fail(new AutomationError({ message: `${label} did not finish within ${Duration.format(timeout)}.` }))
    })
  )
