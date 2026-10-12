import { observeTools } from "@jarvis/telemetry"
import { AlexaConfig, speechDisabled } from "@jarvis/alexa"
import { contentHash, DEDUP_WINDOW_MS, isOffPersona, sanitize } from "@jarvis/announce"
import {
  DeliveryOutcome,
  DeliveryStatus,
  GrokBotOutbox,
  GrokBotOutboxError,
  MAX_RESULT_BYTES,
  RequestId,
  ResultMarkdown
} from "@jarvis/grokbot"
import { MacVoice } from "@jarvis/voice"
import { Clock, Duration, Effect, FileSystem, Layer, Path, Random, Schema, SchemaTransformation, Semaphore } from "effect"
import { McpServer, Tool, Toolkit } from "effect/ai"
import { SpeakError, Speaker } from "./speaker.ts"

export const NotifyEvent = Schema.Literals(["task_done", "task_failed", "needs_attention"])
export type NotifyEvent = typeof NotifyEvent.Type

/**
 * The only sentences `notify_fernando` can speak. Callers pick an event and
 * never supply text, so nothing a remote caller writes is ever spoken.
 */
export const notificationTemplates: Readonly<Record<NotifyEvent, string>> = {
  task_done: "Terminei aquela tarefa, o resultado já chegou.",
  task_failed: "Não consegui terminar aquela tarefa, dá uma olhada quando puder.",
  needs_attention: "Preciso da sua atenção num negócio."
}

export const NOTIFICATION_LIMITS = [
  { window: Duration.minutes(1), max: 3 },
  { window: Duration.days(1), max: 20 }
] as const

const QUOTA_FILE = "callback-notifications.json"

export const MAX_SPOKEN_TEXT_LENGTH = 300

/** Free text for `speak_fernando`: one short plain sentence, no `<` or `>`, trimmed and not blank. */
export const SpokenText = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(MAX_SPOKEN_TEXT_LENGTH), Schema.isPattern(/^[^<>]*$/u)),
  Schema.decodeTo(Schema.Trimmed.check(Schema.isNonEmpty()), SchemaTransformation.trim())
)

export class NotificationError extends Schema.TaggedError<NotificationError>()("NotificationError", {
  message: Schema.String
}) {}

