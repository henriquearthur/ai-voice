import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { basename, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { observe } from "@jarvis/telemetry"
import { Context, Duration, Effect, Layer, Option, Semaphore } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { AutomationError } from "./apple-error.ts"
import { command, type Completed, execute } from "./process.ts"

// EventKit answers a bounded range in tens of milliseconds; the deadline only
// covers a cold calaccessd and the first-run access prompt.
const QUERY_TIMEOUT = Duration.seconds(10)
const BUILD_TIMEOUT = Duration.minutes(2)
const SWIFTC = "/usr/bin/swiftc"
const CODESIGN = "/usr/bin/codesign"
const BUNDLE_ID = "dev.jarvis.calendar-events"

/** Code signing identity in the login keychain (`$JARVIS_SIGNING_IDENTITY`, default "Jarvis Local Signing"). */
const signingIdentity = (): string => {
  const override = process.env["JARVIS_SIGNING_IDENTITY"]
  return override !== undefined && override.trim() !== "" ? override : "Jarvis Local Signing"
}

/** The Swift source and Info.plist the helper is compiled from. */
export interface HelperSources {
  readonly source: string
  readonly infoPlist: string
}

// Resolved next to this module. A bundled build (the dashboard's adapter-node
// output) moves this code into a chunk where `../native` does not exist; there
// the installed helper is used instead (see `installHelper`).
const SOURCES: HelperSources = {
  source: fileURLToPath(new URL("../native/calendar-events.swift", import.meta.url)),
  infoPlist: fileURLToPath(new URL("../native/Info.plist", import.meta.url))
}

/** Stable name, inside `helperDirectory()`, of the helper published by `installHelper`. */
export const INSTALLED_HELPER = "calendar-events"

/** Where compiled helpers are cached, outside the repository. */
export const helperDirectory = (): string => {
  const override = process.env["JARVIS_BIN_DIR"]
  return override !== undefined && isAbsolute(override) ? override : join(homedir(), ".local", "share", "jarvis", "bin")
}

const sourceDigest = ({ infoPlist, source }: HelperSources) =>
  createHash("sha256").update(readFileSync(source)).update(readFileSync(infoPlist)).digest("hex").slice(0, 12)

const target = () => `${process.arch === "x64" ? "x86_64" : "arm64"}-apple-macos14`

const step = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"], file: string, args: ReadonlyArray<string>) =>
  execute(spawner, command(file, args), "Calendar helper build", BUILD_TIMEOUT).pipe(
    Effect.filterOrElse(
      ({ exitCode }) => exitCode === ChildProcessSpawner.ExitCode(0),
      ({ stderr }) =>
        Effect.fail(
          new AutomationError({
            message: `Could not build the Calendar helper (needs Xcode Command Line Tools): ${stderr.trim().slice(-500)}`
          })
        )
    )
  )

/**
 * Returns the absolute path of the compiled helper, compiling it if missing.
 * Without the sources (a bundled build) it falls back to the helper published
 * by `installHelper`, and fails only when that is missing too.
 */
export const buildHelper = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  sources: HelperSources = SOURCES
) =>
  Effect.gen(function*() {
    const directory = helperDirectory()
    const digest = yield* Effect.option(Effect.try({ try: () => sourceDigest(sources), catch: () => undefined }))
    if (Option.isNone(digest)) {
      const installed = join(directory, INSTALLED_HELPER)
      if (existsSync(installed)) return installed
      return yield* new AutomationError({
        message:
          `The Calendar helper sources are missing and no installed helper was found at ${installed}. Run \`bun run build:native\` in packages/apple.`
      })
    }
    const binary = join(directory, `calendar-events-${digest.value}`)
    if (existsSync(binary)) return binary
    const partial = `${binary}.partial-${process.pid}`
    yield* Effect.try({
      try: () => mkdirSync(directory, { recursive: true, mode: 0o700 }),
      catch: () => new AutomationError({ message: `Could not create ${directory}.` })
    })
    yield* Effect.gen(function*() {
      yield* step(spawner, SWIFTC, [
        "-O",
        "-target",
        target(),
        sources.source,
        "-Xlinker",
        "-sectcreate",
        "-Xlinker",
        "__TEXT",
        "-Xlinker",
        "__info_plist",
        "-Xlinker",
        sources.infoPlist,
        "-o",
        partial
      ])
      // Signs with the stable local identity so macOS keeps the Calendar permission across rebuilds,
      // and binds the embedded Info.plist. Without that certificate in the keychain, signs ad hoc.
      yield* step(spawner, CODESIGN, ["--force", "--sign", signingIdentity(), "--identifier", BUNDLE_ID, partial]).pipe(
        Effect.catch(() => step(spawner, CODESIGN, ["--force", "--sign", "-", "--identifier", BUNDLE_ID, partial]))
      )
      yield* Effect.try({
        try: () => renameSync(partial, binary),
        catch: () => new AutomationError({ message: "Could not install the Calendar helper." })
      })
    }).pipe(Effect.onError(() => Effect.sync(() => rmSync(partial, { force: true }))))
    return binary
  })

/**
 * Builds the helper and points `helperDirectory()/calendar-events` at it, so a
 * bundled server that ships without the sources can still run it.
 */
export const installHelper = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  Effect.gen(function*() {
    const binary = yield* buildHelper(spawner)
    const installed = join(helperDirectory(), INSTALLED_HELPER)
    if (binary === installed) return installed
    const link = `${installed}.link-${process.pid}`
    yield* Effect.try({
      try: () => {
        rmSync(link, { force: true })
        symlinkSync(basename(binary), link)
        renameSync(link, installed)
      },
      catch: () => new AutomationError({ message: `Could not install the Calendar helper at ${installed}.` })
    }).pipe(Effect.onError(() => Effect.sync(() => rmSync(link, { force: true }))))
    return installed
  })

/**
 * Runs the EventKit helper (`native/calendar-events.swift`). The binary is
 * compiled on first use into `helperDirectory()`, named after a digest of its
 * sources so an edited helper is rebuilt instead of reusing a stale one. A
 * bundled build without the sources runs the one `installHelper` published.
 */
export class CalendarHelper extends Context.Service<CalendarHelper, {
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<Completed, AutomationError>
}>()("@jarvis/apple/CalendarHelper") {
  /** Uses an already-built helper at `path` (absolute); nothing is compiled. */
  static readonly layerAt = (path: string) =>
    Layer.effect(
      CalendarHelper,
      Effect.gen(function*() {
        if (!isAbsolute(path)) return yield* new AutomationError({ message: "The Calendar helper path must be absolute." })
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        return CalendarHelper.of({
          run: (args) =>
            execute(spawner, command(path, args), "Calendar helper", QUERY_TIMEOUT).pipe(
              observe("apple.calendario_helper")
            )
        })
      })
    )

  /** Builds the helper on demand (Xcode Command Line Tools required) and runs it. */
  static readonly layer = Layer.effect(
    CalendarHelper,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const lock = yield* Semaphore.make(1)
      const ensure = Semaphore.withPermits(lock, 1)(buildHelper(spawner))
      return CalendarHelper.of({
        run: (args) =>
          Effect.flatMap(ensure, (path) => execute(spawner, command(path, args), "Calendar helper", QUERY_TIMEOUT)).pipe(
            observe("apple.calendario_helper")
          )
      })
    })
  )
}
