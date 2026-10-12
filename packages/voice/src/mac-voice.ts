import { Clock, Context, Duration, Effect, Exit, FileSystem, Layer, Metric, Option, Path, Schema, SchemaTransformation } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { MacVoiceConfig, type TtsRecovery } from "./mac-voice-config.ts"
import { MacVoiceError } from "./mac-voice-error.ts"

export const LOCKF = "/usr/bin/lockf"
export const SAY = "/usr/bin/say"
export const AFPLAY = "/usr/bin/afplay"
export const LAUNCHCTL = "/bin/launchctl"
/**
 * Longest wait for the lock while another program speaks (`lockf -t`). When it expires nothing
 * was spoken and lockf exits with EX_TEMPFAIL, reported as "Mac ocupado".
 */
export const QUEUE_TIMEOUT = Duration.seconds(120)
/** Playback budget: a fixed margin plus a generous time per character (Portuguese speech runs at about 70 ms per character). */
export const PLAYBACK_MARGIN = Duration.seconds(60)
export const PLAYBACK_PER_CHARACTER = Duration.millis(250)
/**
 * Safety net for a stuck player, never for a long speech: the queue wait plus a playback budget
 * proportional to the text, so a speech that started playing is not cut by it.
 */
export const speechTimeout = (text: string): Duration.Duration =>
  Duration.sum(QUEUE_TIMEOUT, Duration.sum(PLAYBACK_MARGIN, Duration.times(PLAYBACK_PER_CHARACTER, text.length)))
/** The TTS server gets one attempt of this long; after that the speech falls back to `say`. */
export const SYNTHESIS_TIMEOUT = Duration.seconds(10)
/** One `/health` probe before deciding the server is down. */
const HEALTH_TIMEOUT = Duration.seconds(2)
const HEALTH_POLL = Duration.seconds(1)
// SIGTERM first; a process that ignores it is SIGKILLed after this grace period.
const FORCE_KILL_AFTER = Duration.seconds(2)
// lockf(1) exit status when the timeout expires before the lock is free (sysexits EX_TEMPFAIL).
const EX_TEMPFAIL = 75
// Exit status of the guard below when `jarvis-cala` rewrote the cancel marker while this speech waited in the queue.
export const EX_CANCELLED = 76
// lockf exits 70 (EX_SOFTWARE) when the player dies on a signal; 143 is SIGTERM seen directly. Both mean `jarvis-cala` stopped the speech.
const STOPPED_CODES: ReadonlyArray<number> = [70, 143]
/**
 * Runs under the lock, before the player: `$1` is the cancel marker, `$2` the content it had when
 * the speech entered the queue. A different content means `jarvis-cala` ran since then.
 */
export const CANCEL_GUARD = `[ "$(cat "$1" 2>/dev/null)" = "$2" ] || exit ${EX_CANCELLED}; shift 2; exec "$@"`
// A WAV file starts with a 44-byte RIFF header.
const WAV_HEADER_LENGTH = 44

export const MAX_TEXT_LENGTH = 4000

const VOICE_BOUNDARIES_MS = [25, 50, 100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 8000, 10000, 15000, 30000, 60000, 90000, 120000, 180000, 300000, 600000]

/** One POST to the TTS server, by `resultado`: `ok`, or `falhou` when the speech fell back to `say`. */
export const synthesisLatency = Metric.histogram("jarvis_voz_sintese_ms", {
  description: "Duração da síntese no servidor Kokoro vista pelo cliente, em milissegundos.",
  boundaries: VOICE_BOUNDARIES_MS
})

/** From the speak request to the player starting, by `motor` (kokoro or say). */
export const timeToAudio = Metric.histogram("jarvis_voz_ate_audio_ms", {
  description: "Tempo do pedido de fala até o áudio começar a tocar no Mac, em milissegundos.",
  boundaries: VOICE_BOUNDARIES_MS
})

/** The whole speech on the Mac, playback included, by `motor`. */
export const speechDuration = Metric.histogram("jarvis_voz_fala_ms", {
  description: "Duração total de uma fala no Mac, síntese e reprodução incluídas, em milissegundos.",
  boundaries: VOICE_BOUNDARIES_MS
})

/** Same rules as the Echo: plain text up to 4000 UTF-16 code units, no `<` or `>`, trimmed and not blank. */
export const MacSpeechText = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(MAX_TEXT_LENGTH), Schema.isPattern(/^[^<>]*$/u)),
  Schema.decodeTo(Schema.Trimmed.check(Schema.isNonEmpty()), SchemaTransformation.trim())
)

