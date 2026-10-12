import {
  Clock,
  Context,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Scope,
  Semaphore,
  SynchronizedRef
} from "effect"
import { observe } from "@jarvis/telemetry"
import { HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { AlexaConfig } from "./alexa-config.ts"
import { DeviceError, SessionError, SpeechError, speechDisabled } from "./alexa-error.ts"
import { checkAuthentication, echoDevices, type EchoDevice, targetOf, websiteApiHost } from "./alexa-api.ts"
import { type AlexaRemoteClient, invalidSession, makeAlexaRemote, refreshSession, USER_AGENT } from "./alexa-remote.ts"
import { makeSendSpeech } from "./send-speech.ts"
import { loadSession, saveSession } from "./session.ts"
import { withSpeakLock } from "./speak-lock.ts"
import { type Echo, MAX_TEXT_LENGTH, type SpeechAccepted, SpeechText, speechSequence, splitSpeech } from "./speech.ts"

const AUTH_CHECK_INTERVAL = 30 * 60 * 1000
const TOKEN_REFRESH_INTERVAL = 24 * 60 * 60 * 1000

export interface AlexaOptions {
  readonly makeRemote: () => AlexaRemoteClient
}

interface Connection {
  readonly remote: AlexaRemoteClient
  readonly scope: Scope.Closeable
  readonly connectedAt: number
}

const make = Effect.fnUntraced(function*(options: AlexaOptions) {
  const config = yield* AlexaConfig
  const client = yield* HttpClient.HttpClient
  const sendSpeech = makeSendSpeech(client)
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
  const layerScope = yield* Scope.Scope
  const connection = yield* SynchronizedRef.make(Option.none<Connection>())
  const speaking = yield* Semaphore.make(1)

  const closeConnection = (current: Option.Option<Connection>) =>
    Option.match(current, { onNone: () => Effect.void, onSome: ({ scope }) => Scope.close(scope, Exit.void) })

  const initialize = Effect.gen(function*() {
    const session = yield* loadSession(config.stateDir)
    const remote = yield* Effect.acquireRelease(
      Effect.sync(options.makeRemote),
      (remote) => Effect.sync(() => remote.stop())
    )
    // Authentication and endpoint discovery only. init() can retry login recursively and
    // queries resources this package does not use.
    remote._options = {
      amazonPage: session.amazonPage || config.amazonPage,
      baseAmazonPage: "amazon.com",
      acceptLanguage: config.locale,
      apiUserAgentPostfix: USER_AGENT,
      setupProxy: false
      // No logger: the library logs cookies and tokens in debug mode.
    }
    remote.baseUrl = Option.getOrElse(config.alexaHost, () => `alexa.${remote._options.amazonPage}`)
    remote.setCookie(session)

    const refresh = Effect.gen(function*() {
      const renewed = yield* refreshSession(remote)
      // setCookie keeps the previous macDms; replace it with the renewed one.
      remote._options.macDms = renewed.macDms
      remote.setCookie(renewed)
      yield* saveSession(config.stateDir, renewed)
    })

    const now = yield* Clock.currentTimeMillis
    const stale = session.tokenDate === undefined || now - session.tokenDate >= TOKEN_REFRESH_INTERVAL
    if (stale) yield* refresh
    const authenticated = Effect.flatMap(targetOf(remote), (target) => checkAuthentication(client, target))
    if (!(yield* authenticated)) {
      if (stale) return yield* invalidSession()
      yield* refresh
      if (!(yield* authenticated)) return yield* invalidSession()
    }
    const host = yield* Effect.flatMap(targetOf(remote), (target) => websiteApiHost(client, target))
    if (Option.isSome(host)) remote.baseUrl = host.value
    return remote
  })

  // Reuses the authenticated remote for 30 minutes, then checks the session again.
  // Concurrent callers wait for a single initialization.
  const connect: Effect.Effect<AlexaRemoteClient, SessionError> = SynchronizedRef.modifyEffect(
    connection,
    (current): Effect.Effect<readonly [Exit.Exit<AlexaRemoteClient, SessionError>, Option.Option<Connection>]> =>
      Effect.gen(function*() {
        const now = yield* Clock.currentTimeMillis
        if (Option.isSome(current) && now - current.value.connectedAt < AUTH_CHECK_INTERVAL) {
          return [Exit.succeed(current.value.remote), current]
        }
        yield* closeConnection(current)
        const scope = yield* Scope.fork(layerScope)
        const exit = yield* initialize.pipe(
          Scope.provide(scope),
          Effect.provideContext(context),
          Effect.onExit((exit) => Exit.isSuccess(exit) ? Effect.void : Scope.close(scope, exit)),
          Effect.exit
        )
        if (Exit.isFailure(exit)) return [exit, Option.none()]
        const connectedAt = yield* Clock.currentTimeMillis
        return [exit, Option.some({ remote: exit.value, scope, connectedAt })]
      })
  ).pipe(Effect.flatten)

  const disconnect = SynchronizedRef.modifyEffect(
    connection,
    (current) => Effect.as(closeConnection(current), [undefined, Option.none<Connection>()] as const)
  )

  const listEchoes = Effect.gen(function*() {
    const remote = yield* connect
    const target = yield* targetOf(remote)
    const echoes = yield* echoDevices(client, target).pipe(Effect.tapError(() => disconnect))
    return { remote, target, echoes }
  })

  const toEcho = (device: EchoDevice): Echo => ({
    name: device.accountName,
    serial: device.serialNumber,
    online: device.online,
    isDefault: Option.contains(config.defaultDevice, device.serialNumber)
  })

  const devices: Effect.Effect<ReadonlyArray<Echo>, SessionError | DeviceError> = listEchoes.pipe(
    Effect.map(({ echoes }) => echoes.map(toEcho)),
    Effect.withSpan("Alexa.devices")
  )

  const deliver = Effect.fnUntraced(function*(serial: string, chunks: ReadonlyArray<string>) {
    const { echoes, remote, target } = yield* listEchoes
    const device = echoes.find((echo) => echo.serialNumber === serial)
    if (device === undefined) {
      return yield* new DeviceError({ message: "Echo not found. Use a serial returned by list_devices." })
    }
    if (!device.online) return yield* new DeviceError({ message: "Echo is offline." })
    const sequence = speechSequence(remote, device, chunks, config.locale)
    // Other programs on this Mac speak through the same lock file: wait for them, never overlap.
    yield* withSpeakLock(spawner, config.speakLock, chunks.length, sendSpeech(target, sequence))
    return {
      status: "accepted",
      device: device.accountName,
      chunks: chunks.length,
      playbackConfirmed: false
    } satisfies SpeechAccepted
  })

  const speak = Effect.fn("Alexa.speak")(
    function*(input: { readonly text: string; readonly deviceSerial?: string | undefined }) {
      if (!config.speechEnabled) {
        return yield* speechDisabled()
      }
      const serial = Option.filter(
        input.deviceSerial ? Option.some(input.deviceSerial) : config.defaultDevice,
        (serial) => serial.trim() !== ""
      )
      if (Option.isNone(serial)) {
        return yield* new DeviceError({ message: "Provide device_serial or set AI_VOICE_DEFAULT_DEVICE." })
      }
      const text = yield* Schema.decodeUnknownEffect(SpeechText)(input.text).pipe(
        Effect.mapError(() =>
          new SpeechError({ message: `Use plain text between 1 and ${MAX_TEXT_LENGTH} characters, without SSML.` })
        )
      )
      const accepted = yield* deliver(serial.value, splitSpeech(text)).pipe(Semaphore.withPermitsIfAvailable(speaking, 1))
      if (Option.isNone(accepted)) {
        return yield* new SpeechError({
          message: "A speech request is already in progress on this server. Wait for it to finish."
        })
      }
      return accepted.value
    }
  )

  return {
    devices: devices.pipe(observe("alexa.dispositivos")),
    speak: (input: Parameters<typeof speak>[0]) => speak(input).pipe(observe("alexa.fala"))
  }
})

export class Alexa extends Context.Service<Alexa, {
  readonly devices: Effect.Effect<ReadonlyArray<Echo>, SessionError | DeviceError>
  readonly speak: (input: {
    readonly text: string
    readonly deviceSerial?: string | undefined
  }) => Effect.Effect<SpeechAccepted, SessionError | DeviceError | SpeechError>
}>()("@jarvis/alexa/Alexa", { make }) {
  static readonly layerWith = (options: AlexaOptions) => Layer.effect(Alexa, Alexa.make(options))

  static readonly layer: Layer.Layer<
    Alexa,
    never,
    | AlexaConfig
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | ChildProcessSpawner.ChildProcessSpawner
  > = Layer.effect(Alexa, Alexa.make({ makeRemote: makeAlexaRemote }))
}
