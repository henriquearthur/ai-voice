# Serve Jarvis over the network

Run Jarvis once on an always-on machine and point the agents on your other machines at it. The Amazon session stays only on the host.

Prerequisite: Jarvis is signed in on the host, as in the [quick start](../README.md#quick-start), steps 1 and 2.

## Understand the exposure first

The HTTP endpoint has **no authentication**. Anyone who can reach the port can list your Echo devices and speak on them.

- The server listens on `127.0.0.1` unless you set `AI_VOICE_HTTP_HOST`.
- Over HTTP the server is voice-only (`list_devices` and `speak`). The Mac tools (Reminders, Calendar, Maps, `phone_call`) are registered on stdio only, precisely because this endpoint has no authentication.
- Bind it only to a private address you control, such as a VPN or mesh-network interface (WireGuard, Tailscale). Do not bind it to `0.0.0.0` on an untrusted network and never expose it to the internet.
- Requests carrying an `Origin` header are refused with `403`, so a web page open in a browser cannot call the endpoint.

## Start the server in HTTP mode

Setting `AI_VOICE_HTTP_PORT` switches the server from stdio to Streamable HTTP on `/mcp`:

```sh
AI_VOICE_HTTP_HOST=PRIVATE-IP AI_VOICE_HTTP_PORT=7347 \
AI_VOICE_ENABLE_SPEECH=1 AI_VOICE_DEFAULT_DEVICE=SERIAL \
bun /ABS/PATH/apps/mcp/src/main.ts
```

It logs `Jarvis Voice listening on http://PRIVATE-IP:7347/mcp` to stderr.

## Keep it running with systemd

On Linux, create `~/.config/systemd/user/jarvis-voice.service`, replacing the placeholders. Get the absolute path of Bun with `which bun`, and of this repository's `apps/mcp/src/main.ts`. If the service cannot find `bun`, add an `Environment=PATH=` line that includes its directory.

```ini
[Unit]
Description=Jarvis Voice MCP
After=network-online.target
Wants=network-online.target

[Service]
Environment=AI_VOICE_HTTP_HOST=PRIVATE-IP
Environment=AI_VOICE_HTTP_PORT=7347
Environment=AI_VOICE_ENABLE_SPEECH=1
Environment=AI_VOICE_DEFAULT_DEVICE=SERIAL
ExecStart=/path/to/bun /ABS/PATH/apps/mcp/src/main.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now jarvis-voice
loginctl enable-linger "$USER"   # keep the service running while you are logged out
```

## Connect the clients

On each client machine, replace `HOST` with the host's private address or name.

Claude Code:

```sh
claude mcp add jarvis-voice --scope user --transport http http://HOST:7347/mcp
```

Codex:

```sh
codex mcp add jarvis-voice --url http://HOST:7347/mcp
```

Any other client: configure a Streamable HTTP MCP server with the URL `http://HOST:7347/mcp`.

The macOS-only parts of Jarvis (the Mac tools and the dashboard's Reminders, Agenda and Ir pages) need a Mac. A Linux host serves voice only.

## Verify

Ask an agent on a client machine to list your Echo devices. `list_devices` plays no audio, so it is a safe connectivity check before trying `speak`.

All variables are described in the [configuration reference](configuration.md).
