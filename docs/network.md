# Serve AI Voice over the network

Run AI Voice once on an always-on machine and point the agents on your other machines at it. The Amazon session stays only on the host.

Prerequisite: AI Voice is installed and signed in on the host, as in the [quick start](../README.md#quick-start), steps 1 to 3.

## Understand the exposure first

The HTTP endpoint has **no authentication**. Anyone who can reach the port can list your Echo devices and speak on them.

- The server listens on `127.0.0.1` unless you set `AI_VOICE_HTTP_HOST`.
- Bind it only to a private address you control, such as a VPN or mesh-network interface (WireGuard, Tailscale). Do not bind it to `0.0.0.0` on an untrusted network and never expose it to the internet.
- Requests carrying an `Origin` header are refused with `403`, so a web page open in a browser cannot call the endpoint.

## Start the server in HTTP mode

Setting `AI_VOICE_HTTP_PORT` switches the server from stdio to Streamable HTTP on `/mcp`:

```sh
AI_VOICE_HTTP_HOST=PRIVATE-IP AI_VOICE_HTTP_PORT=7347 \
AI_VOICE_ENABLE_SPEECH=1 AI_VOICE_DEFAULT_DEVICE=SERIAL \
node src/server.js
```

It logs `AI Voice listening on http://PRIVATE-IP:7347/mcp` to stderr.

## Keep it running with systemd

On Linux, create `~/.config/systemd/user/ai-voice.service`, replacing the placeholders. Get the absolute Node path with `node -p process.execPath`.

```ini
[Unit]
Description=AI Voice MCP
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/path/to/ai-voice
Environment=AI_VOICE_HTTP_HOST=PRIVATE-IP
Environment=AI_VOICE_HTTP_PORT=7347
Environment=AI_VOICE_ENABLE_SPEECH=1
Environment=AI_VOICE_DEFAULT_DEVICE=SERIAL
ExecStart=/path/to/node src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```sh
systemctl --user enable --now ai-voice
loginctl enable-linger "$USER"   # keep the service running while you are logged out
```

## Connect the clients

On each client machine, replace `HOST` with the host's private address or name.

Claude Code:

```sh
claude mcp add ai-voice --scope user --transport http http://HOST:7347/mcp
```

Codex:

```sh
codex mcp add ai-voice --url http://HOST:7347/mcp
```

Any other client: configure a Streamable HTTP MCP server with the URL `http://HOST:7347/mcp`.

## Verify

Ask an agent on a client machine to list your Echo devices. `list_devices` plays no audio, so it is a safe connectivity check before trying `speak`.

All variables are described in the [configuration reference](configuration.md).