export const MAC_DEVICE = "Mac"

export const MacSpeechPlayed = Schema.Struct({
  status: Schema.Literal("accepted"),
  device: Schema.Literal(MAC_DEVICE),
  chunks: Schema.Literal(1),
  // afplay and say return only after the audio ended, so playback is confirmed.
  playbackConfirmed: Schema.Literal(true)
})
export type MacSpeechPlayed = typeof MacSpeechPlayed.Type

export interface MacVoiceOptions {
  /** Writes the `say` audio to this file (`say -o`) instead of the speakers. For tests only. */
  readonly audioFile?: string | undefined
}

const fail = (message: string) => Effect.fail(new MacVoiceError({ message }))

const isWav = (bytes: Uint8Array) =>
  bytes.length > WAV_HEADER_LENGTH && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF"

const make = Effect.fnUntraced(function*(options: MacVoiceOptions = {}) {
  const config = yield* MacVoiceConfig
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const client = yield* HttpClient.HttpClient
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const decode = Schema.decodeUnknownEffect(MacSpeechText)

  /**
   * `lockf -k -t 120 <lock> <player...>`: lockf waits up to QUEUE_TIMEOUT for every other program speaking through the
   * same file (such as `jarvis-fala`), then runs the player holding the lock until it exits. `-k`
   * keeps the file, because removing it would let a waiting process lock a deleted inode.
   */
  const cancelFile = config.cancel ?? path.join(path.dirname(config.lock), "fala.cancel")
  const locked = (player: ReadonlyArray<string>, entry: string) =>
    ChildProcess.make(
      LOCKF,
      [
        "-k",
        "-t",
        String(Duration.toSeconds(QUEUE_TIMEOUT)),
        config.lock,
        "/bin/sh",
        "-c",
        CANCEL_GUARD,
        "sh",
        cancelFile,
        entry,
        ...player
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore", forceKillAfter: FORCE_KILL_AFTER }
    )

  // `--` keeps a text that starts with `-` from being read as an option.
  const sayCommand = (text: string, entry: string) =>
    locked([
      SAY,
      "-v",
      config.voice,
      ...(options.audioFile === undefined ? [] : ["-o", options.audioFile]),
      "--",
      text
    ], entry)

  /** The cancel marker as the speech sees it when it enters the queue (empty when absent). */
  const readCancel = fs.readFileString(cancelFile).pipe(
    Effect.map((content) => content.trim()),
    Effect.orElseSucceed(() => "")
  )

  /**
   * One POST to the local TTS server. Any failure (unreachable, HTTP error, not a WAV, more than
   * 10 seconds) yields None, and the caller falls back to `say`. Nothing has played at that point.
   */
  const synthesize = (text: string): Effect.Effect<Option.Option<Uint8Array>> =>
    Effect.flatMap(Clock.currentTimeMillis, (start) => synthesizeOnce(text).pipe(
      Effect.tap((wav) => {
        const resultado = Option.isSome(wav) ? "ok" : "falhou"
        return Effect.flatMap(Clock.currentTimeMillis, (end) =>
          Effect.andThen(
            Effect.annotateCurrentSpan({ "jarvis.tts.resultado": resultado }),
            Metric.update(Metric.withAttributes(synthesisLatency, { resultado }), end - start)
          ))
      })
    )).pipe(Effect.withSpan("MacVoice.synthesize"))

  const synthesizeOnce = (text: string): Effect.Effect<Option.Option<Uint8Array>> =>
    Effect.gen(function*() {
      const request = HttpClientRequest.post(`${config.ttsUrl}/synthesize`).pipe(
        HttpClientRequest.bodyText(JSON.stringify({ text, voice: config.ttsVoice }), "application/json"),
        HttpClientRequest.accept("audio/wav")
      )
      const response = yield* client.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(HttpClient.TracerPropagationEnabled, false)
      )
      if (response.status < 200 || response.status >= 300) return Option.none()
      const bytes = new Uint8Array(yield* response.arrayBuffer)
      return isWav(bytes) ? Option.some(bytes) : Option.none()
    }).pipe(
      Effect.timeoutOrElse({ duration: SYNTHESIS_TIMEOUT, orElse: () => Effect.succeed(Option.none()) }),
      Effect.catch(() => Effect.succeed(Option.none<Uint8Array>()))
    )

  // A single attempt. The process lives only inside exitCode's scope: on timeout or
  // interruption the spawner kills its process group, lockf and the player included.
  const play = Effect.fnUntraced(function*(
    command: ChildProcess.Command,
    player: string,
    text: string,
    stopped: { reason?: "descartada" | "interrompida" }
  ) {
    const timeout = speechTimeout(text)
    const code = yield* spawner.exitCode(command).pipe(
      Effect.catchTag("PlatformError", () => fail(`Could not run ${LOCKF} ${player}. Nothing was spoken.`)),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          fail(
            `Speech on the Mac did not finish within ${Duration.format(timeout)} and was stopped. ` +
              "Do not retry automatically."
          )
      })
    )
    if (code === EX_CANCELLED) {
      stopped.reason = "descartada"
      return yield* fail(
        "Fala descartada: o Jarvis foi interrompido (jarvis-cala) enquanto ela esperava na fila. " +
          "Nothing was spoken; do not retry automatically."
      )
    }
    if (STOPPED_CODES.includes(code)) {
      stopped.reason = "interrompida"
      return yield* fail("Fala interrompida (jarvis-cala) durante a reprodução. Do not retry automatically.")
    }
    if (code === EX_TEMPFAIL) {
      return yield* fail(
        `Mac ocupado: another program kept speaking for ${Duration.format(QUEUE_TIMEOUT)}. ` +
          "Nothing was spoken; do not retry automatically."
      )
    }
    if (code !== 0) {
      return yield* fail(
        player === SAY
          ? `say failed with exit code ${code}. Check that AI_VOICE_MAC_VOICE names an installed voice.`
          : `afplay failed with exit code ${code}. Do not retry automatically.`
      )
    }
  })

  const playWav = (wav: Uint8Array, text: string, entry: string, stopped: { reason?: "descartada" | "interrompida" }) =>
    Effect.scoped(Effect.gen(function*() {
      // Deleted when the scope closes, after afplay exited or was killed.
      const file = yield* fs.makeTempFileScoped({ prefix: "jarvis-tts-", suffix: ".wav" }).pipe(
        Effect.tap((file) => fs.writeFile(file, wav)),
        Effect.catchTag("PlatformError", () => fail("Could not write the synthesized audio. Nothing was spoken."))
      )
      yield* play(locked([AFPLAY, file], entry), AFPLAY, text, stopped)
    }))

  const healthy: Effect.Effect<boolean> = client.execute(
    HttpClientRequest.get(`${config.ttsUrl}/health`).pipe(HttpClientRequest.accept("application/json"))
  ).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.map((response) => response.status >= 200 && response.status < 300),
    Effect.timeoutOrElse({ duration: HEALTH_TIMEOUT, orElse: () => Effect.succeed(false) }),
    Effect.catch(() => Effect.succeed(false))
  )

  const launchctl = (args: ReadonlyArray<string>) =>
    spawner.exitCode(ChildProcess.make(LAUNCHCTL, args, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      forceKillAfter: FORCE_KILL_AFTER
    })).pipe(Effect.catch(() => Effect.succeed(ChildProcessSpawner.ExitCode(1))))

  /**
   * Same steps as `sobe_servidor` in fala-kokoro.sh: kickstart the LaunchAgent if it is loaded,
   * otherwise bootstrap its plist, then wait for `/health` up to `waitSeconds`. True when the
   * server answers.
   */
  const startServer = Effect.fn("MacVoice.startServer")(function*(recovery: TtsRecovery) {
    const domain = `gui/${recovery.uid}`
    const target = `${domain}/${recovery.label}`
    const loaded = (yield* launchctl(["print", target])) === 0
    if (loaded) {
      yield* launchctl(["kickstart", target])
    } else if (yield* fs.exists(recovery.plist).pipe(Effect.orElseSucceed(() => false))) {
      yield* launchctl(["bootstrap", domain, recovery.plist])
    } else {
      return false
    }
    for (let i = 0; i < recovery.waitSeconds; i++) {
      if (yield* healthy) return true
      yield* Effect.sleep(HEALTH_POLL)
    }
    return false
  })

  /** Appends one line in the fala-kokoro.sh format (plus `motivo` when `say` replaced Kokoro). Never fails. */
  const record = (line: {
    readonly motor: string
    readonly chars: number
    readonly audioSeconds: number | "?"
    readonly rc: number
    readonly start: number
    readonly motivo?: string | undefined
  }) =>
    config.falaLog === undefined ? Effect.void : Effect.gen(function*() {
      const now = yield* Clock.currentTimeMillis
      const text = `${new Date(now).toISOString().replace(/\.\d+Z$/u, "Z")} pid=${process.pid} motor=${line.motor} ` +
        `chars=${line.chars} audio_s=${line.audioSeconds} rc=${line.rc} dur_s=${Math.floor((now - line.start) / 1000)}` +
        `${line.motivo === undefined ? "" : ` motivo=${line.motivo}`}\n`
      const file = config.falaLog!
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(file, text, { flag: "a" })
    }).pipe(Effect.ignore)

  const speak = Effect.fn("MacVoice.speak")(function*(input: string) {
    const text = yield* decode(input).pipe(
      Effect.mapError(() =>
        new MacVoiceError({ message: `Use plain text between 1 and ${MAX_TEXT_LENGTH} characters, without SSML.` })
      )
    )
    // lockf creates the lock file, but not its directory.
    yield* fs.makeDirectory(path.dirname(config.lock), { recursive: true }).pipe(
      Effect.catchTag("PlatformError", () => fail(`Could not create the directory of ${config.lock}. Nothing was spoken.`))
    )
    // Synthesis runs before taking the lock, so the lock is held only while audio plays.
    const start = yield* Clock.currentTimeMillis
    // Enter the queue: a `jarvis-cala` after this instant cancels this speech, even during synthesis.
    const entry = yield* readCancel
    const stopped: { reason?: "descartada" | "interrompida" } = {}
    let wav: Option.Option<Uint8Array> = yield* synthesize(text)
    let motivo: string | undefined
    if (Option.isNone(wav)) {
      motivo = "tts_falhou"
      const recovery = config.ttsRecovery
      // Server down (not just slow or erroring): start the LaunchAgent and try Kokoro once more.
      if (recovery !== undefined && !(yield* healthy)) {
        if (yield* startServer(recovery)) {
          wav = yield* synthesize(text)
          if (Option.isNone(wav)) motivo = "tts_falhou_apos_subir"
        } else {
          motivo = "tts_nao_subiu"
        }
      }
    }
    const motor = Option.isSome(wav) ? "kokoro" : "say"
    if (Option.isSome(wav)) motivo = undefined
    yield* Effect.annotateCurrentSpan({ "jarvis.voz.motor": motor, "jarvis.voz.caracteres": text.length })
    // The player starts right after synthesis, unless another speech holds the lock.
    yield* Metric.update(Metric.withAttributes(timeToAudio, { motor }), (yield* Clock.currentTimeMillis) - start)
    const audioSeconds = Option.isSome(wav) ? Math.floor((wav.value.length - WAV_HEADER_LENGTH) / 48000) : "?"
    const playback: Effect.Effect<void, MacVoiceError> = Option.isSome(wav)
      ? playWav(wav.value, text, entry, stopped)
      : play(sayCommand(text, entry), SAY, text, stopped)
    yield* playback.pipe(
      Effect.onExit((exit) =>
        stopped.reason === "descartada"
          ? record({ motor: "descartada", chars: text.length, audioSeconds: 0, rc: 0, start, motivo: "interrompida" })
          : record({
            motor,
            chars: text.length,
            audioSeconds,
            rc: Exit.isSuccess(exit) ? 0 : stopped.reason === "interrompida" || Exit.hasInterrupts(exit) ? 143 : 1,
            start,
            motivo
          })
      )
    )
    yield* Metric.update(Metric.withAttributes(speechDuration, { motor }), (yield* Clock.currentTimeMillis) - start)
    return { status: "accepted", device: MAC_DEVICE, chunks: 1, playbackConfirmed: true } satisfies MacSpeechPlayed
  })

  return { speak }
})

/**
 * Speaks on this Mac's default audio output, queued behind any other speech that holds the same
 * lock file. Tries the local TTS server first and plays its WAV with `afplay`; when the server
 * fails or takes more than 10 seconds, speaks with `say` instead. Succeeds only after the audio
 * has finished playing.
 */
export class MacVoice extends Context.Service<MacVoice, {
  readonly speak: (text: string) => Effect.Effect<MacSpeechPlayed, MacVoiceError>
}>()("@jarvis/voice/MacVoice") {
  static readonly layerWith = (options: MacVoiceOptions) => Layer.effect(MacVoice, make(options))

  static readonly layer: Layer.Layer<
    MacVoice,
    never,
    | MacVoiceConfig
    | ChildProcessSpawner.ChildProcessSpawner
    | HttpClient.HttpClient
    | FileSystem.FileSystem
    | Path.Path
  > = Layer.effect(MacVoice, make())
}