const GrokBotDeliver = Tool.make("grokbot_deliver", {
  description: "Delivers the result of a task that Jarvis sent with a request_id. " +
    "Accepted once per request_id, within 24 hours of sending; a repeated delivery is reported as already_delivered " +
    "and does not replace the first.",
  parameters: Schema.Struct({
    requestId: RequestId.annotate({ description: "The request_id received with the task." }),
    status: DeliveryStatus.annotate({ description: "done when the task succeeded, failed otherwise." }),
    resultMd: ResultMarkdown.annotate({
      description: `The result as Markdown, up to ${MAX_RESULT_BYTES} bytes of UTF-8.`
    })
  }).pipe(Schema.encodeKeys({ requestId: "request_id", resultMd: "result_md" })),
  success: Schema.Struct({ requestId: Schema.String, outcome: DeliveryOutcome }).pipe(
    Schema.encodeKeys({ requestId: "request_id" })
  ),
  failure: GrokBotOutboxError
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)

const NotifyFernando = Tool.make("notify_fernando", {
  description: "Speaks a short, fixed notice for the given event to the user, on the Mac or the Echo. " +
    "At most 3 per minute and 20 per day; never retry after an error.",
  parameters: Schema.Struct({
    event: NotifyEvent.annotate({ description: "What happened: task_done, task_failed or needs_attention." })
  }),
  success: Schema.Struct({ event: NotifyEvent, status: Schema.Literal("accepted") }),
  failure: Schema.Union([SpeakError, NotificationError])
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)

const SpeakFernando = Tool.make("speak_fernando", {
  description: "Speaks one short sentence out loud on the user's Mac. Write it in Brazilian Portuguese (pt-BR), " +
    "in the first person, as if you were sitting next to the user; never say who is speaking or name any " +
    "assistant, bot or agent. Plain words only: no links, file paths, e-mails, codes or secrets, which are refused. " +
    `Up to ${MAX_SPOKEN_TEXT_LENGTH} characters. Shares the limit of notify_fernando (3 per minute, 20 per day); ` +
    "the same sentence within 10 minutes is refused as a duplicate. Never retry after an error.",
  parameters: Schema.Struct({
    text: SpokenText.annotate({
      description: `The sentence to speak, in pt-BR, up to ${MAX_SPOKEN_TEXT_LENGTH} characters, without < or >.`
    })
  }),
  success: Schema.Struct({ status: Schema.Literal("accepted"), playbackConfirmed: Schema.Boolean }).pipe(
    Schema.encodeKeys({ playbackConfirmed: "playback_confirmed" })
  ),
  failure: Schema.Union([SpeakError, NotificationError])
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)

/**
 * The only tools the public callback endpoint serves.
 */
export const CallbackToolkit = Toolkit.make(GrokBotDeliver, NotifyFernando, SpeakFernando)

/**
 * Why `speak_fernando` refuses a text, or `undefined` when it may be spoken.
 * Anything the redaction filter would touch is refused outright, never spoken redacted.
 */
export const refuseSpokenText = (text: string): string | undefined => {
  const sanitized = sanitize(text)
  if (sanitized.redactions > 0) {
    return "The text contains a link, file path, e-mail, code or secret. Nothing was spoken."
  }
  if (sanitized.meaningfulWords === 0) return "The text has no words to speak. Nothing was spoken."
  if (isOffPersona(sanitized.text)) {
    return "The text names a speaker, assistant, bot or agent; speak in the first person. Nothing was spoken."
  }
  return undefined
}

// Only content hashes are stored, never the spoken text.
const Quota = Schema.Struct({
  acceptedAt: Schema.Array(Schema.Int),
  spoken: Schema.optionalKey(Schema.Array(Schema.Struct({ hash: Schema.String, at: Schema.Int })))
})
const QuotaJson = Schema.fromJsonString(Quota)

const quotaUnavailable = () =>
  new NotificationError({ message: "The notification quota could not be read or saved, so nothing was spoken." })

// Persisted so a restart cannot reset the limits.
const makeQuota = Effect.fnUntraced(function*(stateDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const file = path.join(stateDir, QUOTA_FILE)
  const lock = yield* Semaphore.make(1)
  const longest = Math.max(...NOTIFICATION_LIMITS.map(({ window }) => Duration.toMillis(window)))

  const load = fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(QuotaJson)),
    Effect.map(({ acceptedAt, spoken }) => ({ acceptedAt, spoken: spoken ?? [] })),
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed({ acceptedAt: [], spoken: [] })
    )
  )

  const save = Effect.fnUntraced(function*(quota: typeof Quota.Type) {
    yield* fs.makeDirectory(stateDir, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${yield* Random.nextInt}.tmp`
    const contents = yield* Schema.encodeEffect(QuotaJson)(quota)
    yield* Effect.gen(function*() {
      yield* fs.writeFileString(temporary, contents, { mode: 0o600 })
      yield* fs.chmod(temporary, 0o600)
      yield* fs.rename(temporary, file)
    }).pipe(Effect.onError(() => Effect.ignore(fs.remove(temporary))))
  })

  // Counted when accepted, before speaking: a failed or interrupted speech still spends its slot.
  // With a content hash, the same text within the dedup window is refused without spending one.
  const take = (hash?: string) => Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const stored = yield* load.pipe(Effect.mapError(quotaUnavailable))
    const recent = stored.acceptedAt.filter((at) => now - at < longest)
    const spoken = stored.spoken.filter(({ at }) => now - at < DEDUP_WINDOW_MS && at <= now)
    if (hash !== undefined && spoken.some((entry) => entry.hash === hash)) {
      return yield* new NotificationError({
        message: "The same text was already spoken in the last 10 minutes. Nothing was spoken."
      })
    }
    for (const { max, window } of NOTIFICATION_LIMITS) {
      if (recent.filter((at) => now - at < Duration.toMillis(window)).length >= max) {
        return yield* new NotificationError({
          message: `Notification limit reached: at most ${max} per ${Duration.format(window)}. Nothing was spoken.`
        })
      }
    }
    yield* save({
      acceptedAt: [...recent, now],
      spoken: hash === undefined ? spoken : [...spoken, { hash, at: now }]
    }).pipe(Effect.mapError(quotaUnavailable))
  }).pipe(Semaphore.withPermits(lock, 1))

  return { take }
})

/**
 * Binds the callback tools to the outbox, to the shared `Speaker` for notices,
 * which play on the output chosen by `AI_VOICE_OUTPUT`, and to the Mac voice
 * for free text, which only ever plays on this Mac.
 */
export const CallbackToolkitHandlers = CallbackToolkit.toLayer(Effect.gen(function*() {
  const outbox = yield* GrokBotOutbox
  const speaker = yield* Speaker
  const mac = yield* MacVoice
  const { speechEnabled, stateDir } = yield* AlexaConfig
  const quota = yield* makeQuota(stateDir)
  return CallbackToolkit.of(observeTools("callback", {
    grokbot_deliver: (input) =>
      Effect.map(outbox.deliver(input), (outcome) => ({ requestId: input.requestId, outcome })),
    // A single attempt: a lost answer does not mean nothing was spoken.
    notify_fernando: ({ event }) =>
      quota.take().pipe(
        Effect.andThen(speaker.speak({ text: notificationTemplates[event] })),
        Effect.as({ event, status: "accepted" as const })
      ),
    // Checked before the quota, so refused or disabled speech spends no slot. A single attempt.
    speak_fernando: Effect.fnUntraced(function*({ text }) {
      const refusal = refuseSpokenText(text)
      if (refusal !== undefined) return yield* new NotificationError({ message: refusal })
      if (!speechEnabled) return yield* speechDisabled()
      const spoken = sanitize(text).text
      yield* quota.take(contentHash(spoken))
      const played = yield* mac.speak(spoken)
      return { status: "accepted" as const, playbackConfirmed: played.playbackConfirmed }
    })
  }))
}))

/**
 * Registers the callback tools on whichever `McpServer` transport is provided.
 */
export const layer = McpServer.toolkit(CallbackToolkit).pipe(Layer.provide(CallbackToolkitHandlers))
