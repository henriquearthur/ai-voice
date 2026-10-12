import {
  Array as Arr,
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Metric,
  Option,
  Order,
  Path,
  Random,
  Schema,
  Semaphore,
  String as Str
} from "effect"

export const MAX_RESULT_BYTES = 50 * 1024

/** A routine may deliver its result up to this long after the task was sent. */
export const PENDING_TTL = Duration.hours(24)

/** Entries older than this are pruned, delivered or not. */
export const RETENTION = Duration.days(7)

/** The outbox never keeps more entries than this; the oldest go first. */
export const MAX_ENTRIES = 500

const OUTBOX_DIRECTORY = "grokbot-outbox"

/** From the task being sent to its result arriving, for each first delivery, by `status`. */
export const deliveryLatency = Metric.histogram("jarvis_grokbot_entrega_ms", {
  description: "Tempo entre enviar a tarefa ao Grok Bot e receber o resultado, em milissegundos.",
  boundaries: [1000, 5000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000, 21600000, 86400000]
})

const utf8 = new TextEncoder()

// Lowercase only: the id names a file, and macOS volumes ignore case.
export const RequestId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, {
    expected: "a lowercase UUID"
  })
)

export const DeliveryStatus = Schema.Literals(["done", "failed"])

export const ResultMarkdown = Schema.String.check(
  Schema.makeFilter((text) => utf8.encode(text).byteLength <= MAX_RESULT_BYTES, {
    expected: `at most ${MAX_RESULT_BYTES} bytes of UTF-8`
  })
)

export const Delivery = Schema.Struct({
  requestId: RequestId,
  status: DeliveryStatus,
  resultMd: ResultMarkdown
})

export const OutboxEntry = Schema.Struct({
  requestId: RequestId,
  taskHash: Schema.String,
  sentAt: Schema.Int,
  status: Schema.Literals(["pending", "done", "failed"]),
  deliveredAt: Schema.optionalKey(Schema.Int),
  resultMd: Schema.optionalKey(Schema.String)
})
export type OutboxEntry = typeof OutboxEntry.Type

/**
 * `already_delivered` means an earlier delivery for the same id was kept as is.
 */
export const DeliveryOutcome = Schema.Literals(["delivered", "already_delivered"])
export type DeliveryOutcome = typeof DeliveryOutcome.Type

export class GrokBotOutboxError extends Schema.TaggedError<GrokBotOutboxError>()("GrokBotOutboxError", {
  message: Schema.String
}) {}

const EntryJson = Schema.fromJsonString(OutboxEntry)
const decodeEntry = Schema.decodeUnknownEffect(EntryJson)
const encodeEntry = Schema.encodeEffect(EntryJson)
const decodeDelivery = Schema.decodeUnknownEffect(Delivery)
const isRequestId = Schema.is(RequestId)

const byNewest = Order.flip(Order.mapInput(Order.Number, (entry: OutboxEntry) => entry.sentAt))

const storageError = () => new GrokBotOutboxError({ message: "The Grok Bot outbox could not be read or written." })

const optional = (name: string) => Config.String(name).pipe(Config.option, Config.map(Option.filter(Str.isNonEmpty)))

// Same resolution as AlexaConfig, so every Jarvis process shares one state directory.
const StateDir = Effect.gen(function*() {
  const path = yield* Path.Path
  const stateDir = yield* Option.match(yield* optional("AI_VOICE_STATE_DIR"), {
    onNone: () => Config.String("HOME").pipe(Config.map((home) => path.join(home, ".local/share/ai-voice"))),
    onSome: Config.succeed
  })
  return path.resolve(stateDir)
})

