import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Duration, Effect, Exit, Fiber, FileSystem, Layer, Path, Sink, Stream } from "effect"
import { PlatformError, SystemError } from "effect/PlatformError"
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"
import { AFPLAY, CANCEL_GUARD, LAUNCHCTL, LOCKF, MacVoice, MacVoiceConfig, QUEUE_TIMEOUT, SAY, speechTimeout, SYNTHESIS_TIMEOUT } from "../src/index.ts"

interface Reply {
  readonly exitCode?: number
  readonly hang?: boolean
  readonly spawnFails?: boolean
  /** How the fake TTS server answers. Defaults to "down", so these tests take the `say` path. */
  readonly tts?: "down" | "hang" | "wav" | "http500" | "notWav"
  /** Exit code of `launchctl print` (0 = agent loaded). Other launchctl calls exit 0. */
  readonly launchctlPrint?: number
  /** The server comes up after this many launchctl start calls (kickstart/bootstrap): "wav" from then on. */
  readonly upAfterStart?: boolean
  /** Seconds after the start call at which /health begins to answer (default 1). */
  readonly healthyAfterS?: number
  readonly plistExists?: boolean
  readonly recovery?: boolean
  /** Content of the cancel marker when the speech enters the queue (default: file absent). */
  readonly cancelMarker?: string
}

const LOCK = "/state/jarvis/fala.lock"
const CANCEL = "/state/jarvis/fala.cancel"
/** The lockf argv: the cancel guard runs under the lock and then execs the player. */
const lockedArgs = (entry: string, ...player: ReadonlyArray<string>) =>
  ["-k", "-t", "120", LOCK, "/bin/sh", "-c", CANCEL_GUARD, "sh", CANCEL, entry, ...player]
const TTS_URL = "http://127.0.0.1:7349"
const PLIST = "/home/Library/LaunchAgents/dev.jarvis.tts.plist"
const FALA_LOG = "/state/jarvis/tts/logs/fala.log"
const WAV_FILE = "/tmp/jarvis-tts-1.wav"
const WAV = new Uint8Array([...new TextEncoder().encode("RIFF"), ...new Array(60).fill(0)])

// Never spawns anything: records each command and answers with a canned exit code.
const fakeSpawner = (reply: Reply = {}) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const directories: Array<string> = []
  const state = { released: 0, started: 0, healthSeen: 0 }
  const log: Array<string> = []
  const spawner = ChildProcessSpawner.make((command) =>
    reply.spawnFails === true
      ? Effect.fail(new PlatformError(new SystemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" })))
      : Effect.acquireRelease(
        Effect.sync(() => {
          if (!ChildProcess.isStandardCommand(command)) throw new Error("unexpected piped command")
          commands.push(command)
          const isLaunchctl = command.command === "/bin/launchctl"
          if (isLaunchctl && (command.args[0] === "kickstart" || command.args[0] === "bootstrap")) {
            state.started++
          }
          const launchctlCode = isLaunchctl && command.args[0] === "print" ? (reply.launchctlPrint ?? 0) : 0
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: reply.hang === true
              ? Effect.never
              : Effect.succeed(ChildProcessSpawner.ExitCode(isLaunchctl ? launchctlCode : reply.exitCode ?? 0)),
            isRunning: Effect.succeed(reply.hang === true),
            kill: () => Effect.void,
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void)
          })
        }),
        () => Effect.sync(() => void state.released++)
      )
  )
  // The fake TTS server: never reaches the network.
  const requests: Array<{ readonly url: string; readonly body: unknown }> = []
  const client = HttpClient.make((request, url) =>
    Effect.gen(function*() {
      const body = request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : null
      requests.push({ url: url.toString(), body })
      const up = reply.upAfterStart === true && state.started > 0 && state.healthSeen >= (reply.healthyAfterS ?? 1)
      if (url.pathname === "/health") {
        if (state.started > 0) state.healthSeen++
        if (!up && (reply.tts === "http500" || reply.tts === "notWav")) {
          return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))
        }
      }
      switch (up ? "wav" : (reply.tts ?? "down")) {
        case "down":
          return yield* Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, description: "connection refused" })
            })
          )
        case "hang":
          return yield* Effect.never
        case "http500":
          return HttpClientResponse.fromWeb(request, new Response("boom", { status: 500 }))
        case "notWav":
          return HttpClientResponse.fromWeb(request, new Response("{}", { status: 200 }))
        case "wav":
          return HttpClientResponse.fromWeb(request, new Response(WAV, { status: 200 }))
      }
    })
  )
  const written: Array<{ readonly path: string; readonly bytes: Uint8Array }> = []
  const removed: Array<string> = []
  const fs = FileSystem.layerNoop({
    readFileString: (path) =>
      path === CANCEL && reply.cancelMarker !== undefined
        ? Effect.succeed(`${reply.cancelMarker}\n`)
        : Effect.fail(new PlatformError(new SystemError({ _tag: "NotFound", module: "FileSystem", method: "readFileString" }))),
    exists: () => Effect.succeed(reply.plistExists ?? true),
    writeFileString: (path, data) => Effect.sync(() => void log.push(`${path}\n${data}`)),
    makeDirectory: (path) => Effect.sync(() => void directories.push(path)),
    makeTempFileScoped: () =>
      Effect.acquireRelease(Effect.succeed(WAV_FILE), (path) => Effect.sync(() => void removed.push(path))),
    writeFile: (path, bytes) => Effect.sync(() => void written.push({ path, bytes }))
  })
  const layer = MacVoice.layer.pipe(
    Layer.provide(Layer.mergeAll(
      Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Layer.succeed(
        MacVoiceConfig,
        MacVoiceConfig.of({
          voice: "Luciana",
          lock: LOCK,
          ttsUrl: TTS_URL,
          ttsVoice: "pf_dora",
          ...(reply.recovery === true
            ? {
              ttsRecovery: { label: "dev.jarvis.tts", plist: PLIST, uid: 501, waitSeconds: 20 },
              falaLog: FALA_LOG
            }
            : {})
        })
      ),
      Layer.succeed(HttpClient.HttpClient, client),
      fs,
      Path.layer
    ))
  )
  return { commands, directories, log, layer, removed, requests, state, written }
}

