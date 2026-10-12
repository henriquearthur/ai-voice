import { Effect, FileSystem, Path, Random, Schema } from "effect"
import { SessionError } from "./alexa-error.ts"

const SESSION_FILE = "session.json"

// Unknown fields (registration data, frc, map-md, ...) must survive a load/save round-trip:
// renewal and the next login depend on them.
export const Session = Schema.StructWithRest(
  Schema.Struct({
    localCookie: Schema.NonEmptyString,
    refreshToken: Schema.NonEmptyString,
    macDms: Schema.Record(Schema.String, Schema.Unknown),
    amazonPage: Schema.optionalKey(Schema.String),
    tokenDate: Schema.optionalKey(Schema.Number)
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
export type Session = typeof Session.Type

const SessionJson = Schema.fromJsonString(Session)

export const decodeSession = Schema.decodeUnknownEffect(Session)

export const loadSession = Effect.fn("loadSession")(function*(stateDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  return yield* fs.readFileString(path.join(stateDir, SESSION_FILE)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SessionJson)),
    Effect.mapError(() =>
      new SessionError({
        message:
          "Amazon session is missing or invalid. Run jarvis-voice login (bun apps/mcp/src/main.ts login) on the machine that hosts Jarvis."
      })
    )
  )
})

export const prepareStateDir = Effect.fn("prepareStateDir")(function*(stateDir: string) {
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(stateDir, { recursive: true, mode: 0o700 })
  // mkdir leaves an existing directory's mode untouched.
  yield* fs.chmod(stateDir, 0o700)
})

export const saveSession = Effect.fn("saveSession")(
  function*(stateDir: string, session: Session) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* prepareStateDir(stateDir)
    const file = path.join(stateDir, SESSION_FILE)
    const temporary = `${file}.${yield* Random.nextInt}.tmp`
    const contents = yield* Schema.encodeEffect(SessionJson)(session)
    // Write then rename, so a crash never leaves a truncated session behind.
    yield* Effect.gen(function*() {
      yield* fs.writeFileString(temporary, contents, { mode: 0o600 })
      yield* fs.chmod(temporary, 0o600)
      yield* fs.rename(temporary, file)
    }).pipe(Effect.onError(() => Effect.ignore(fs.remove(temporary))))
  },
  Effect.mapError(() => new SessionError({ message: "Could not save the local session." }))
)
