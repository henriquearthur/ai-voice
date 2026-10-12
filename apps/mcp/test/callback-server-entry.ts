// Runs the real callback server under Bun with a fake Alexa that reports each
// notice on stdout as JSON, and one task pending in a temporary state directory.
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Alexa, AlexaConfig } from "@jarvis/alexa"
import { GrokBotOutbox } from "@jarvis/grokbot"
import { Config, Console, Effect, Layer, Option } from "effect"
import { CallbackTransport } from "../src/callback-server.ts"
import { fakeSpeaker, makeFakeMacVoice, PENDING_ID } from "./callback-fixtures.ts"

const program = Effect.gen(function*() {
  const stateDir = yield* Config.String("AI_VOICE_STATE_DIR")
  const token = yield* Config.Redacted("JARVIS_CALLBACK_TOKEN")
  const config = Layer.succeed(
    AlexaConfig,
    AlexaConfig.of({
      stateDir,
      amazonPage: "amazon.com.br",
      locale: "pt-BR",
      alexaHost: Option.none(),
      speechEnabled: true,
      defaultDevice: Option.some("ECHO-1"),
      speakLock: `${stateDir}/alexa-speak.lock`
    })
  )
  const alexa = Layer.succeed(
    Alexa,
    Alexa.of({
      devices: Effect.succeed([]),
      speak: ({ text }) =>
        Console.log(JSON.stringify({ spoken: text })).pipe(
          Effect.as({ status: "accepted", device: "ECHO-1", chunks: 1, playbackConfirmed: false } as const)
        )
    })
  )
  const outbox = GrokBotOutbox.layerAt(stateDir)
  yield* GrokBotOutbox.use((outbox) =>
    outbox.markPending({ requestId: PENDING_ID, taskHash: "hash", sentAt: Date.now() })
  ).pipe(Effect.provide(outbox))
  return yield* Layer.launch(
    CallbackTransport({ port: 0, token }).pipe(
      // Notices go to the fake Echo; the fake Mac voice never plays sound.
      Layer.provide(Layer.mergeAll(fakeSpeaker("echo", alexa, makeFakeMacVoice().layer, config), outbox))
    )
  )
})

program.pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
