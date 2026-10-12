#!/bin/bash
# Instala (ou reinstala) o LaunchAgent dev.jarvis.coletor a partir do modelo em apps/coletor/launchd.
# Uso: apps/coletor/scripts/instalar.sh [--desinstalar]
set -euo pipefail

LABEL=dev.jarvis.coletor
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
DATA="${JARVIS_DATA:-$HOME/.local/share/jarvis}"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ "${1:-}" = "--desinstalar" ]; then
	launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
	rm -f "$PLIST"
	echo "removido $LABEL"
	exit 0
fi

BUN="${BUN:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"
HERDR="${JARVIS_HERDR:-$(command -v herdr || echo "$HOME/.local/bin/herdr")}"
[ -x "$BUN" ] || { echo "bun não encontrado em $BUN" >&2; exit 1; }

xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
sub() { printf '%s' "$(xml "$1")" | sed -e 's/[\/&|]/\\&/g'; }

mkdir -p "$DATA/coletor/logs" "$AGENTS_DIR"
tmp="$(mktemp)"
sed -e "s|@BUN@|$(sub "$BUN")|g" \
	-e "s|@REPO@|$(sub "$REPO")|g" \
	-e "s|@DATA@|$(sub "$DATA")|g" \
	-e "s|@HERDR@|$(sub "$HERDR")|g" \
	"$REPO/apps/coletor/launchd/$LABEL.plist.in" >"$tmp"
plutil -lint "$tmp" >/dev/null
chmod 644 "$tmp"
mv "$tmp" "$PLIST"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
# O bootout volta antes de o launchd soltar o serviço; sem esperar, o bootstrap falha com "Bootstrap failed: 5".
for _ in $(seq 40); do
	launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
	sleep 0.25
done
for tentativa in 1 2 3 4 5; do
	erro="$(launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1)" && break
	[ "$tentativa" -lt 5 ] || { echo "falha ao carregar $LABEL após 5 tentativas de launchctl bootstrap: $erro" >&2; exit 1; }
	sleep 1
done
echo "instalado $LABEL ($PLIST); estado em http://127.0.0.1:7352/estado"
