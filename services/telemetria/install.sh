#!/usr/bin/env bash
# Instala ou atualiza a telemetria do Jarvis: grava ~/Library/LaunchAgents/dev.jarvis.telemetria.plist
# a partir do modelo e (re)carrega o LaunchAgent, que sobe o backend Grafana LGTM e a sonda de saúde.
#
# Precisa de Docker (OrbStack ou Docker Desktop). Painel: http://127.0.0.1:7351/d/jarvis
# Uso: services/telemetria/install.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
LABEL="dev.jarvis.telemetria"
DATA="$HOME/.local/share/jarvis"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"

command -v docker >/dev/null 2>&1 || { echo "Falta o Docker (brew install orbstack)." >&2; exit 1; }
mkdir -p "$DATA/telemetria/logs" "$(dirname "$PLIST")"

NEW="$(mktemp)"
trap 'rm -f "$NEW"' EXIT
sed -e "s#@REPO@#$REPO#g" -e "s#@BUN@#$BUN#g" -e "s#@DATA@#$DATA#g" \
	"$REPO/services/launchd/$LABEL.plist.in" >"$NEW"
plutil -lint "$NEW" >/dev/null

if cmp -s "$NEW" "$PLIST" && launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
	echo "$LABEL já está em dia"
else
	install -m 644 "$NEW" "$PLIST"
	launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
	launchctl bootstrap "$DOMAIN" "$PLIST"
	echo "$LABEL carregado"
fi
echo "Painel: http://127.0.0.1:7351/d/jarvis"
