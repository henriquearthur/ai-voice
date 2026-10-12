import { Config, Context, Effect, Layer, Option, Path, String } from "effect"

const optional = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.filter(String.isNonEmpty)))

export const DEFAULT_MAC_VOICE = "Luciana"
/** Relative to HOME. Shared with `~/.local/bin/jarvis-fala`, so both speak one at a time. */
export const DEFAULT_MAC_LOCK = ".local/share/jarvis/fala.lock"

export const DEFAULT_TTS_URL = "http://127.0.0.1:7349"
export const DEFAULT_TTS_VOICE = "pf_dora"

/** Cancel marker written by `jarvis-cala`; by default next to the lock (`fala.cancel`). */
export const DEFAULT_FALA_CANCEL_NAME = "fala.cancel"

/** Relative to HOME. Same file `services/tts/fala-kokoro.sh` appends to. */
export const DEFAULT_FALA_LOG = ".local/share/jarvis/tts/logs/fala.log"
export const DEFAULT_TTS_LABEL = "dev.jarvis.tts"
export const DEFAULT_TTS_WAIT_SECONDS = 20

/** How to bring the TTS LaunchAgent back when the server is down (same steps as fala-kokoro.sh). */
export interface TtsRecovery {
  readonly label: string
  /** LaunchAgent plist, used by `launchctl bootstrap` when the agent is unloaded. */
  readonly plist: string
  /** User id of the `gui/<uid>` launchd domain. */
  readonly uid: number
  /** Longest wait for `/health` after launchctl, in seconds. */
  readonly waitSeconds: number
}

export class MacVoiceConfig extends Context.Service<MacVoiceConfig, {
  /** A voice name accepted by `say -v` (see `say -v '?'`). */
  readonly voice: string
  /** flock(2) file shared with every program that speaks on this Mac through `lockf`. */
  readonly lock: string
  /**
   * Cancel marker (`jarvis-cala` rewrites it). A speech records it before waiting for the lock and
   * does not play if it changed by the time it holds the lock. Defaults to `fala.cancel` next to `lock`.
   */
  readonly cancel?: string | undefined
  /** Base URL of the local TTS server (Kokoro), tried before `say`. */
  readonly ttsUrl: string
  /** Voice the TTS server synthesizes with. */
  readonly ttsVoice: string
  /** When set, a failed synthesis with the server down starts the LaunchAgent and retries once before `say`. */
  readonly ttsRecovery?: TtsRecovery | undefined
  /** When set, one line per speech is appended here, in the format of fala-kokoro.sh. */
  readonly falaLog?: string | undefined
}>()("@jarvis/voice/MacVoiceConfig") {
  /**
   * Reads `AI_VOICE_MAC_VOICE` (default Luciana), `JARVIS_FALA_LOCK` or `AI_VOICE_MAC_LOCK` (default ~/.local/share/jarvis/fala.lock),
   * `AI_VOICE_TTS_URL` (default http://127.0.0.1:7349) and `AI_VOICE_TTS_VOICE` (default pf_dora),
   * `JARVIS_TTS_LABEL` (default dev.jarvis.tts), `JARVIS_TTS_ESPERA_S` (default 20), `JARVIS_FALA_CANCEL` (default fala.cancel next to the lock) and `JARVIS_FALA_LOG`.
   */
  static readonly layer = Layer.effect(
    MacVoiceConfig,
    Effect.gen(function*() {
      const path = yield* Path.Path
      const falaLock = yield* optional("JARVIS_FALA_LOCK")
      const macLock = yield* optional("AI_VOICE_MAC_LOCK")
      const lockEnv = Option.orElse(falaLock, () => macLock)
      const lock = yield* Option.match(lockEnv, {
        onNone: () => Config.String("HOME").pipe(Config.map((home) => path.join(home, DEFAULT_MAC_LOCK))),
        onSome: Config.succeed
      })
      const home = yield* Config.String("HOME")
      const label = Option.getOrElse(yield* optional("JARVIS_TTS_LABEL"), () => DEFAULT_TTS_LABEL)
      const wait = Number(Option.getOrElse(yield* optional("JARVIS_TTS_ESPERA_S"), () => ""))
      return MacVoiceConfig.of({
        voice: Option.getOrElse(yield* optional("AI_VOICE_MAC_VOICE"), () => DEFAULT_MAC_VOICE),
        lock: path.resolve(lock),
        cancel: path.resolve(
          Option.getOrElse(yield* optional("JARVIS_FALA_CANCEL"), () => path.join(path.dirname(lock), DEFAULT_FALA_CANCEL_NAME))
        ),
        ttsUrl: Option.getOrElse(yield* optional("AI_VOICE_TTS_URL"), () => DEFAULT_TTS_URL).replace(/\/+$/u, ""),
        ttsVoice: Option.getOrElse(yield* optional("AI_VOICE_TTS_VOICE"), () => DEFAULT_TTS_VOICE),
        ttsRecovery: {
          label,
          plist: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
          uid: process.getuid?.() ?? 501,
          waitSeconds: Number.isFinite(wait) && wait > 0 ? wait : DEFAULT_TTS_WAIT_SECONDS
        },
        falaLog: path.resolve(
          Option.getOrElse(yield* optional("JARVIS_FALA_LOG"), () => path.join(home, DEFAULT_FALA_LOG))
        )
      })
    })
  )
}