const speak = (text: string) => MacVoice.use((voice) => voice.speak(text))

describe("MacVoice.speak through say", () => {
  it.effect("runs say under lockf with the exact argv, absolute paths and no shell", () => {
    const fake = fakeSpawner()
    return Effect.gen(function*() {
      const played = yield* speak("  -v Fred; rm -rf ~ `x` $(y)  ")
      assert.deepStrictEqual(played, { status: "accepted", device: "Mac", chunks: 1, playbackConfirmed: true })
      assert.strictEqual(fake.commands.length, 1)
      const [command] = fake.commands
      assert.strictEqual(command?.command, LOCKF)
      assert.strictEqual(LOCKF, "/usr/bin/lockf")
      assert.strictEqual(SAY, "/usr/bin/say")
      assert.deepStrictEqual(
        command?.args,
        lockedArgs("", "/usr/bin/say", "-v", "Luciana", "--", "-v Fred; rm -rf ~ `x` $(y)")
      )
      assert.isUndefined(command?.options.shell)
      assert.strictEqual(command?.options.stdin, "ignore")
      assert.deepStrictEqual(fake.directories, ["/state/jarvis"])
      assert.strictEqual(fake.state.released, 1)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("refuses invalid text without spawning", () => {
    const fake = fakeSpawner()
    return Effect.gen(function*() {
      for (const text of ["", "   ", "a".repeat(4001), "<speak>oi</speak>", "1 > 0"]) {
        const error = yield* Effect.flip(speak(text))
        assert.match(error.message, /^Use plain text between 1 and 4000 characters/)
      }
      assert.strictEqual(fake.commands.length, 0)
      yield* speak("a".repeat(4000))
      assert.strictEqual(fake.commands.length, 1)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("reports a failing say once, without retrying", () => {
    const fake = fakeSpawner({ exitCode: 1 })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(speak("Olá"))
      assert.strictEqual(error._tag, "MacVoiceError")
      assert.match(error.message, /^say failed with exit code 1/)
      assert.strictEqual(fake.commands.length, 1)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("reports a lock held past the queue timeout as busy", () => {
    const fake = fakeSpawner({ exitCode: 75 })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(speak("Olá"))
      assert.match(error.message, /^Mac ocupado: another program kept speaking for 2m\./)
      assert.strictEqual(fake.commands.length, 1)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("reports a spawn failure", () => {
    const fake = fakeSpawner({ spawnFails: true })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(speak("Olá"))
      assert.match(error.message, /^Could not run \/usr\/bin\/lockf/)
    }).pipe(Effect.provide(fake.layer))
  })

  it("budgets the queue wait plus playback proportional to the text", () => {
    assert.strictEqual(Duration.toSeconds(QUEUE_TIMEOUT), 120)
    // 120 s of queue + 60 s of margin + 250 ms per character.
    assert.strictEqual(Duration.toSeconds(speechTimeout("Olá")), 180.75)
    // A maximal speech of 4000 characters (about 5 minutes of audio) gets 20 minutes.
    assert.strictEqual(Duration.toSeconds(speechTimeout("a".repeat(4000))), 1180)
  })

  it.effect("does not cut a long speech after the old 90 seconds", () => {
    const fake = fakeSpawner({ hang: true })
    const text = "a".repeat(1500)
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(speak(text))
      yield* TestClock.adjust(Duration.seconds(540))
      assert.isUndefined(fiber.pollUnsafe())
      assert.strictEqual(fake.state.released, 0)
      yield* Fiber.interrupt(fiber)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("stops a stuck player only after the proportional budget", () => {
    const fake = fakeSpawner({ hang: true })
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(speak("Olá"))
      yield* TestClock.adjust(Duration.subtract(speechTimeout("Olá"), Duration.millis(1)))
      assert.isUndefined(fiber.pollUnsafe())
      yield* TestClock.adjust(Duration.millis(1))
      const exit = yield* Fiber.await(fiber)
      assert.isTrue(Exit.isFailure(exit))
      const error = yield* Effect.flip(Fiber.join(fiber))
      assert.match(error.message, /did not finish within 3m 750ms and was stopped/)
      // The process scope closed, so the spawner kills the process group.
      assert.strictEqual(fake.state.released, 1)
      assert.strictEqual(fake.commands.length, 1)
    }).pipe(Effect.provide(fake.layer))
  })
})

describe("MacVoice.speak through the TTS server", () => {
  it.effect("plays the synthesized WAV with afplay under the same lock", () => {
    const fake = fakeSpawner({ tts: "wav" })
    return Effect.gen(function*() {
      const played = yield* speak("  Olá, Fernando  ")
      assert.deepStrictEqual(played, { status: "accepted", device: "Mac", chunks: 1, playbackConfirmed: true })
      assert.deepStrictEqual(fake.requests, [
        { url: `${TTS_URL}/synthesize`, body: { text: "Olá, Fernando", voice: "pf_dora" } }
      ])
      assert.deepStrictEqual(fake.written, [{ path: WAV_FILE, bytes: WAV }])
      assert.strictEqual(fake.commands.length, 1)
      const [command] = fake.commands
      assert.strictEqual(command?.command, "/usr/bin/lockf")
      assert.strictEqual(AFPLAY, "/usr/bin/afplay")
      assert.deepStrictEqual(command?.args, lockedArgs("", "/usr/bin/afplay", WAV_FILE))
      assert.isUndefined(command?.options.shell)
      // The temporary WAV is removed once afplay exited.
      assert.deepStrictEqual(fake.removed, [WAV_FILE])
    }).pipe(Effect.provide(fake.layer))
  })

  for (const tts of ["down", "http500", "notWav"] as const) {
    it.effect(`falls back to say once when the server answers ${tts}`, () => {
      const fake = fakeSpawner({ tts })
      return Effect.gen(function*() {
        yield* speak("Olá")
        assert.strictEqual(fake.requests.length, 1)
        assert.strictEqual(fake.commands.length, 1)
        assert.deepStrictEqual(fake.commands[0]?.args, lockedArgs("", SAY, "-v", "Luciana", "--", "Olá"))
      }).pipe(Effect.provide(fake.layer))
    })
  }

  it.effect("falls back to say after 10 seconds without an answer", () => {
    const fake = fakeSpawner({ tts: "hang" })
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(speak("Olá"))
      yield* TestClock.adjust(Duration.subtract(SYNTHESIS_TIMEOUT, Duration.millis(1)))
      assert.strictEqual(fake.commands.length, 0)
      yield* TestClock.adjust(Duration.millis(1))
      yield* Fiber.join(fiber)
      assert.strictEqual(fake.requests.length, 1)
      assert.strictEqual(fake.commands[0]?.args[10], SAY)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("reports a failing afplay without falling back to say", () => {
    const fake = fakeSpawner({ tts: "wav", exitCode: 1 })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(speak("Olá"))
      assert.match(error.message, /^afplay failed with exit code 1/)
      assert.strictEqual(fake.commands.length, 1)
      assert.strictEqual(fake.commands[0]?.args[10], AFPLAY)
    }).pipe(Effect.provide(fake.layer))
  })
})

describe("MacVoice.speak recovering the TTS LaunchAgent", () => {
  const launchctlArgs = (fake: ReturnType<typeof fakeSpawner>) =>
    fake.commands.filter((c) => c.command === LAUNCHCTL).map((c) => c.args)

  it.effect("kickstarts a loaded agent, waits for /health and plays Kokoro", () => {
    const fake = fakeSpawner({ recovery: true, upAfterStart: true, healthyAfterS: 3 })
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(speak("Olá"))
      yield* TestClock.adjust(Duration.seconds(5))
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(launchctlArgs(fake), [
        ["print", "gui/501/dev.jarvis.tts"],
        ["kickstart", "gui/501/dev.jarvis.tts"]
      ])
      assert.strictEqual(fake.commands.at(-1)?.args[10], AFPLAY)
      assert.strictEqual(fake.log.length, 1)
      assert.match(fake.log[0]!, /^\/state\/jarvis\/tts\/logs\/fala\.log\n\S+Z pid=\d+ motor=kokoro chars=3 audio_s=0 rc=0 dur_s=\d+\n$/)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("bootstraps the plist when the agent is unloaded", () => {
    const fake = fakeSpawner({ recovery: true, upAfterStart: true, launchctlPrint: 113 })
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(speak("Olá"))
      yield* TestClock.adjust(Duration.seconds(3))
      yield* Fiber.join(fiber)
      assert.deepStrictEqual(launchctlArgs(fake), [
        ["print", "gui/501/dev.jarvis.tts"],
        ["bootstrap", "gui/501", PLIST]
      ])
      assert.strictEqual(fake.commands.at(-1)?.args[10], AFPLAY)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("falls back to say after waiting 20 seconds, logging the reason", () => {
    const fake = fakeSpawner({ recovery: true })
    return Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(speak("Olá"))
      yield* TestClock.adjust(Duration.seconds(19))
      assert.isUndefined(fiber.pollUnsafe())
      yield* TestClock.adjust(Duration.seconds(2))
      yield* Fiber.join(fiber)
      assert.strictEqual(fake.commands.at(-1)?.args[10], SAY)
      assert.match(fake.log[0]!, /motor=say chars=3 audio_s=\? rc=0 dur_s=\d+ motivo=tts_nao_subiu\n$/)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("goes straight to say when there is no plist and the agent is not loaded", () => {
    const fake = fakeSpawner({ recovery: true, launchctlPrint: 113, plistExists: false })
    return Effect.gen(function*() {
      yield* speak("Olá")
      assert.deepStrictEqual(launchctlArgs(fake), [["print", "gui/501/dev.jarvis.tts"]])
      assert.strictEqual(fake.commands.at(-1)?.args[10], SAY)
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("does not touch launchd when the server is up but synthesis fails", () => {
    const fake = fakeSpawner({ recovery: true, tts: "http500" })
    return Effect.gen(function*() {
      yield* speak("Olá")
      assert.deepStrictEqual(launchctlArgs(fake), [])
      assert.match(fake.log[0]!, /motor=say .* motivo=tts_falhou\n$/)
    }).pipe(Effect.provide(fake.layer))
  })
})

describe("MacVoice.speak queue cancellation (jarvis-cala)", () => {
  it.effect("hands the marker content seen at queue entry to the guard under the lock", () => {
    const fake = fakeSpawner({ tts: "wav", cancelMarker: "1760000000.42.1234" })
    return Effect.gen(function*() {
      yield* speak("Olá")
      assert.deepStrictEqual(fake.commands[0]?.args, lockedArgs("1760000000.42.1234", AFPLAY, WAV_FILE))
    }).pipe(Effect.provide(fake.layer))
  })

  it.effect("logs a speech cancelled while queued as descartada and does not report success", () => {
    const fake = fakeSpawner({ tts: "wav", exitCode: 76, recovery: true })
    return Effect.gen(function*() {
      const error = yield* Effect.flip(speak("Olá"))
      assert.match(error.message, /^Fala descartada: o Jarvis foi interrompido \(jarvis-cala\)/)
      assert.strictEqual(fake.log.length, 1)
      assert.match(fake.log[0]!, /motor=descartada chars=3 audio_s=0 rc=0 dur_s=\d+ motivo=interrompida\n$/)
      assert.deepStrictEqual(fake.removed, [WAV_FILE])
    }).pipe(Effect.provide(fake.layer))
  })

  for (const code of [70, 143]) {
    it.effect(`logs a speech killed by jarvis-cala while playing (exit ${code}) as rc=143`, () => {
      const fake = fakeSpawner({ tts: "wav", exitCode: code, recovery: true })
      return Effect.gen(function*() {
        const error = yield* Effect.flip(speak("Olá"))
        assert.match(error.message, /^Fala interrompida \(jarvis-cala\)/)
        assert.match(fake.log[0]!, /motor=kokoro chars=3 audio_s=0 rc=143 dur_s=\d+\n$/)
      }).pipe(Effect.provide(fake.layer))
    })
  }
})

describe("MacVoiceConfig", () => {
  const load = (env: Record<string, string>) =>
    Effect.gen(function*() {
      return yield* MacVoiceConfig
    }).pipe(
      Effect.provide(MacVoiceConfig.layer.pipe(
        Layer.provide(Layer.merge(Path.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))))
      ))
    )

  it.effect("defaults to Luciana and the jarvis-fala lock", () =>
    Effect.gen(function*() {
      const config = yield* load({ HOME: "/Users/test" })
      assert.deepStrictEqual(config, {
        voice: "Luciana",
        lock: "/Users/test/.local/share/jarvis/fala.lock",
        cancel: "/Users/test/.local/share/jarvis/fala.cancel",
        ttsUrl: "http://127.0.0.1:7349",
        ttsVoice: "pf_dora",
        ttsRecovery: {
          label: "dev.jarvis.tts",
          plist: "/Users/test/Library/LaunchAgents/dev.jarvis.tts.plist",
          uid: process.getuid?.() ?? 501,
          waitSeconds: 20
        },
        falaLog: "/Users/test/.local/share/jarvis/tts/logs/fala.log"
      })
    }))

  it.effect("JARVIS_FALA_LOCK wins over AI_VOICE_MAC_LOCK and JARVIS_FALA_CANCEL moves the marker", () =>
    Effect.gen(function*() {
      const config = yield* load({
        HOME: "/Users/test",
        JARVIS_FALA_LOCK: "/tmp/p/a.lock",
        AI_VOICE_MAC_LOCK: "/tmp/x/y.lock",
        JARVIS_FALA_CANCEL: "/tmp/p/marcador"
      })
      assert.strictEqual(config.lock, "/tmp/p/a.lock")
      assert.strictEqual(config.cancel, "/tmp/p/marcador")
    }))

  it.effect("reads AI_VOICE_MAC_VOICE, AI_VOICE_MAC_LOCK, AI_VOICE_TTS_URL and AI_VOICE_TTS_VOICE", () =>
    Effect.gen(function*() {
      const config = yield* load({
        HOME: "/Users/test",
        AI_VOICE_MAC_VOICE: "Felipe",
        AI_VOICE_MAC_LOCK: "/tmp/x/y.lock",
        AI_VOICE_TTS_URL: "http://127.0.0.1:9000/",
        AI_VOICE_TTS_VOICE: "pm_alex"
      })
      assert.deepStrictEqual(config, {
        voice: "Felipe",
        lock: "/tmp/x/y.lock",
        cancel: "/tmp/x/fala.cancel",
        ttsUrl: "http://127.0.0.1:9000",
        ttsVoice: "pm_alex",
        ttsRecovery: {
          label: "dev.jarvis.tts",
          plist: "/Users/test/Library/LaunchAgents/dev.jarvis.tts.plist",
          uid: process.getuid?.() ?? 501,
          waitSeconds: 20
        },
        falaLog: "/Users/test/.local/share/jarvis/tts/logs/fala.log"
      })
    }))
})
