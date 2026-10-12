# Configuration reference

Exact settings, tool contracts and failure messages of Jarvis. To install and connect it for the first time, follow the [quick start](../README.md#quick-start).

## Environment variables

Set these in the MCP client configuration that launches the server, or in the service that hosts it. The `login` and `devices` commands and the dashboard read the same variables from the environment. The names keep the `AI_VOICE_*` prefix of the original project.

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_VOICE_ENABLE_SPEECH` | disabled | Only the value `1` enables `speak`, on the Mac and on the Echo. Without it, `speak` is refused and `list_devices` still works. |
| `AI_VOICE_OUTPUT` | `mac` | Where `speak`, `announce` and `notify_fernando` play: `mac` (this Mac's default audio output) or `echo` (the default Echo). A `speak` with `device_serial` always goes to that Echo. Any other value stops the server at startup. |
| `AI_VOICE_TTS_URL` | `http://127.0.0.1:7349` | Local TTS server (Kokoro) tried first in `mac` mode: one `POST /synthesize` with `{text, voice}` that returns a WAV, with a 10 second timeout. On any failure the Mac speaks with `say` instead. |
| `AI_VOICE_TTS_VOICE` | `pf_dora` | Voice sent to the TTS server. |
| `AI_VOICE_MAC_VOICE` | `Luciana` | `say -v` voice used when the TTS server is unavailable. |
| `AI_VOICE_MAC_LOCK` | `~/.local/share/jarvis/fala.lock` | File locked with `/usr/bin/lockf` around every speech on the Mac, shared with `jarvis-fala`. Waits up to 90 seconds; playback is also capped at 90 seconds. |
| `AI_VOICE_DEFAULT_DEVICE` | none | Serial of the Echo used when `AI_VOICE_OUTPUT=echo` and `speak` is called without `device_serial`. |
| `AI_VOICE_LOCALE` | `en-US` | Locale the Echo speaks in, such as `pt-BR`, `de-DE` or `en-GB`. Also tells the agent which language to write in. |
| `AI_VOICE_AMAZON_PAGE` | `amazon.com` | Amazon marketplace used for login, such as `amazon.co.uk` or `amazon.com.br`. After login the session keeps the marketplace Amazon returned, and that value wins. |
| `AI_VOICE_ALEXA_HOST` | `alexa.<marketplace>` | Optional initial Alexa API host, without `https://`. Amazon's endpoint discovery may replace it after authentication. |
| `AI_VOICE_STATE_DIR` | `~/.local/share/ai-voice` | Directory holding the Amazon session. Use the same value for login and for every client. |
| `AI_VOICE_SPEAK_LOCK` | `/tmp/alexa-speak.lock` | File locked with `/usr/bin/lockf` (flock) around every speech, shared with other programs that run `lockf -t 90 <file> ...` before speaking. `speak` waits up to 90 seconds for it, then fails with "Echo ocupado" without speaking. |
| `AI_VOICE_HTTP_PORT` | unset (stdio) | When set, serves MCP over HTTP on `/mcp` instead of stdio. See [Serve Jarvis over the network](network.md). |
| `AI_VOICE_HTTP_HOST` | `127.0.0.1` | Listen address in HTTP mode. |

On a Mac, `scripts/setup.sh` keeps the values it installs with in `~/.config/jarvis/jarvis.env` and passes them to the LaunchAgents and to `claude mcp add`. See [Mac setup](setup.md#settings).

### Voice server

`services/tts/server.py`, installed by `scripts/setup.sh` into `~/.local/share/jarvis/tts` and run by the `dev.jarvis.tts` LaunchAgent, is what `AI_VOICE_TTS_URL` points at. It listens only on `127.0.0.1`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JARVIS_TTS_PORT` | `7349` | Port of the server. Change `AI_VOICE_TTS_URL` with it. |
| `JARVIS_TTS_MODEL_DIR` | `models/kokoro-82m-bf16` next to `server.py` | Kokoro model directory, with its `voices/` folder. |
| `JARVIS_TTS_VOICE` | `pf_dora` | Voice used when a request names none. Also read by `fala-kokoro.sh`. |
| `JARVIS_TTS_SPEED` | `1.15` | Speech speed used when a request sends no `speed`, between 0.5 and 2.0. |
| `JARVIS_TTS_HOME` | `~/.local/share/jarvis/tts` | Where `services/tts/install.sh` installs the server, and where `jarvis-fala` looks for `fala-kokoro.sh`. |

### Interrupting speech and clearing the queue

`jarvis-cala` (source `services/tts/jarvis-cala`, installed to `~/.local/bin` by `services/tts/install.sh`) is the single interruption point. It writes a new token to the cancel marker, then sends SIGTERM to the speech playing now (the `lockf` holding the lock and its children). Every speech records the marker before waiting for the lock (`fala-kokoro.sh`, and `speak` of the MCP server); when it gets the lock and the marker changed, it does not play and logs `motor=descartada ... motivo=interrompida` in `fala.log`. Speeches that enter after the interruption play normally. Everything that interrupts speech must call `jarvis-cala`: the Escuta barge-in, keyboard shortcuts, the dashboard button and the app bar. It never touches what the Escuta hears.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JARVIS_FALA_LOCK` | `~/.local/share/jarvis/fala.lock` | Speech lock. Takes precedence over `AI_VOICE_MAC_LOCK` in `fala-kokoro.sh`, `jarvis-cala` and the MCP server. |
| `JARVIS_FALA_CANCEL` | `fala.cancel` next to the lock | Cancel marker file. |

`GET /health` answers 200 once the model is loaded and warmed up, `GET /voices` lists the voices, and `POST /synthesize` takes `{"text", "voice", "speed"}` (up to 4000 characters, speed 0.5 to 2.0) and returns a WAV.

## Commands

| Command | Effect |
| --- | --- |
| `bun apps/mcp/src/main.ts login` | Opens a login proxy on `http://127.0.0.1:3456/` and saves the Amazon session. Plays no audio. |
| `bun apps/mcp/src/main.ts devices` | Prints the Echo devices as JSON. Plays no audio. |
| `bun apps/mcp/src/main.ts` | Starts the server: stdio, or HTTP when `AI_VOICE_HTTP_PORT` is set. Stdout carries only the MCP protocol; logs go to stderr. |

These are the subcommands of the `jarvis-voice` bin declared in `apps/mcp/package.json`, which points at `src/main.ts`. Run them from the root of the repository, after `bun install`. The process sets `umask` `077` at startup, so files it creates are private to your user.

## Tools

Voice tools are served over stdio and HTTP. Mac tools are served over stdio only.

### `list_devices`

Takes no arguments. Returns the physical Echo devices on the account; apps, device groups and other device families are excluded.

```json
[{ "name": "Living Room Echo", "serial": "…", "online": true, "is_default": true }]
```

### `speak`

| Argument | Required | Description |
| --- | --- | --- |
| `text` | yes | Plain text, 1 to 4000 UTF-16 code units. Empty text and text containing `<` or `>` (SSML) are rejected. |
| `device_serial` | no | A serial returned by `list_devices`. Sends the speech to that Echo. Without it, speech goes to `AI_VOICE_OUTPUT`: the Mac, or `AI_VOICE_DEFAULT_DEVICE` in `echo` mode. |

On the Mac, the text is synthesized by the local TTS server and played with `afplay`, or spoken with `say` when the server fails, both under `lockf` on `AI_VOICE_MAC_LOCK`. The tool returns once playback ended:

```json
{ "status": "accepted", "device": "Mac", "chunks": 1, "playback_confirmed": true }
```

On an Echo:

```json
{ "status": "accepted", "device": "Living Room Echo", "chunks": 1, "playback_confirmed": false }
```

On an Echo, `accepted` means the Alexa API took the request, and `playback_confirmed` is always `false`: the API gives no signal that audio played. Neither output falls back to the other.

The rest of this section describes the Echo.

Text above 250 code units is split at sentence boundaries, then word boundaries, and sent as a single ordered sequence. A server handles one `speak` at a time and rejects a concurrent one. It never retries: the request is sent once, with a 10 second timeout, and a timeout or error is reported as "playback not confirmed".

### Mac tools (stdio only)

Provided by `@jarvis/apple`. They run as your user on the Mac that launched the server. The first use makes macOS ask for Automation permission; if it was denied, the error points to System Settings > Privacy & Security > Automation. Every `osascript` or `open` call has a 15 second timeout, and the script text is constant: caller values travel only as arguments. Calendar is read through EventKit by a small Swift helper (`packages/apple/native/calendar-events.swift`), compiled on first use (or with `bun run build:native` in `packages/apple`) into `~/.local/share/jarvis/bin` (override with `JARVIS_BIN_DIR`); `build:native` also links it there as `calendar-events`, which a bundled server (the installed dashboard, which ships without the Swift sources) runs instead of compiling. It needs the Xcode Command Line Tools, only reads, and has a 10 second timeout. The helper disclaims responsibility for itself, so macOS asks about and lists `calendar-events` (not your terminal or `bun`) under System Settings > Privacy & Security > Calendars, where it needs Full Access; the grant is tied to the ad hoc signed binary, so an edited helper asks again.

| Tool | Arguments | Effect |
| --- | --- | --- |
| `reminders_lists` | none | Names of the Reminders lists. |
| `reminders_list` | `list?`, `include_completed?` | Reminders, open ones unless `include_completed` is true. |
| `reminders_add` | `title`, `list?`, `due?`, `notes?` | Creates a reminder. `due` is `YYYY-MM-DD` (all day) or an ISO 8601 date-time, in the Mac's time zone unless it carries an offset. |
| `calendar_today` | none | Today's events across all calendars. |
| `calendar_events` | `from`, `to`, `calendar?` | Events overlapping `[from, to)`. The range may span at most 31 days. |
| `calendar_calendars` | none | Names of the calendars. |
| `maps_search` | `query` | Opens Apple Maps on the Mac and returns the Maps URL. |
| `maps_directions` | `to`, `from?`, `mode?` | Opens directions; `mode` is `driving` (default), `walking` or `transit`. |
| `phone_call` | `number`, `via?` | Opens a `tel:` (default) or `facetime-audio:` URL. `number` must be E.164, such as `+5511999998888`; spaces, dashes, dots and parentheses are ignored. macOS asks for confirmation before dialing. |

`open` only accepts the exact URL shapes the package builds: `https://maps.apple.com/` links and calls to a bare E.164 number. Anything else is refused, which excludes `file:` URLs, other hosts and MMI/USSD codes.

## Dashboard

`apps/dashboard` is a SvelteKit app (adapter-node). Start it with `bunx turbo run dev --filter=@jarvis/dashboard`. It uses `@jarvis/alexa` and `@jarvis/apple` directly, in the dashboard's own server process, and reads the same `AI_VOICE_*` variables, so speech there is also disabled until `AI_VOICE_ENABLE_SPEECH=1`. It has no authentication: run it only where you would run the stdio server.

| Route | What it does |
| --- | --- |
| `/` | Sends text to an Echo, with the same limits as `speak`, and lists the devices. |
| `/lembretes` | Lists reminders (filter by list, optionally completed ones) and creates one. |
| `/agenda` | Shows today or the week (`?periodo=semana`), optionally for one calendar. |
| `/ir` | Opens a Maps search or route. A call needs an explicit confirmation step before it is placed. |

## Grokbot

`packages/grokbot` is under construction and is not wired into the MCP server or the dashboard yet. By design it only sends a message and never retries (at-most-once); it has no channel to bring a result back, so a success means "sent", not "done". Its settings are not documented here until they exist in code.

## Session files

`AI_VOICE_STATE_DIR` is created with mode `0700` and contains:

| File | Content |
| --- | --- |
| `session.json` | Amazon cookies, refresh tokens and registration data, mode `0600`. A new login reuses it so it does not register another virtual device. |
| `registration.json` | Registration data of the virtual device, written by the login library. |

The session is written to a temporary file with mode `0600` and renamed over `session.json`, so a crash never leaves a truncated session.

Tokens older than 24 hours are renewed when the server connects, and authentication is rechecked after 30 minutes of use, without a new login. Delete the directory to sign out locally; remove the virtual device from your Amazon account to revoke its access.

## Troubleshooting

| Message or symptom | What to do |
| --- | --- |
| `Speech is disabled.` | Set `AI_VOICE_ENABLE_SPEECH=1` in the client configuration and restart the client. |
| `Provide device_serial or set AI_VOICE_DEFAULT_DEVICE.` | Set a default Echo, or have the agent pass a serial from `list_devices`. |
| `Amazon session is missing or invalid.` | Run `bun apps/mcp/src/main.ts login` on the machine that hosts Jarvis, with the same `AI_VOICE_STATE_DIR` the server uses. |
| `Amazon session expired and could not be renewed.` | Run `bun apps/mcp/src/main.ts login` again. |
| `Echo not found.` | The serial is not a physical Echo on this account. Check `bun apps/mcp/src/main.ts devices`. |
| `Echo is offline.` | Check the device's power and Wi-Fi. |
| Login or device listing fails on your account | Check `AI_VOICE_AMAZON_PAGE` matches the marketplace where the account is registered. See [marketplace and host](alexa-integration.md#marketplace-host-and-locale) before changing `AI_VOICE_ALEXA_HOST`. |
| The Echo speaks with the wrong accent or misreads the text | Set `AI_VOICE_LOCALE` to the language of the text. |
| Port 3456 is in use during login | Stop the previous login process, then retry. The login proxy always uses `127.0.0.1:3456`. |
| `macOS denied Automation permission.` | Allow it in System Settings > Privacy & Security > Automation, then retry. |
| `Could not connect to Alexa. Check the connection and try again.` | Network or Alexa API problem, not an expired session. Check the connection and retry. |
| `speak` is accepted but nothing is heard | Check the Echo's volume and Do Not Disturb. Do not retry in a loop; each accepted request may still play. |

Do not enable debug logging in `alexa-remote2` or `alexa-cookie2` when asking for help: their logs include cookies and tokens.
