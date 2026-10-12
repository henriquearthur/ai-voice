import { AlexaConfig } from "@jarvis/alexa"
import { Config, Context, DateTime, Effect, Layer, Option } from "effect"
import { AnnounceConfigError } from "./announce-error.ts"
import { ANNOUNCE_TIME_ZONE, parseQuietHours, type QuietHours } from "./quiet-hours.ts"

export const DEFAULT_QUIET_HOURS = "off"
export const DEFAULT_MAX_PER_MINUTE = 3

/**
 * Announcement policy. The state file lives in the Alexa state directory
 * (`AI_VOICE_STATE_DIR`, default `~/.local/share/ai-voice`).
 */
export class AnnounceConfig extends Context.Service<AnnounceConfig, {
  readonly stateDir: string
  readonly quietHours: Option.Option<QuietHours>
  readonly timeZone: DateTime.TimeZone
  readonly maxPerMinute: number
}>()("@jarvis/announce/AnnounceConfig") {
  static readonly layer = Layer.effect(
    AnnounceConfig,
    Effect.gen(function*() {
      const { stateDir } = yield* AlexaConfig
      const quietRaw = yield* Config.String("JARVIS_ANNOUNCE_QUIET").pipe(Config.withDefault(DEFAULT_QUIET_HOURS))
      const quietHours = yield* Option.match(parseQuietHours(quietRaw), {
        onNone: () =>
          Effect.fail(
            new AnnounceConfigError({
              message: `JARVIS_ANNOUNCE_QUIET must look like "23:00-07:00" or be "off"; got "${quietRaw}".`
            })
          ),
        onSome: Effect.succeed
      })
      const maxPerMinute = yield* Config.Int("JARVIS_ANNOUNCE_MAX_PER_MINUTE").pipe(
        Config.withDefault(DEFAULT_MAX_PER_MINUTE)
      )
      if (maxPerMinute < 1) {
        return yield* new AnnounceConfigError({ message: "JARVIS_ANNOUNCE_MAX_PER_MINUTE must be at least 1." })
      }
      return AnnounceConfig.of({
        stateDir,
        quietHours,
        timeZone: DateTime.zoneMakeNamedUnsafe(ANNOUNCE_TIME_ZONE),
        maxPerMinute
      })
    })
  )
}
