# Mac setup

`scripts/setup.sh` installs Jarvis on a Mac for the current user, with no `sudo`. This page lists what it writes, the optional parts and how to undo it. For the short version, see [Install on a Mac](../README.md#install-on-a-mac-one-command).

## Run it

```sh
./scripts/setup.sh --dry-run   # prints every step, writes and restarts nothing
./scripts/setup.sh             # asks a few questions in a terminal, then installs
./scripts/setup.sh --sim       # same, without questions (config file, environment and defaults)
```

The script is idempotent. It copies a file or rewrites a LaunchAgent only when the content changed, rebuilds the voice server's venv only when `services/tts/requirements.lock.txt` changed, and downloads the model only when it is missing. Run it again after a `git pull`.

It stops before installing anything when a prerequisite is missing, and says how to install it:

| Prerequisite | Needed for | Install |
| --- | --- | --- |
| macOS | everything | |
| Bun 1.3+ | the MCP server, the dashboard, the callback server | `curl -fsSL https://bun.sh/install \| bash` |
| Xcode Command Line Tools (`swift`) | the Calendar helper and Escuta | `xcode-select --install` |
| uv, or Python 3.12 | the Kokoro voice server (Apple Silicon only) | `brew install uv` |
| macOS 26 and herdr | Escuta | |
| `jq` | the `jarvis-avisa` hook | `brew install jq` |
| `claude` | registering the MCP server | [Claude Code](https://claude.com/claude-code) |

## Options

| Flag | Effect |
| --- | --- |
| `--dry-run` | Shows the steps and the diff of every file it would write. |
| `--com-echo` | Asks for the Amazon marketplace, the default Echo serial and the default output (`mac` or `echo`). |
| `--com-grok` | Installs the Grok Bot callback server, `dev.jarvis.callback`. |
| `--com-escuta` | Installs Escuta even when herdr is not found. |
| `--sem-voz` | Skips the Kokoro server; the Mac speaks with `say`. |
| `--sem-dashboard` | Skips the dashboard LaunchAgent. |
| `--sem-escuta` | Skips Escuta. |
| `--sem-mcp` | Does not register the MCP server in Claude Code. |
| `--sim`, `-y` | Asks nothing. Also the behavior when stdin is not a terminal. |

## Settings

The answers live in `~/.config/jarvis/jarvis.env` (mode `0600`, override the path with `JARVIS_CONFIG`). An environment variable with the same name wins over the file, and the file is rewritten with the final value. `apps/dashboard/scripts/install-launchagent.sh` and `apps/escuta/scripts/instalar.sh` read the same file, so running them alone keeps your values.

| Key | Default | Used by |
| --- | --- | --- |
| `AI_VOICE_LOCALE` | `pt-BR` | MCP server, dashboard, callback |
| `AI_VOICE_AMAZON_PAGE` | `amazon.com.br` | MCP server, dashboard, callback |
| `AI_VOICE_OUTPUT` | `mac` | MCP server, callback |
| `AI_VOICE_DEFAULT_DEVICE` | empty | MCP server, dashboard, callback |
| `AI_VOICE_TTS_VOICE` | `pf_dora` | voice server, MCP server, callback (`pf_dora`, `pm_alex` or `pm_santa`) |
| `JARVIS_CALLBACK_PORT` | `7348` | callback |
| `ESCUTA_PANE`, `ESCUTA_ORQUESTRADOR`, `ESCUTA_MIC` | empty (Escuta's own defaults) | Escuta |

No secret goes in this file. The Amazon session stays in `~/.local/share/ai-voice/`, the callback token is generated in the same directory on first start, and the Grok Bot secrets go to the Keychain.

## What it installs

| Path | Content |
| --- | --- |
| `~/.local/share/jarvis/tts/` | `server.py`, `fala-kokoro.sh`, the lock file, `.venv/`, `models/kokoro-82m-bf16/` (pinned revision, pt-BR voices only), `hf-cache/` and `logs/`. |
| `~/.local/bin/jarvis-fala` | `jarvis-fala "text"` (or text on stdin) speaks on the Mac through the voice server, falling back to `say -v Luciana`. Shares the lock `~/.local/share/jarvis/fala.lock` with the MCP server, so only one speech plays at a time. |
| `~/.local/bin/jarvis-fala-resposta` | Optional Claude Code `Stop` hook: after a spoken request (a message that starts with `[voz do ...]`, as Escuta sends it), speaks a short pt-BR version of the answer if the agent did not speak. |
| `~/.local/bin/jarvis-avisa` | Optional Claude Code `Notification` and `Stop` hook: says out loud when a session needs your permission, is waiting, or ends with a question. |
| `~/.local/bin/jarvis-mcp-stdio` | Starts `apps/mcp/src/main.ts` with Bun, reading `GROKBOT_WEBHOOK_URL` and `GROKBOT_KEY` from the Keychain when they exist. Rendered from `services/bin/jarvis-mcp-stdio.in` with this checkout's path. |
| `~/Library/LaunchAgents/dev.jarvis.tts.plist` | From `services/launchd/dev.jarvis.tts.plist.in`. |
| `~/Library/LaunchAgents/dev.jarvis.dashboard.plist` | Written by `apps/dashboard/scripts/install-launchagent.sh`, which also builds the dashboard into `apps/dashboard/.local/app` and the Calendar helper into `~/.local/share/jarvis/bin`. |
| `~/Library/LaunchAgents/dev.jarvis.escuta.plist` | Written by `apps/escuta/scripts/instalar.sh`, which builds `~/.local/share/jarvis/bin/Escuta.app`. |
| `~/Library/LaunchAgents/dev.jarvis.callback.plist` | Only with `--com-grok`. From `services/launchd/dev.jarvis.callback.plist.in`. |

A different file that already exists in `~/.local/bin` is kept next to the new one as `<name>.bak`.

The LaunchAgents and logs:

| Label | Listens on | Logs |
| --- | --- | --- |
| `dev.jarvis.tts` | `127.0.0.1:7349` | `~/.local/share/jarvis/tts/logs/` |
| `dev.jarvis.dashboard` | `127.0.0.1:7350` | `~/.local/share/jarvis/dashboard/logs/` |
| `dev.jarvis.escuta` | none | `~/.local/share/jarvis/escuta/logs/` |
| `dev.jarvis.callback` | `127.0.0.1:7348` | `~/.local/share/jarvis/callback/logs/` |

All of them bind to loopback only. Check the voice server with `curl -s http://127.0.0.1:7349/health` and try it with `jarvis-fala "Olá, eu sou o Jarvis."`.

## By hand, after the script

- **macOS permissions.** They are asked on first use: Calendars and Reminders for the dashboard and the MCP Mac tools, Automation for `osascript`, Microphone and Speech Recognition for Escuta. If you deny one, change it in System Settings > Privacy & Security. Each Escuta rebuild has a new ad hoc signature, so macOS may ask for the microphone again.
- **Echo** (`--com-echo`). Sign in with `bun apps/mcp/src/main.ts login` and open `http://127.0.0.1:3456/` (the password goes only into the browser), list the devices with `bun apps/mcp/src/main.ts devices`, put the serial in `AI_VOICE_DEFAULT_DEVICE` in the config file and run the setup again. If `ai-voice` was already registered in Claude Code, remove it with `claude mcp remove ai-voice -s user` before that, so it is registered with the new values.
- **Grok Bot** (`--com-grok`). Store the secrets in the Keychain, never in a file:

  ```sh
  security add-generic-password -a jarvis -s jarvis-grokbot-webhook-url -w
  security add-generic-password -a jarvis -s jarvis-grokbot-key -w
  ```

  `bun apps/mcp/src/callback-main.ts --print-url` prints the local callback URL with its token. To let the Grok Bot reach it, publish the port with Tailscale Funnel (`tailscale funnel --bg 7348`) and give the connector `https://<machine>.<tailnet>.ts.net/mcp/<token>`. The path token is the only authentication, so treat that URL as a secret.
- **Claude Code hooks** (optional). Add them to `~/.claude/settings.json`:

  ```json
  {
    "hooks": {
      "Notification": [{ "hooks": [{ "type": "command", "command": "~/.local/bin/jarvis-avisa", "async": true, "timeout": 60 }] }],
      "Stop": [
        { "hooks": [{ "type": "command", "command": "~/.local/bin/jarvis-avisa", "async": true, "timeout": 60 }] },
        { "hooks": [{ "type": "command", "command": "~/.local/bin/jarvis-fala-resposta", "timeout": 10 }] }
      ]
    }
  }
  ```

  Both rewrite text with `claude -p --model haiku` before speaking it. To have a session speak every answer, add its session id to `~/.local/share/jarvis/voz-sempre`, one per line.

## Uninstall

```sh
for label in dev.jarvis.tts dev.jarvis.dashboard dev.jarvis.escuta dev.jarvis.callback; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null
  rm -f ~/Library/LaunchAgents/$label.plist
done
rm -f ~/.local/bin/jarvis-fala ~/.local/bin/jarvis-fala-resposta ~/.local/bin/jarvis-avisa ~/.local/bin/jarvis-mcp-stdio
rm -rf ~/.local/share/jarvis ~/.config/jarvis
claude mcp remove ai-voice -s user
```

This keeps the Amazon session in `~/.local/share/ai-voice/`. Delete that folder too to sign out locally, and remove the virtual device from your Amazon account to revoke it.
