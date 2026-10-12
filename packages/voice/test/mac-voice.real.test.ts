import { BunServices } from "@effect/platform-bun"
import { assert, describe, it } from "@effect/vitest"
import { Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient } from "effect/http"
import { MacVoice, MacVoiceConfig } from "../src/index.ts"

// Real /usr/bin/lockf and /usr/bin/say, silent: `say -o` writes the audio to a file instead of the
// speakers. The TTS URL points at a closed port, so the say fallback runs and afplay never does.
// The lock lives in a throwaway directory, never the real ~/.local/share/jarvis/fala.lock.
// AI_VOICE_TEST_LOCK_DIR picks where the temp dir goes.
describe.skipIf(process.platform !== "darwin")("MacVoice against the real say(1), without audio", () => {
  it.live("speaks into a file through lockf", () =>
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = process.env.AI_VOICE_TEST_LOCK_DIR
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "mac-voice-test-", ...(parent ? { directory: parent } : {}) })
      const audioFile = path.join(dir, "speech.aiff")
      const lock = path.join(dir, "jarvis", "fala.lock")
      const config = Layer.succeed(
        MacVoiceConfig,
        MacVoiceConfig.of({ voice: "Luciana", lock, ttsUrl: "http://127.0.0.1:1", ttsVoice: "pf_dora" })
      )
      const played = yield* MacVoice.use((voice) => voice.speak("Teste silencioso do Jarvis.")).pipe(
        Effect.provide(MacVoice.layerWith({ audioFile }).pipe(Layer.provide([config, FetchHttpClient.layer])))
      )
      assert.isTrue(played.playbackConfirmed)
      assert.isAbove(Number((yield* fs.stat(audioFile)).size), 1000)
      assert.isTrue(yield* fs.exists(lock))
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)), 30_000)
})
