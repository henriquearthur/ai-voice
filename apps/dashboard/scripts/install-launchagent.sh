#!/usr/bin/env bash
# Instala ou atualiza o Jarvis como app sempre ligado no Mac.
#
# Faz o build de produção, compila o helper do Calendário, copia para apps/dashboard/.local/app (fora do build/
# para que um `bun run build` posterior não mexa no servidor em execução),
# grava ~/Library/LaunchAgents/dev.jarvis.dashboard.plist e reinicia o serviço.
#
# Uso: apps/dashboard/scripts/install-launchagent.sh [--skip-build]
set -euo pipefail

LABEL="dev.jarvis.dashboard"
HOST="127.0.0.1"
PORT="7350"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="$APP_DIR/.local/app"
DATA_DIR="$HOME/.local/share/jarvis/dashboard"
LOG_DIR="$DATA_DIR/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

# Ajustes do scripts/setup.sh (marketplace, locale, Echo padrão); sem o arquivo, valem os padrões abaixo.
CONFIG="${JARVIS_CONFIG:-$HOME/.config/jarvis/jarvis.env}"
# shellcheck disable=SC1090
[ -f "$CONFIG" ] && . "$CONFIG"
AI_VOICE_AMAZON_PAGE="${AI_VOICE_AMAZON_PAGE:-amazon.com.br}"
AI_VOICE_LOCALE="${AI_VOICE_LOCALE:-pt-BR}"
AI_VOICE_DEFAULT_DEVICE="${AI_VOICE_DEFAULT_DEVICE:-}"

BUN="$(command -v bun || true)"
[ -n "$BUN" ] || BUN="$HOME/.bun/bin/bun"
[ -x "$BUN" ] || { echo "bun não encontrado (procurei no PATH e em ~/.bun/bin)." >&2; exit 1; }

if [ "${1:-}" != "--skip-build" ]; then
	echo "==> Build de produção"
	(cd "$APP_DIR" && "$BUN" run build)
fi
[ -f "$APP_DIR/build/index.js" ] || { echo "build/index.js não existe; rode sem --skip-build." >&2; exit 1; }

# O build empacotado não leva os fontes Swift do helper do Calendário; o servidor
# usa o binário já compilado em ~/.local/share/jarvis/bin/calendar-events.
echo "==> Helper do Calendário"
# Sem as Xcode Command Line Tools o helper não compila; o dashboard sobe mesmo assim (o onboarding oferece instalar).
(cd "$APP_DIR/../../packages/apple" && "$BUN" run build:native) ||
	echo "aviso: o helper do Calendário não compilou (faltam as Xcode Command Line Tools?); a Agenda fica sem dados" >&2

echo "==> Publicando o build em $RELEASE_DIR"
mkdir -p "$APP_DIR/.local"
rm -rf "$RELEASE_DIR.next"
cp -R "$APP_DIR/build" "$RELEASE_DIR.next"
rm -rf "$RELEASE_DIR.prev"
[ -d "$RELEASE_DIR" ] && mv "$RELEASE_DIR" "$RELEASE_DIR.prev"
mv "$RELEASE_DIR.next" "$RELEASE_DIR"
# Servidor próprio (protocolo http + só Hosts locais/LAN), ao lado do handler.js do build.
cp "$APP_DIR/scripts/serve.mjs" "$APP_DIR/scripts/hosts-locais.mjs" "$RELEASE_DIR/"
rm -rf "$RELEASE_DIR.prev"

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

NEW_PLIST="$(mktemp)"
trap 'rm -f "$NEW_PLIST"' EXIT
cat >"$NEW_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$BUN")</string>
    <string>$(xml "$RELEASE_DIR/serve.mjs")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml "$APP_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOST</key><string>$HOST</string>
    <key>PORT</key><string>$PORT</string>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>$(xml "$(dirname "$BUN")"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>AI_VOICE_AMAZON_PAGE</key><string>$(xml "$AI_VOICE_AMAZON_PAGE")</string>
    <key>AI_VOICE_LOCALE</key><string>$(xml "$AI_VOICE_LOCALE")</string>
    <key>AI_VOICE_ENABLE_SPEECH</key><string>1</string>
    <key>AI_VOICE_DEFAULT_DEVICE</key><string>$(xml "$AI_VOICE_DEFAULT_DEVICE")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$(xml "$LOG_DIR/server.out.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOG_DIR/server.err.log")</string>
</dict>
</plist>
PLIST
plutil -lint "$NEW_PLIST" >/dev/null

if ! cmp -s "$NEW_PLIST" "$PLIST" 2>/dev/null; then
	echo "==> Gravando $PLIST"
	cp "$NEW_PLIST" "$PLIST"
	launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
fi

if ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
	echo "==> Carregando $LABEL"
	# O bootout volta antes de o launchd soltar o serviço; sem esperar, o bootstrap falha com "Bootstrap failed: 5".
	for _ in $(seq 40); do
		launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
		sleep 0.25
	done
	for tentativa in 1 2 3 4 5; do
		erro="$(launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1)" && break
		[ "$tentativa" -lt 5 ] || { echo "Falha ao carregar $LABEL após 5 tentativas de launchctl bootstrap: $erro" >&2; exit 1; }
		sleep 1
	done
fi

echo "==> Reiniciando $LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL"

URL="http://$HOST:$PORT/"
for _ in $(seq 1 40); do
	code="$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)"
	if [ "$code" = "200" ]; then
		echo "Jarvis no ar em $URL"
		exit 0
	fi
	sleep 0.5
done
echo "O Jarvis não respondeu 200 em $URL (último código: ${code:-nenhum}). Veja $LOG_DIR/server.err.log" >&2
exit 1
