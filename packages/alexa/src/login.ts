/// <reference path="./alexa-cookie2.d.ts" />
import AlexaCookie from "alexa-cookie2"
import { Console, Effect, FileSystem, Option, Path, Queue, Stream } from "effect"
import { AlexaConfig } from "./alexa-config.ts"
import { SessionError } from "./alexa-error.ts"
import { decodeSession, loadSession, prepareStateDir, saveSession } from "./session.ts"

const PROXY_HOST = "127.0.0.1"
const PROXY_PORT = 3456

type LoginEvent =
  | { readonly _tag: "ProxyReady" }
  | { readonly _tag: "Completed"; readonly error: Error | null | undefined; readonly result: unknown }

const loginFailed = () =>
  new SessionError({
    message: "Amazon login failed. Try again; never paste your password, MFA code or cookies into a chat."
  })

// The proxy lives only as long as the stream: completion, failure, timeout and
// interruption (Ctrl+C) all stop it.
const loginEvents = (options: { readonly [key: string]: unknown }) =>
  Stream.callback<LoginEvent>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        AlexaCookie.generateAlexaCookie(undefined, undefined, options, (error, result) => {
          Queue.offerUnsafe(
            queue,
            error?.message.includes("Please open http://")
              ? { _tag: "ProxyReady" }
              : { _tag: "Completed", error, result }
          )
        })
      ),
      () => Effect.sync(() => AlexaCookie.stopProxyServer())
    )
  )

export const login: Effect.Effect<void, SessionError, AlexaConfig | FileSystem.FileSystem | Path.Path> = Effect.gen(
  function*() {
    const config = yield* AlexaConfig
    const path = yield* Path.Path
    yield* prepareStateDir(config.stateDir).pipe(
      Effect.mapError(() => new SessionError({ message: "Could not prepare the local session directory." }))
    )
    // Reusing the previous registration avoids registering another virtual device.
    const formerRegistrationData = Option.getOrUndefined(yield* Effect.option(loadSession(config.stateDir)))
    const completed = yield* loginEvents({
      amazonPage: config.amazonPage,
      baseAmazonPage: "amazon.com",
      acceptLanguage: config.locale,
      amazonPageProxyLanguage: config.locale.replace("-", "_"),
      setupProxy: true,
      proxyOnly: true,
      proxyOwnIp: PROXY_HOST,
      // The library binds to 0.0.0.0 by default, which would publish the login page on the LAN.
      proxyListenBind: PROXY_HOST,
      proxyPort: PROXY_PORT,
      formerDataStorePath: path.join(config.stateDir, "registration.json"),
      formerRegistrationData
    }).pipe(
      Stream.tap((event) =>
        event._tag === "ProxyReady"
          ? Console.error(
            `Open http://${PROXY_HOST}:${PROXY_PORT}/ in a browser on this machine and sign in to Amazon (including MFA). No audio will be played.`
          )
          : Effect.void
      ),
      Stream.filter((event) => event._tag === "Completed"),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: "10 minutes",
        orElse: () => Effect.fail(new SessionError({ message: "Login timed out after 10 minutes." }))
      })
    )
    if (Option.isNone(completed) || completed.value.error) return yield* loginFailed()
    const session = yield* Effect.mapError(decodeSession(completed.value.result), loginFailed)
    yield* saveSession(config.stateDir, session)
  }
).pipe(Effect.withSpan("login"))
