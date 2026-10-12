import { prepareStateDir } from "@jarvis/alexa"
import { Effect, FileSystem, Path, Random, Schema } from "effect"

export const ANNOUNCE_STATE_FILE = "announce-state.json"
export const DEDUP_WINDOW_MS = 10 * 60 * 1000
export const RATE_WINDOW_MS = 60 * 1000
export const MAX_STATE_ENTRIES = 100

// Only content hashes are stored, never the spoken text.
export const AnnounceState = Schema.Struct({
  version: Schema.Literal(1),
  spoken: Schema.Array(Schema.Struct({ hash: Schema.String, at: Schema.Number }))
})
export type AnnounceState = typeof AnnounceState.Type

const AnnounceStateJson = Schema.fromJsonString(AnnounceState)

export const emptyState: AnnounceState = { version: 1, spoken: [] }

/** Drops entries outside every window and caps the file size. */
export const pruneState = (state: AnnounceState, now: number): AnnounceState => ({
  version: 1,
  spoken: state.spoken
    .filter((entry) => entry.at > now - DEDUP_WINDOW_MS && entry.at <= now)
    .slice(-MAX_STATE_ENTRIES)
})

/** A missing, unreadable or corrupt file starts fresh instead of failing. */
export const loadState = Effect.fn("loadState")(function*(stateDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.readFileString(path.join(stateDir, ANNOUNCE_STATE_FILE)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AnnounceStateJson)),
    Effect.orElseSucceed(() => emptyState)
  )
})

/** Atomic write: a private temporary file renamed over the old one. */
export const saveState = Effect.fn("saveState")(function*(stateDir: string, state: AnnounceState) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* prepareStateDir(stateDir)
  const file = path.join(stateDir, ANNOUNCE_STATE_FILE)
  const temporary = `${file}.${yield* Random.nextInt}.tmp`
  const contents = yield* Schema.encodeEffect(AnnounceStateJson)(state)
  yield* Effect.gen(function*() {
    yield* fs.writeFileString(temporary, contents, { mode: 0o600 })
    yield* fs.chmod(temporary, 0o600)
    yield* fs.rename(temporary, file)
  }).pipe(Effect.onError(() => Effect.ignore(fs.remove(temporary))))
})
