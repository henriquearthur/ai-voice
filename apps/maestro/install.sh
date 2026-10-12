#!/bin/bash
# Liga o maestro sempre ligado: renderiza os LaunchAgents dev.jarvis.eventos e
# dev.jarvis.maestro em ~/Library/LaunchAgents e os (re)carrega.
#
#   apps/maestro/install.sh             instala e carrega
#   apps/maestro/install.sh --dry-run   só mostra os plists
#   apps/maestro/install.sh --hooks     imprime o trecho de hooks para o ~/.claude/settings.json
#   apps/maestro/install.sh --remover   descarrega e apaga os dois plists
#
# Variáveis opcionais: JARVIS_MAESTRO_NOME (maestro), JARVIS_MAESTRO_DIR
# (~/.local/share/jarvis/maestro), JARVIS_MAESTRO_WORKSPACE (o do maestro vivo),
# JARVIS_EVENTOS_PORT (7353). Não toca no settings.json.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
NOME="${JARVIS_MAESTRO_NOME:-maestro}"
DIR="${JARVIS_MAESTRO_DIR:-$HOME/.local/share/jarvis/maestro}"
PORT="${JARVIS_EVENTOS_PORT:-7353}"
HERDR="${JARVIS_HERDR:-$HOME/.local/bin/herdr}"
# Os panes que o vigia cria ficam no workspace do maestro vivo (pelo rótulo, que sobrevive a um
# reinício do herdr); sem maestro no ar, num workspace "maestro".
workspace_do_maestro() {
	"$HERDR" agent get "$NOME" 2>/dev/null | /usr/bin/python3 -c '
import json, subprocess, sys
ws = json.load(sys.stdin)["result"]["agent"]["workspace_id"]
lista = json.loads(subprocess.run([sys.argv[1], "workspace", "list"], capture_output=True, text=True).stdout)
print(next(w.get("label") or ws for w in lista["result"]["workspaces"] if w["workspace_id"] == ws))
' "$HERDR" 2>/dev/null || echo maestro
}
WORKSPACE="${JARVIS_MAESTRO_WORKSPACE:-$(workspace_do_maestro)}"
FALA="${JARVIS_FALA:-$HOME/.local/bin/jarvis-fala}"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
LABELS=(dev.jarvis.eventos dev.jarvis.maestro)

hooks() {
	cat <<JSON
"SessionStart": [
  {
    "matcher": "startup|resume|compact|clear",
    "hooks": [{ "type": "command", "command": "$BUN $REPO/apps/maestro/src/hooks/session-start.ts", "timeout": 10 }]
  }
],
"PreCompact": [
  {
    "hooks": [{ "type": "command", "command": "$BUN $REPO/apps/maestro/src/hooks/pre-compact.ts", "timeout": 30 }]
  }
]
JSON
}

render() {
	local xml_esc
	xml_esc() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1" | sed -e 's/[\\|&]/\\&/g'; }
	sed -e "s|@BUN@|$(xml_esc "$BUN")|g" -e "s|@REPO@|$(xml_esc "$REPO")|g" -e "s|@NOME@|$(xml_esc "$NOME")|g" \
		-e "s|@DIR@|$(xml_esc "$DIR")|g" -e "s|@WORKSPACE@|$(xml_esc "$WORKSPACE")|g" -e "s|@PORT@|$PORT|g" \
		-e "s|@HERDR@|$(xml_esc "$HERDR")|g" -e "s|@FALA@|$(xml_esc "$FALA")|g" -e "s|@HOME@|$(xml_esc "$HOME")|g" "$1"
}

case "${1:-}" in
--hooks)
	hooks
	exit 0
	;;
--remover)
	for label in "${LABELS[@]}"; do
		launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
		rm -f "$AGENTS_DIR/$label.plist"
	done
	echo "Maestro desligado (a memória em $DIR fica)."
	exit 0
	;;
esac

for label in "${LABELS[@]}"; do
	if [ "${1:-}" = "--dry-run" ]; then
		echo "== $AGENTS_DIR/$label.plist"
		render "$REPO/apps/maestro/launchd/$label.plist.in"
		continue
	fi
	mkdir -p -m 700 "$DIR" "$DIR/logs"
	out="$(mktemp)"
	render "$REPO/apps/maestro/launchd/$label.plist.in" >"$out"
	plutil -lint "$out" >/dev/null
	install -m 644 "$out" "$AGENTS_DIR/$label.plist"
	rm -f "$out"
	launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
	for _ in $(seq 1 50); do launchctl print "$DOMAIN/$label" >/dev/null 2>&1 || break; sleep 0.2; done
	# O bootout é assíncrono: mesmo após o print falhar, o bootstrap pode dar "Bootstrap failed: 5".
	carregado=0
	for tentativa in 1 2 3 4 5; do
		if launchctl bootstrap "$DOMAIN" "$AGENTS_DIR/$label.plist"; then
			carregado=1
			break
		fi
		if [ "$tentativa" -lt 5 ]; then sleep 1; fi
	done
	if [ "$carregado" != 1 ]; then
		echo "Falha ao carregar $label após 5 tentativas de launchctl bootstrap." >&2
		exit 1
	fi
	echo "Carregado: $label"
done

[ "${1:-}" = "--dry-run" ] && exit 0
[ -f "$DIR/rotinas.json" ] || install -m 600 "$REPO/apps/maestro/rotinas.example.json" "$DIR/rotinas.json"
[ -f "$DIR/agentes.json" ] || install -m 600 "$REPO/apps/maestro/agentes.example.json" "$DIR/agentes.json"
echo "Especialistas: $DIR/agentes.json (o vigia cria e supervisiona cada um ao lado do maestro)"
echo "Rotinas: $DIR/rotinas.json"
echo "URL de eventos: $(cd "$REPO/apps/maestro" && JARVIS_MAESTRO_DIR="$DIR" JARVIS_EVENTOS_PORT="$PORT" "$BUN" src/eventos-main.ts --print-url)"
echo "Hooks para o ~/.claude/settings.json (dentro de \"hooks\"): apps/maestro/install.sh --hooks"
