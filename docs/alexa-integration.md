# How the Alexa integration works

Why AI Voice talks to Alexa the way it does, what that implies for your Amazon account, and where its limits are. For settings and commands, see the [configuration reference](configuration.md).

## An unofficial path

Amazon offers no public API to make an Echo say arbitrary text on demand. AI Voice uses the internal interfaces of the Alexa app through the community libraries [`alexa-remote2`](https://github.com/Apollon77/alexa-remote) and [`alexa-cookie2`](https://github.com/Apollon77/alexa-cookie). The versions examined are `alexa-remote2@8.1.1` and `alexa-cookie2@5.0.6`; the source links below are pinned to those commits.

Consequences:

- Amazon gives no stability contract. A change on their side can break login, device listing or speech without notice.
- Using private APIs may be against Amazon's terms of use. You use AI Voice with your own account at your own risk.
- There is no published quota for these endpoints. AI Voice sends one request per `speak` and never retries.

## What was validated

Confirmed with real audio by the maintainer:

- Marketplace `amazon.com.br`, locale `pt-BR`, one Echo Dot.
- Login through the local proxy, device listing, a short utterance, and a two-chunk utterance heard in order.
- Token renewal through `refreshCookie`, without audio.

Not validated: other marketplaces and locales, other Echo models, behaviour under Do Not Disturb, and backend rate limits. The code paths are the same, but treat them as unconfirmed until someone reports them working.

## Login and session

Login uses the manual proxy flow of `alexa-cookie2`, which supports MFA and CAPTCHA because you sign in on Amazon's real pages through a local proxy. The flow registers a virtual app/device on the account and keeps tokens that renew the cookies. ([flow and persistence](https://github.com/Apollon77/alexa-cookie/blob/260be379d9af47525efc8509c731014848f00221/README.md#usage))

AI Voice hardens that flow:

- The proxy binds to `127.0.0.1` only. The library's default bind is `0.0.0.0`, which would publish the login page on your LAN. ([configuration and bind](https://github.com/Apollon77/alexa-cookie/blob/260be379d9af47525efc8509c731014848f00221/alexa-cookie.js#L198))
- The proxy exists only while the `login` command runs. The MCP server never opens it.
- The complete object returned by login is persisted, with `localCookie`, `refreshToken`, `macDms` and registration data. Saving only the cookie string would lose what renewal needs and could create repeated device registrations.
- The session lives outside the repository, in a `0700` directory with a `0600` file.
- No logger is passed to the libraries, because their debug output includes cookies and tokens.

The server does not call the library's `init()`. It only checks authentication and discovers the endpoint, since `init()` can retry login recursively and queries resources AI Voice does not use.

## Marketplace, host and locale

Three separate settings decide where requests go and how text is spoken:

- **Marketplace** (`AI_VOICE_AMAZON_PAGE`) selects the Amazon login. During login the library also reads `marketPlaceDomainName` from the account profile and stores the result in the session, which then takes precedence. ([profile marketplace](https://github.com/Apollon77/alexa-cookie/blob/260be379d9af47525efc8509c731014848f00221/alexa-cookie.js#L590))
- **Host** starts as `alexa.<marketplace>`, or `AI_VOICE_ALEXA_HOST` when set. After authentication, `/api/endpoints` may return `websiteApiUrl`, which replaces it. Do not assume hosts of different marketplaces are interchangeable. If the derived host does not work for your account, the `alexa-remote2` documentation lists known hosts such as `pitangui.amazon.com` for the United States. ([initialization and endpoint discovery](https://github.com/Apollon77/alexa-remote/blob/f97a934c2d98508c4c9e2823930adaf35c710ee7/alexa-remote.js#L189))
- **Locale** (`AI_VOICE_LOCALE`) is written into every speech node.

The library's own `speak` path would replace the locale with `de-DE` and, on marketplaces not ending in `.com`, turn decimal points into commas. AI Voice builds the node with `createSequenceNode('speak', …)`, then sets `operationPayload.locale` and restores the original `operationPayload.textToSpeak`, so your text reaches Alexa unchanged. ([sequence construction](https://github.com/Apollon77/alexa-remote/blob/f97a934c2d98508c4c9e2823930adaf35c710ee7/alexa-remote.js#L2606))

## Devices and speech

`list_devices` reads `/api/devices-v2/device` and keeps only the `ECHO` device family: one physical Echo per call, selected by serial so that names cannot be ambiguous. A device appearing in the list does not prove it supports speech. ([endpoint](https://github.com/Apollon77/alexa-remote/blob/f97a934c2d98508c4c9e2823930adaf35c710ee7/alexa-remote.js#L1460))

`speak` uses the `Alexa.Speak` operation, which accepts at most 250 UTF-16 code units per node. AI Voice splits longer text into several nodes inside one `SerialNode` and posts the sequence to `POST /api/behaviors/preview`. ([limits and operations](https://github.com/Apollon77/alexa-remote/blob/f97a934c2d98508c4c9e2823930adaf35c710ee7/alexa-remote.js#L2843))

`AlexaAnnouncement`, which targets several devices at once, is deliberately not used: it also hardcodes `de-DE` and would add broadcast behaviour this project does not want.

## Failure handling

The speech request is sent with Node's `https.request` instead of the library's transport. The library retries some `503` and throttling responses once, and its generic handler does not inspect the HTTP status, so an error body can arrive without an error. ([response handling](https://github.com/Apollon77/alexa-remote/blob/f97a934c2d98508c4c9e2823930adaf35c710ee7/alexa-remote.js#L1230))

AI Voice therefore:

- sends exactly once, with a 10 second timeout;
- rejects any non-2xx status and any JSON body that looks like an error;
- reports generic error messages, never echoing response bodies that could contain credentials;
- allows one `speak` at a time per server.

A positive response means "accepted by the API". It is never proof of audible playback.

## Safety defaults

- Speech is refused unless `AI_VOICE_ENABLE_SPEECH=1`.
- Nothing is spoken at startup, during login or while listing devices.
- There is no automatic target: without a serial or a default Echo, `speak` fails.
- No broadcast, volume change, routine or arbitrary Alexa text command is exposed.
- The HTTP mode has no authentication and is meant for private networks only. See [Serve AI Voice over the network](network.md).

## Known dependency advisory

`npm audit` reports five high-severity packages through one transitive chain: `braces@3.0.3`, pulled in by the proxy middleware of `alexa-cookie2`. The advisory describes a denial of service through deeply nested patterns and lists no fixed version. ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm))

The affected code runs only in the login proxy, which is bound to loopback and alive only during the `login` command. That reduces exposure; it does not fix the dependency. Separately, `package.json` overrides `cookie` to `0.7.2` to resolve a low-severity advisory.
