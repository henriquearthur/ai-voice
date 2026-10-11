# Configuration reference

Exact settings, tool contracts and failure messages of AI Voice. To install and connect it for the first time, follow the [quick start](../README.md#quick-start).

## Environment variables

Set these in the MCP client configuration that launches the server, or in the service that hosts it. `npm run login` and `npm run devices` read the same variables from the shell.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_VOICE_ENABLE_SPEECH` | disabled | Only the value `1` enables `speak`. Without it, `speak` is refused and `list_devices` still works. |
| `AI_VOICE_DEFAULT_DEVICE` | none | Serial of the Echo used when `speak` is called without `device_serial`. |
| `AI_VOICE_LOCALE` | `en-US` | Locale the Echo speaks in, such as `pt-BR`, `de-DE` or `en-GB`. Also tells the agent which language to write in. |
| `AI_VOICE_AMAZON_PAGE` | `amazon.com` | Amazon marketplace used for login, such as `amazon.co.uk` or `amazon.com.br`. After login the session keeps the marketplace Amazon returned, and that value wins. |
| `AI_VOICE_ALEXA_HOST` | `alexa.<marketplace>` | Optional initial Alexa API host, without `https://`. Amazon's endpoint discovery may replace it after authentication. |
| `AI_VOICE_STATE_DIR` | `~/.local/share/ai-voice` | Directory holding the Amazon session. Use the same value for login and for every client. |
| `AI_VOICE_HTTP_PORT` | unset (stdio) | When set, serves MCP over HTTP on `/mcp` instead of stdio. See [Serve AI Voice over the network](network.md). |
| `AI_VOICE_HTTP_HOST` | `127.0.0.1` | Listen address in HTTP mode. |

## Commands

| Command | Effect |
| --- | --- |
| `npm run login` | Opens a login proxy on `http://127.0.0.1:3456/` and saves the Amazon session. Plays no audio. |
| `npm run devices` | Prints the Echo devices as JSON. Plays no audio. |
| `npm start` | Starts the server. In MCP client configurations, launch `node src/server.js` directly so stdout carries only the protocol. |
| `npm test` | Runs the test suite against simulated devices. |

## Tools

### `list_devices`

Takes no arguments. Returns the physical Echo devices on the account; apps, device groups and other device families are excluded.

```json
[{ "name": "Living Room Echo", "serial": "…", "online": true, "is_default": true }]
```

### `speak`

| Argument | Required | Description |
| --- | --- | --- |
| `text` | yes | Plain text, 1 to 4000 UTF-16 code units. Empty text and text containing `<` or `>` (SSML) are rejected. |
| `device_serial` | no | A serial returned by `list_devices`. Defaults to `AI_VOICE_DEFAULT_DEVICE`. |

```json
{ "status": "accepted", "device": "Living Room Echo", "chunks": 1, "playback_confirmed": false }
```

`accepted` means the Alexa API took the request. `playback_confirmed` is always `false`: the API gives no signal that audio played.

Text above 250 code units is split at sentence boundaries, then word boundaries, and sent as a single ordered sequence. A server handles one `speak` at a time and rejects a concurrent one. It never retries.

## Session files

`AI_VOICE_STATE_DIR` is created with mode `0700` and contains:

| File | Content |
| --- | --- |
| `session.json` | Amazon cookies, refresh tokens and registration data, mode `0600`. A new login reuses it so it does not register another virtual device. |
| `registration.json` | Registration data of the virtual device, written by the login library. |

Tokens older than 24 hours are renewed when the server connects, and authentication is rechecked after 30 minutes of use, without a new login. Delete the directory to sign out locally; remove the virtual device from your Amazon account to revoke its access.

## Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| `Speech is disabled.` | Set `AI_VOICE_ENABLE_SPEECH=1` in the client configuration and restart the client. |
| `Provide device_serial or set AI_VOICE_DEFAULT_DEVICE.` | Set a default Echo, or have the agent pass a serial from `list_devices`. |
| `Amazon session is missing or invalid.` | Run `npm run login` on the machine that hosts AI Voice, with the same `AI_VOICE_STATE_DIR` the server uses. |
| `Amazon session expired and could not be renewed.` | Run `npm run login` again. |
| `Echo not found.` | The serial is not a physical Echo on this account. Check `npm run devices`. |
| `Echo is offline.` | Check the device's power and Wi-Fi. |
| Login or device listing fails on your account | Check `AI_VOICE_AMAZON_PAGE` matches the marketplace where the account is registered. See [marketplace and host](alexa-integration.md#marketplace-host-and-locale) before changing `AI_VOICE_ALEXA_HOST`. |
| The Echo speaks with the wrong accent or misreads the text | Set `AI_VOICE_LOCALE` to the language of the text. |
| Port 3456 is in use during login | Stop the previous login process, then retry. |
| `speak` is accepted but nothing is heard | Check the Echo's volume and Do Not Disturb. Do not retry in a loop; each accepted request may still play. |

Do not enable debug logging in `alexa-remote2` or `alexa-cookie2` when asking for help: their logs include cookies and tokens.
