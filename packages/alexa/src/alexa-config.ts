import { Config, Context, Effect, Layer, Option, Path, String } from "effect"

const optional = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.filter(String.isNonEmpty)))

export const DEFAULT_SPEAK_LOCK = "/tmp/alexa-speak.lock"

export class AlexaConfig extends Context.Service<AlexaConfig, {
  readonly stateDir: string
  readonly amazonPage: string
  readonly locale: string
  readonly alexaHost: Option.Option<string>
  readonly speechEnabled: boolean
  readonly defaultDevice: Option.Option<string>
  /** flock(2) file shared with the `lockf -t 90 <file>` scripts that also speak on the Echo. */
  readonly speakLock: string
}>()("@jarvis/alexa/AlexaConfig") {
  static readonly layer = Layer.effect(
    AlexaConfig,
    Effect.gen(function*() {
      const path = yield* Path.Path
      const stateDir = yield* Option.match(yield* optional("AI_VOICE_STATE_DIR"), {
        onNone: () => Config.String("HOME").pipe(Config.map((home) => path.join(home, ".local/share/ai-voice"))),
        onSome: Config.succeed
      })
      return AlexaConfig.of({
        stateDir: path.resolve(stateDir),
        amazonPage: Option.getOrElse(yield* optional("AI_VOICE_AMAZON_PAGE"), () => "amazon.com"),
        locale: Option.getOrElse(yield* optional("AI_VOICE_LOCALE"), () => "en-US"),
        alexaHost: yield* optional("AI_VOICE_ALEXA_HOST"),
        speechEnabled: Option.contains(yield* optional("AI_VOICE_ENABLE_SPEECH"), "1"),
        defaultDevice: yield* optional("AI_VOICE_DEFAULT_DEVICE"),
        speakLock: path.resolve(Option.getOrElse(yield* optional("AI_VOICE_SPEAK_LOCK"), () => DEFAULT_SPEAK_LOCK))
      })
    })
  )
}