const make = Effect.fnUntraced(function*(stateDir: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(stateDir, OUTBOX_DIRECTORY)
  const fileOf = (requestId: string) => path.join(directory, `${requestId}.json`)
  // Deliveries are read-modify-write; one at a time keeps a duplicate from racing the first.
  const deliveries = yield* Semaphore.make(1)

  const prepare = Effect.gen(function*() {
    for (const dir of [stateDir, directory]) {
      yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
      // mkdir leaves an existing directory's mode untouched.
      yield* fs.chmod(dir, 0o700)
    }
  })

  // Write then rename, so a crash never leaves a truncated entry behind.
  const write = Effect.fnUntraced(function*(entry: OutboxEntry) {
    const file = fileOf(entry.requestId)
    const temporary = `${file}.${yield* Random.nextInt}.tmp`
    const contents = yield* encodeEntry(entry)
    yield* Effect.gen(function*() {
      yield* fs.writeFileString(temporary, contents, { mode: 0o600 })
      yield* fs.chmod(temporary, 0o600)
      yield* fs.rename(temporary, file)
    }).pipe(Effect.onError(() => Effect.ignore(fs.remove(temporary))))
  })

  const read = (requestId: string) =>
    fs.readFileString(fileOf(requestId)).pipe(
      Effect.flatMap(decodeEntry),
      Effect.map(Option.some),
      Effect.catchIf(
        (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
        () => Effect.succeedNone
      )
    )

  const readAll = Effect.gen(function*() {
    const names = yield* fs.readDirectory(directory).pipe(
      Effect.catchIf((error) => error.reason._tag === "NotFound", () => Effect.succeed([]))
    )
    const ids = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter(isRequestId)
    const entries = yield* Effect.forEach(ids, (id) => Effect.option(read(id)), { concurrency: 8 })
    return Arr.sort(Arr.getSomes(entries.map(Option.flatten)), byNewest)
  })

  const prune = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const cutoff = now - Duration.toMillis(RETENTION)
    const entries = yield* readAll
    const stale = entries.filter((entry, index) => entry.sentAt < cutoff || index >= MAX_ENTRIES)
    yield* Effect.forEach(stale, (entry) => Effect.ignore(fs.remove(fileOf(entry.requestId))), { discard: true })
  })

  const markPending = Effect.fn("GrokBotOutbox.markPending")(
    function*(input: { readonly requestId: string; readonly taskHash: string; readonly sentAt: number }) {
      yield* prepare
      yield* write({ requestId: input.requestId, taskHash: input.taskHash, sentAt: input.sentAt, status: "pending" })
      // The entry is already saved; a failed prune only delays cleanup.
      yield* Effect.ignore(prune)
    },
    Effect.mapError(storageError)
  )

  const deliver = Effect.fn("GrokBotOutbox.deliver")(function*(input: typeof Delivery.Encoded) {
    const delivery = yield* decodeDelivery(input).pipe(
      Effect.mapError((error) => new GrokBotOutboxError({ message: `Invalid delivery: ${error.message}` }))
    )
    yield* Effect.annotateCurrentSpan({ requestId: delivery.requestId })
    return yield* Effect.gen(function*() {
      const entry = yield* read(delivery.requestId).pipe(Effect.mapError(storageError))
      if (Option.isNone(entry)) {
        return yield* new GrokBotOutboxError({ message: "Unknown request_id: no task was sent with this id." })
      }
      if (entry.value.status !== "pending") return "already_delivered" as const
      const now = yield* Clock.currentTimeMillis
      if (now - entry.value.sentAt >= Duration.toMillis(PENDING_TTL)) {
        return yield* new GrokBotOutboxError({
          message: `Expired request_id: results are accepted up to ${Duration.format(PENDING_TTL)} after sending.`
        })
      }
      yield* write({ ...entry.value, status: delivery.status, resultMd: delivery.resultMd, deliveredAt: now }).pipe(
        Effect.mapError(storageError)
      )
      yield* Metric.update(
        Metric.withAttributes(deliveryLatency, { status: delivery.status }),
        Math.max(0, now - entry.value.sentAt)
      )
      return "delivered" as const
    }).pipe(Semaphore.withPermits(deliveries, 1))
  })

  const get = Effect.fn("GrokBotOutbox.get")(function*(requestId: string) {
    if (!isRequestId(requestId)) return Option.none<OutboxEntry>()
    return yield* read(requestId).pipe(Effect.mapError(storageError))
  })

  const list = readAll.pipe(Effect.mapError(storageError), Effect.withSpan("GrokBotOutbox.list"))

  return GrokBotOutbox.of({ markPending, deliver, get, list })
})

/**
 * Where Grok Bot results land: one private JSON file per dispatched task in
 * `<state dir>/grokbot-outbox`, so the process that sends tasks and the one
 * that receives results never rewrite each other's entries.
 *
 * An entry is created as pending before the webhook is called, and accepts a
 * single delivery within `PENDING_TTL`.
 */
export class GrokBotOutbox extends Context.Service<GrokBotOutbox, {
  markPending(input: {
    readonly requestId: string
    readonly taskHash: string
    readonly sentAt: number
  }): Effect.Effect<void, GrokBotOutboxError>
  deliver(input: typeof Delivery.Encoded): Effect.Effect<DeliveryOutcome, GrokBotOutboxError>
  get(requestId: string): Effect.Effect<Option.Option<OutboxEntry>, GrokBotOutboxError>
  readonly list: Effect.Effect<ReadonlyArray<OutboxEntry>, GrokBotOutboxError>
}>()("@jarvis/grokbot/GrokBotOutbox") {
  /**
   * The outbox in an explicit state directory.
   */
  static readonly layerAt = (stateDir: string) => Layer.effect(GrokBotOutbox, make(stateDir))

  /**
   * The outbox in `AI_VOICE_STATE_DIR`, or `~/.local/share/ai-voice`.
   */
  static readonly layer = Layer.effect(GrokBotOutbox, Effect.flatMap(StateDir, make))
}
