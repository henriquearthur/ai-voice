import { DateTime, Effect, FileSystem, Layer, Option, Path, PlatformError } from "effect"
import { TestClock } from "effect/testing"
import { AnnounceConfig, Announcer, type AnnounceInput, type Decision } from "../src/index.ts"

export const STATE_DIR = "/state"
export const STATE_FILE = `${STATE_DIR}/announce-state.json`

export interface Entry {
  readonly directory: boolean
  readonly mode: number
  readonly content?: string
}

// In-memory FileSystem covering the calls the package makes, recording file modes.
export const makeMemoryFileSystem = () => {
  const entries = new Map<string, Entry>()
  const notFound = (method: string, path: string) =>
    PlatformError.systemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: path })
  const layer = FileSystem.layerNoop({
    makeDirectory: (path, options) =>
      Effect.sync(() => {
        if (!entries.has(path)) entries.set(path, { directory: true, mode: options?.mode ?? 0o755 })
      }),
    chmod: (path, mode) =>
      Effect.suspend(() => {
        const entry = entries.get(path)
        if (entry === undefined) return Effect.fail(notFound("chmod", path))
        entries.set(path, { ...entry, mode })
        return Effect.void
      }),
    writeFileString: (path, content, options) =>
      Effect.sync(() => {
        entries.set(path, { directory: false, content, mode: entries.get(path)?.mode ?? options?.mode ?? 0o644 })
      }),
    readFileString: (path) =>
      Effect.suspend(() => {
        const content = entries.get(path)?.content
        return content === undefined ? Effect.fail(notFound("readFileString", path)) : Effect.succeed(content)
      }),
    rename: (from, to) =>
      Effect.suspend(() => {
        const entry = entries.get(from)
        if (entry === undefined) return Effect.fail(notFound("rename", from))
        entries.delete(from)
        entries.set(to, entry)
        return Effect.void
      }),
    remove: (path) => Effect.sync(() => void entries.delete(path))
  })
  return { entries, layer: Layer.merge(layer, Path.layer) }
}

export const testConfig = (overrides: Partial<AnnounceConfig["Service"]> = {}) =>
  AnnounceConfig.of({
    stateDir: STATE_DIR,
    quietHours: Option.some({ start: 23 * 60, end: 7 * 60 }),
    timeZone: DateTime.zoneMakeNamedUnsafe("America/Sao_Paulo"),
    maxPerMinute: 3,
    ...overrides
  })

export const announcer = (
  fs: ReturnType<typeof makeMemoryFileSystem>,
  overrides: Partial<AnnounceConfig["Service"]> = {}
) => Announcer.layer.pipe(Layer.provide(Layer.merge(fs.layer, Layer.succeed(AnnounceConfig, testConfig(overrides)))))

/** Sets the TestClock to a wall-clock time in São Paulo, e.g. "2026-10-12T22:59". */
export const setLocalTime = (local: string) => TestClock.setTime(Date.parse(`${local}:00-03:00`))

export const decide = (input: AnnounceInput) => Announcer.use((service) => service.decide(input))

export const speak = (text: string): Decision => ({ _tag: "speak", text })
