#!/bin/bash
# Compila a Escuta, monta ~/.local/share/jarvis/bin/Escuta.app e grava o LaunchAgent dev.jarvis.escuta.
# Uso: scripts/instalar.sh [--carregar]
#   --carregar  também (re)carrega o LaunchAgent no launchd.
# O .app só é trocado se o binário mudou. Assinado com "Jarvis Local Signing", as permissões
# do macOS sobrevivem a rebuilds; com assinatura ad hoc, cada binário novo pede de novo.
set -euo pipefail

cd "$(dirname "$0")/.."
PKG="$PWD"
JARVIS="$HOME/.local/share/jarvis"
APP="$JARVIS/bin/Escuta.app"
LABEL="dev.jarvis.escuta"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE="$JARVIS/escuta"
# Identidade de assinatura estável (certificado na keychain de login). Com ela, o macOS lembra as
# permissões de microfone e de fala entre builds; sem ela, assina ad hoc e pode perguntar de novo.
IDENTITY="${JARVIS_SIGNING_IDENTITY:-Jarvis Local Signing}"
if security find-identity -p codesigning 2>/dev/null | grep -q "\"$IDENTITY\""; then SIGN="$IDENTITY"; else SIGN="-"; fi

# Ajustes do scripts/setup.sh; vazio = o padrão da própria escuta (Config.swift).
CONFIG="${JARVIS_CONFIG:-$HOME/.config/jarvis/jarvis.env}"
# shellcheck disable=SC1090
[ -f "$CONFIG" ] && . "$CONFIG"
# Motor de reconhecimento: apple (padrão) ou parakeet (NVIDIA Parakeet TDT v3 local + VAD Silero).
STT="${ESCUTA_STT:-apple}"
# Com o Parakeet a VAD mede o silêncio e o texto final sai na hora: fecha a fala mais cedo.
if [ "$STT" = "parakeet" ]; then SILENCIO_PADRAO=1.0; else SILENCIO_PADRAO=1.3; fi
SILENCIO="${ESCUTA_SILENCIO:-$SILENCIO_PADRAO}"
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

swift build -c release --package-path "$PKG"
BIN="$(swift build -c release --package-path "$PKG" --show-bin-path)/Escuta"

mkdir -p "$APP/Contents/MacOS" "$STATE/logs"
signed_by() { codesign -dv "$APP" 2>&1 | grep -q "Authority=$IDENTITY"; }
if cmp -s "$BIN" "$APP/Contents/MacOS/Escuta" && cmp -s "$PKG/Resources/Info.plist" "$APP/Contents/Info.plist" \
   && { [ "$SIGN" = "-" ] || signed_by; }; then
  echo "Escuta.app já está atualizado"
else
  cp "$PKG/Resources/Info.plist" "$APP/Contents/Info.plist"
  cp "$BIN" "$APP/Contents/MacOS/Escuta"
  codesign --force --sign "$SIGN" --identifier "$LABEL" "$APP"
  echo "Escuta.app instalado em $APP (assinatura: $([ "$SIGN" = "-" ] && echo "ad hoc" || echo "$SIGN"))"
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$APP/Contents/MacOS/Escuta</string>
  </array>
  <key>WorkingDirectory</key><string>$STATE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ESCUTA_STT</key><string>$(xml "$STT")</string>
    <key>ESCUTA_SILENCIO</key><string>$(xml "$SILENCIO")</string>
    <key>ESCUTA_CONVERSA</key><string>8</string>
    <key>ESCUTA_SILENCIO_ABERTA</key><string>$(xml "${ESCUTA_SILENCIO_ABERTA:-2.5}")</string>
    <key>ESCUTA_CONFIANCA_MIN</key><string>$(xml "${ESCUTA_CONFIANCA_MIN:-}")</string>
    <key>ESCUTA_PANE</key><string>$(xml "${ESCUTA_PANE:-}")</string>
    <key>ESCUTA_ORQUESTRADOR</key><string>$(xml "${ESCUTA_ORQUESTRADOR:-}")</string>
    <key>ESCUTA_MIC</key><string>$(xml "${ESCUTA_MIC:-}")</string>
    <key>PATH</key><string>$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
  <key>StandardOutPath</key><string>$STATE/logs/escuta.events.jsonl</string>
  <key>StandardErrorPath</key><string>$STATE/logs/escuta.log</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST" >/dev/null
echo "LaunchAgent gravado em $PLIST"

if [ "${1:-}" = "--carregar" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  # bootout termina em segundo plano: espera o job sumir antes do bootstrap. A escuta só sai
  # depois que a frase em curso termina e é enviada (até ~20 s), então a espera é longa.
  for _ in $(seq 1 175); do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.2; done
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "LaunchAgent carregado"
fi
