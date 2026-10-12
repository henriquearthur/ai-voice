import { Clock, Effect, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { DeviceError, SessionError } from "./alexa-error.ts"
import { type AlexaRemoteClient, invalidSession } from "./alexa-remote.ts"

// Same identity alexa-remote2 presents to the Alexa web API.
const API_USER_AGENT =
  "AppleWebKit PitanguiBridge/2.2.595606.0-[HARDWARE=iPhone14_7][SOFTWARE=17.4.1][DEVICE=iPhone]"

export interface AlexaTarget {
  readonly baseUrl: string
  readonly amazonPage: string
  readonly cookie: string
  readonly csrf: string
  readonly locale: string
  readonly userAgentPostfix: string
}

export const targetOf = (remote: AlexaRemoteClient) =>
  remote.cookie && remote.csrf
    ? Effect.succeed<AlexaTarget>({
      baseUrl: remote.baseUrl,
      amazonPage: remote._options.amazonPage,
      cookie: remote.cookie,
      csrf: remote.csrf,
      locale: remote._options.acceptLanguage,
      userAgentPostfix: remote._options.apiUserAgentPostfix
    })
    : Effect.fail(invalidSession())

export const EchoDevice = Schema.StructWithRest(
  Schema.Struct({
    deviceFamily: Schema.Literal("ECHO"),
    serialNumber: Schema.String,
    accountName: Schema.String,
    online: Schema.Boolean
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)
export type EchoDevice = typeof EchoDevice.Type

const isEchoDevice = Schema.is(EchoDevice)

const DevicesResponse = Schema.fromJsonString(Schema.Struct({ devices: Schema.Array(Schema.Unknown) }))

const EndpointsResponse = Schema.fromJsonString(Schema.Struct({ websiteApiUrl: Schema.URLFromString }))

interface ApiResponse {
  readonly status: number
  readonly body: string
}

// alexa-remote2's own transport reports "Connection Closed" on Bun, whose ClientRequest emits
// 'close' before the response 'end'. Reads go through HttpClient instead, without retries and
// without following redirects to the login page.
const get = (client: HttpClient.HttpClient, target: AlexaTarget, path: string) =>
  HttpClientRequest.get(`https://${target.baseUrl}${path}`).pipe(
    HttpClientRequest.setHeaders({
      "User-Agent": `${API_USER_AGENT} ${target.userAgentPostfix}`,
      Accept: "application/json; charset=utf-8",
      "Accept-Language": target.locale,
      Referer: `https://alexa.${target.amazonPage}/spa/index.html`,
      Origin: `https://alexa.${target.amazonPage}`,
      csrf: target.csrf,
      Cookie: target.cookie
    }),
    client.execute,
    Effect.flatMap((response) => Effect.map(response.text, (body): ApiResponse => ({ status: response.status, body }))),
    Effect.timeout("30 seconds"),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provideService(HttpClient.TracerPropagationEnabled, false)
  )

const isOk = (status: number) => status >= 200 && status < 300

const okBody = ({ status, body }: ApiResponse) => isOk(status) ? Effect.succeed(body) : Effect.fail(status)

export const checkAuthentication = (client: HttpClient.HttpClient, target: AlexaTarget) =>
  get(client, target, "/api/customer-status").pipe(
    Effect.mapError(() =>
      new SessionError({ message: "Could not connect to Alexa. Check the connection and try again." })
    ),
    Effect.flatMap(({ status }) =>
      isOk(status)
        ? Effect.succeed(true)
        : status === 401 || status === 403 || (status >= 300 && status < 400)
        ? Effect.succeed(false)
        : Effect.fail(new SessionError({ message: "Could not connect to Alexa. Check the connection and try again." }))
    )
  )

export const websiteApiHost = (client: HttpClient.HttpClient, target: AlexaTarget) =>
  get(client, target, "/api/endpoints").pipe(
    Effect.flatMap(okBody),
    Effect.flatMap(Schema.decodeUnknownEffect(EndpointsResponse)),
    Effect.map(({ websiteApiUrl }) => websiteApiUrl.hostname),
    Effect.option
  )

export const echoDevices = (client: HttpClient.HttpClient, target: AlexaTarget) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => get(client, target, `/api/devices-v2/device?cached=true&_=${now}`)),
    Effect.flatMap(okBody),
    Effect.flatMap(Schema.decodeUnknownEffect(DevicesResponse)),
    Effect.mapError(() =>
      new DeviceError({ message: "Could not list Alexa devices. The next call will check the session again." })
    ),
    // Apps, groups and other families are excluded: one physical Echo per call.
    Effect.map(({ devices }) => devices.filter(isEchoDevice))
  )
