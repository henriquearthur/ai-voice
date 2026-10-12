import { Alexa, AlexaConfig, SpeechError } from "@jarvis/alexa"
import { GrokBotOutbox } from "@jarvis/grokbot"
import { MacVoice, MacVoiceError } from "@jarvis/voice"
import { Effect, FileSystem, Layer, Option, Path, PlatformError } from "effect"
import { Speaker, type SpeechOutput } from "../src/speaker.ts"

export const STATE_DIR = "/state"
export const PENDING_ID = "aaaaaaaa-0000-4000-8000-00000000000a"

export interface Entry {
  readonly directory: boolean
  readonly mode: number
  readonly content?: string
}

// In-memory FileSystem covering the calls the callback server makes, recording file modes.
export const makeMemoryFileSystem = () => {
  const entries = new Map<string, Entry>()
  const failure = (tag: "NotFound" | "AlreadyExists", method: string, path: string) =>
    PlatformError.systemError({ _tag: tag, module: "FileSystem", method, pathOrDescriptor: path })
  const children = (path: string) =>
    [...entries.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => key.slice(path.length + 1))
  const layer = FileSystem.layerNoop({
    makeDirectory: (path, options) =>
      Effect.sync(() => {
        if (!entries.has(path)) entries.set(path, { directory: true, mode: options?.mode ?? 0o755 })
      }),
    chmod: (path, mode) =>
      Effect.suspend(() => {
        const entry = entries.get(path)
        if (entry === undefined) return Effect.fail(failure("NotFound", "chmod", path))
        entries.set(path, { ...entry, mode })
        return Effect.void
      }),
    writeFileString: (path, content, options) =>
      Effect.sync(() => {
        entries.set(path, { directory: false, content, mode: entries.get(path)?.mode ?? options?.mode ?? 0o644 })
      }),
    readFileString: (path) =>
      Effect.suspend(() => {
        const content = entries.get(path)?.content
        return content === undefined ? Effect.fail(failure("NotFound", "readFileString", path)) : Effect.succeed(content)
      }),
    readDirectory: (path) =>
      Effect.suspend(() =>
        entries.get(path)?.directory === true
          ? Effect.succeed(children(path))
          : Effect.fail(failure("NotFound", "readDirectory", path))
      ),
    link: (from, to) =>
      Effect.suspend(() => {
        const entry = entries.get(from)
        if (entry === undefined) return Effect.fail(failure("NotFound", "link", from))
        if (entries.has(to)) return Effect.fail(failure("AlreadyExists", "link", to))
        entries.set(to, entry)
        return Effect.void
      }),
    rename: (from, to) =>
      Effect.suspend(() => {
        const entry = entries.get(from)
        if (entry === undefined) return Effect.fail(failure("NotFound", "rename", from))
        entries.delete(from)
        entries.set(to, entry)
        return Effect.void
      }),
    remove: (path) => Effect.sync(() => void entries.delete(path))
  })
  return { entries, layer: Layer.merge(layer, Path.layer) }
}

export const makeFakeConfig = (overrides: Partial<AlexaConfig["Service"]> = {}) =>
  Layer.succeed(
    AlexaConfig,
    AlexaConfig.of({
    stateDir: STATE_DIR,
    amazonPage: "amazon.com.br",
    locale: "pt-BR",
    alexaHost: Option.none(),
    speechEnabled: true,
    defaultDevice: Option.some("ECHO-1"),
    // Only the real Alexa takes this lock; under the in-memory state dir it never touches the host.
    speakLock: `${STATE_DIR}/alexa-speak.lock`,
    ...overrides
  })
)

export const FakeConfig = makeFakeConfig()

/**
 * A fake Alexa that records what it was asked to say; nothing reaches Amazon.
 */
export const makeFakeAlexa = (options: { readonly fail?: boolean } = {}) => {
  const spoken: Array<{ readonly text: string; readonly deviceSerial?: string | undefined }> = []
  const layer = Layer.succeed(
    Alexa,
    Alexa.of({
      devices: Effect.succeed([]),
      speak: (input) =>
        Effect.suspend(() => {
          spoken.push(input)
          return options.fail === true
            ? Effect.fail(new SpeechError({ message: "Speech request failed." }))
            : Effect.succeed({ status: "accepted", device: "ECHO-1", chunks: 1, playbackConfirmed: false } as const)
        })
    })
  )
  return { spoken, layer }
}

/**
 * A fake Mac voice that records what it was asked to say; nothing is spawned and no sound plays.
 */
export const makeFakeMacVoice = (options: { readonly fail?: boolean } = {}) => {
  const spoken: Array<string> = []
  const layer = Layer.succeed(
    MacVoice,
    MacVoice.of({
      speak: (text) =>
        Effect.suspend(() => {
          spoken.push(text)
          return options.fail === true
            ? Effect.fail(new MacVoiceError({ message: "say failed with exit code 1." }))
            : Effect.succeed({ status: "accepted", device: "Mac", chunks: 1, playbackConfirmed: true } as const)
        })
    })
  )
  return { spoken, layer }
}

/**
 * The real `Speaker` router over fake outputs. Also provides the fakes it was given.
 */
export const fakeSpeaker = (
  output: SpeechOutput,
  alexa: Layer.Layer<Alexa>,
  mac: Layer.Layer<MacVoice>,
  config: Layer.Layer<AlexaConfig> = FakeConfig
) => Speaker.layerWith(output).pipe(Layer.provideMerge(Layer.mergeAll(alexa, mac, config)))

/**
 * Everything the callback tools need, faked, with one pending task in the outbox.
 * Notices go to the fake Echo unless `output` is "mac".
 */
export const makeCallbackServices = (
  options: { readonly failSpeech?: boolean; readonly output?: SpeechOutput; readonly speechEnabled?: boolean } = {}
) => {
  const fs = makeMemoryFileSystem()
  const alexa = makeFakeAlexa({ fail: options.failSpeech ?? false })
  const mac = makeFakeMacVoice({ fail: options.failSpeech ?? false })
  const config = options.speechEnabled === false ? makeFakeConfig({ speechEnabled: false }) : FakeConfig
  const speaker = fakeSpeaker(options.output ?? "echo", alexa.layer, mac.layer, config)
  const services = Layer.mergeAll(GrokBotOutbox.layerAt(STATE_DIR), speaker).pipe(
    Layer.provideMerge(fs.layer)
  )
  const markPending = (sentAt = 0) =>
    GrokBotOutbox.use((outbox) => outbox.markPending({ requestId: PENDING_ID, taskHash: "hash", sentAt })).pipe(
      Effect.provide(services)
    )
  return { fs, alexa, mac, services, markPending }
}
