import { observe } from "@jarvis/telemetry"
import { Context, Duration, Effect, Layer } from "effect"
import { type ChildProcess, ChildProcessSpawner } from "effect/process"
import { AutomationError } from "./apple-error.ts"
import { command, execute } from "./process.ts"

export const FIELD_SEPARATOR = "\u001f"
export const RECORD_SEPARATOR = "\u001e"

const OSASCRIPT = "/usr/bin/osascript"
const OPEN = "/usr/bin/open"
// Default per-process deadline; `run` callers with a known-slow query may raise it.
const DEFAULT_TIMEOUT = Duration.seconds(15)

const E164_BODY = /^\+[1-9]\d{7,14}$/
const MAPS_HOST = "maps.apple.com"

// `open` hands any URL to its default handler, so only the exact URL shapes this
// package builds itself are let through: Apple Maps links and calls to a bare
// E.164 number. Anything else (file:, deep links, other hosts, MMI/USSD codes
// such as `tel:*#06#`, `;phone-context=` or query parameters) is refused.
const isOpenable = (url: URL): boolean => {
  if (url.search !== "" && url.protocol !== "https:") return false
  if (url.hash !== "") return false
  switch (url.protocol) {
    case "https:":
      return url.hostname === MAPS_HOST && url.port === "" && url.username === "" && url.password === ""
    case "tel:":
    case "facetime-audio:":
      return url.host === "" && E164_BODY.test(url.pathname)
    default:
      return false
  }
}

// -1743: the user denied (or never granted) Automation; -1744: consent would be
// required but cannot be asked for.
const NOT_AUTHORIZED = /-174[34]\b|not authori[sz]ed to send apple events/i

export const parseRecords = (output: string): ReadonlyArray<ReadonlyArray<string>> =>
  output
    .split(RECORD_SEPARATOR)
    .filter((record) => record.length > 0)
    .map((record) => record.split(FIELD_SEPARATOR))

const describeFailure = (stderr: string): string => {
  if (NOT_AUTHORIZED.test(stderr)) {
    return "macOS denied Automation permission. Allow it in System Settings > Privacy & Security > Automation, then try again."
  }
  // osascript prefixes errors with the failing source range, e.g. "0:42: execution error: ..."
  const detail = stderr.trim().replace(/^\d+:\d+:\s*/, "")
  return detail.length > 0 ? detail : "The AppleScript command failed."
}

// osascript ends its result with exactly one newline; only that is dropped so
// leading or trailing whitespace inside the returned value survives.
const stripFinalNewline = (output: string): string => output.endsWith("\n") ? output.slice(0, -1) : output

export interface RunOptions {
  // Deadline for this call only; defaults to 15 seconds.
  readonly timeout?: Duration.Input
}

export class Osascript extends Context.Service<Osascript, {
  readonly run: (
    script: string,
    args?: ReadonlyArray<string>,
    options?: RunOptions
  ) => Effect.Effect<string, AutomationError>
  readonly open: (url: string) => Effect.Effect<void, AutomationError>
}>()("@jarvis/apple/Osascript") {
  static readonly layer = Layer.effect(
    Osascript,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const exec = (command: ChildProcess.Command, label: string, timeout: Duration.Duration) =>
        execute(spawner, command, label, timeout).pipe(
          Effect.filterOrElse(
            ({ exitCode }) => exitCode === ChildProcessSpawner.ExitCode(0),
            ({ stderr }) => Effect.fail(new AutomationError({ message: describeFailure(stderr) }))
          )
        )

      // The script is always a constant; caller values only ever travel as argv,
      // read inside the script through `on run argv`. `--` keeps a value that
      // starts with `-` from being parsed as an osascript option.
      const run = Effect.fn("Osascript.run")(function*(
        script: string,
        args: ReadonlyArray<string> = [],
        runOptions: RunOptions = {}
      ) {
        const timeout = runOptions.timeout === undefined ? DEFAULT_TIMEOUT : Duration.fromInputUnsafe(runOptions.timeout)
        const { stdout } = yield* exec(
          command(OSASCRIPT, ["-e", script, "--", ...args]),
          "AppleScript",
          timeout
        )
        return stripFinalNewline(stdout)
      })

      const open = Effect.fn("Osascript.open")(function*(url: string) {
        const parsed = URL.parse(url)
        if (parsed === null || !isOpenable(parsed)) {
          return yield* new AutomationError({ message: "Refusing to open an unsupported URL." })
        }
        // `href` is the normalized form (lower-case scheme, no whitespace or
        // control characters), so what was checked is exactly what is opened.
        yield* exec(command(OPEN, [parsed.href]), "open", DEFAULT_TIMEOUT)
      })

      return Osascript.of({
        run: (script, args, runOptions) => run(script, args, runOptions).pipe(observe("apple.osascript")),
        open: (url) => open(url).pipe(observe("apple.abrir"))
      })
    })
  )
}
