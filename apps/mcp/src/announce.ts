import { type AnnounceEvent, AnnounceEvent as AnnounceEventSchema, type AnnounceInput, Announcer } from "@jarvis/announce"
import { Console, Effect, Option, Path, Schema, Stdio, Stream } from "effect"
import { Speaker } from "./speaker.ts"

/** The subset of the Claude Code hook JSON (Notification and Stop) that `announce` reads. */
const HookPayload = Schema.Struct({
  hook_event_name: Schema.optionalKey(Schema.String),
  notification_type: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String)
})

const decodeHookPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(HookPayload))
const isAnnounceEvent = Schema.is(AnnounceEventSchema)

export class AnnounceInputError extends Schema.TaggedError<AnnounceInputError>()("AnnounceInputError", {
  message: Schema.String
}) {}

export interface AnnounceFlags {
  readonly body: Option.Option<string>
  readonly title: Option.Option<string>
  readonly event: Option.Option<string>
  readonly project: Option.Option<string>
  readonly source: string
}

const hookEvent = (payload: typeof HookPayload.Type): AnnounceEvent | undefined => {
  if (payload.hook_event_name === "Stop") return "finished"
  switch (payload.notification_type) {
    case "permission_prompt":
    case "elicitation_dialog":
      return "permission"
    case "idle_prompt":
      return "waiting"
    default:
      return undefined
  }
}

/** Reads the hook JSON from stdin. A terminal is never read: it would block waiting for the user. */
const readHookPayload = Effect.gen(function*() {
  const stdio = yield* Stdio.Stdio
  if (yield* stdio.stdinIsTerminal) return {} satisfies typeof HookPayload.Type
  const raw = yield* Stream.mkString(Stream.decodeText(stdio.stdin))
  if (raw.trim() === "") return {} satisfies typeof HookPayload.Type
  return yield* decodeHookPayload(raw)
}).pipe(
  Effect.mapError(() => new AnnounceInputError({ message: "Stdin must be the Claude Code hook JSON." }))
)

const orUndefined = Option.getOrUndefined

/**
 * Flags win over the hook JSON. Decides once; a `speak` decision calls
 * `Speaker.speak` exactly once (Mac or Echo, per `AI_VOICE_OUTPUT`), with no
 * retry, and its errors fail the command.
 */
export const announce = Effect.fn("announce")(function*(flags: AnnounceFlags) {
  const path = yield* Path.Path
  const needsStdin = Option.isNone(flags.body) || Option.isNone(flags.event)
  const payload = needsStdin ? yield* readHookPayload : {}
  const event = Option.isSome(flags.event)
    ? Option.liftPredicate(flags.event.value, isAnnounceEvent)
    : Option.fromNullishOr(hookEvent(payload))
  if (Option.isSome(flags.event) && Option.isNone(event)) {
    return yield* new AnnounceInputError({
      message: `--event must be permission, waiting, finished or error; got "${flags.event.value}".`
    })
  }
  const cwdName = payload.cwd === undefined ? undefined : path.basename(payload.cwd)
  const input: AnnounceInput = {
    source: flags.source,
    body: orUndefined(flags.body) ?? payload.message ?? "",
    ...optionalKeys({
      title: orUndefined(flags.title) ?? payload.title,
      event: orUndefined(event),
      project: orUndefined(flags.project) ?? (cwdName === "" ? undefined : cwdName)
    })
  }

  const decision = yield* Announcer.use((announcer) => announcer.decide(input))
  if (decision._tag === "skip") {
    return yield* Console.error(`announce: skipped (${decision.reason}).`)
  }
  yield* Speaker.use((speaker) => speaker.speak({ text: decision.text }))
})

const optionalKeys = <A extends Record<string, string | undefined>>(values: A) =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as {
    [K in keyof A]?: Exclude<A[K], undefined>
  }
