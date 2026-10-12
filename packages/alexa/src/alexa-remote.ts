import AlexaRemote from "alexa-remote2"
import { Effect } from "effect"
import { SessionError } from "./alexa-error.ts"
import { decodeSession, type Session } from "./session.ts"

export const USER_AGENT = "AI-Voice/0.3.0"

export interface RemoteOptions {
  readonly amazonPage: string
  readonly baseAmazonPage: string
  readonly acceptLanguage: string
  readonly apiUserAgentPostfix: string
  readonly setupProxy: false
  macDms?: unknown
  readonly [key: string]: unknown
}

export interface SequenceNode {
  readonly operationPayload: { readonly [key: string]: unknown }
  readonly [key: string]: unknown
}

// The subset of alexa-remote2 this package relies on: cookie state, token renewal and
// sequence nodes. Its HTTP transport is not used (see alexa-api.ts).
export interface AlexaRemoteClient {
  _options: RemoteOptions
  baseUrl: string
  readonly cookie?: string | null | undefined
  readonly csrf?: string | undefined
  readonly macDms?: unknown
  readonly serialNumbers: Record<string, unknown>
  setCookie(session: Session): void
  refreshCookie(callback: (error: Error | null | undefined, result?: unknown) => void): void
  createSequenceNode(command: "speak", text: string, serialNumber: string): SequenceNode
  stop(): void
}

// The bundled typings do not describe the internal _options field set here.
export const makeAlexaRemote = (): AlexaRemoteClient => new AlexaRemote() as unknown as AlexaRemoteClient

export const relogin = (message: string) =>
  new SessionError({
    message: `${message} Run jarvis-voice login (bun apps/mcp/src/main.ts login) on the machine that hosts Jarvis.`
  })

export const invalidSession = () => relogin("Amazon session is invalid.")

export const refreshSession = (remote: AlexaRemoteClient) =>
  Effect.callback<unknown, unknown>((resume) =>
    remote.refreshCookie((error, result) => resume(error ? Effect.fail(error) : Effect.succeed(result)))
  ).pipe(
    Effect.flatMap(decodeSession),
    Effect.mapError(() => relogin("Amazon session expired and could not be renewed."))
  )
