#!/bin/bash
# Hook SessionStart/UserPromptSubmit: injeta memória coletiva + resumo do quadro.
# Nunca quebra o prompt: qualquer erro -> saída vazia, exit 0.
command -v jq >/dev/null 2>&1 || exit 0

# Timeout global de 3 s (perl alarm; macOS não tem `timeout`).
if [ -z "$CC_HOOK_INNER" ]; then
  CC_HOOK_INNER=1 exec perl -e 'alarm 3; exec @ARGV' /bin/bash "$0" || exit 0
fi

PAYLOAD="$(cat 2>/dev/null || true)"
EVENT="$(printf '%s' "$PAYLOAD" | jq -r '.hook_event_name // empty' 2>/dev/null)"
[ -z "$EVENT" ] && EVENT="${CC_HOOK_EVENT:-UserPromptSubmit}"
IS_SUB="$(printf '%s' "$PAYLOAD" | jq -r 'if (.agent_id // .subagent_id // .agent_type // empty) != "" or (.is_subagent // false) == true then "1" else "" end' 2>/dev/null)"
CWD="$(printf '%s' "$PAYLOAD" | jq -r '.cwd // empty' 2>/dev/null)"
[ -z "$CWD" ] && CWD="$PWD"

JARVIS="${JARVIS_DIR:-$HOME/.jarvis}"
MEM="$JARVIS/memoria"
ROOT="$(cd "$(dirname "$0")/../.." 2>/dev/null && pwd)"

lê() { [ -s "$1" ] && cat "$1"; }

bot_name() {
  local n=""
  if [ -n "$HERDR_PANE_ID" ] && command -v herdr >/dev/null 2>&1; then
    n="$(herdr pane list 2>/dev/null | jq -r --arg id "$HERDR_PANE_ID" '.result.panes[]? | select(.pane_id==$id) | .label // empty' 2>/dev/null | head -1)"
  fi
  if [ -z "$n" ]; then
    case "$CWD" in
      */apps/claude-bots/*) n="$(printf '%s' "${CWD#*/apps/claude-bots/}" | cut -d/ -f1)";;
    esac
  fi
  # sanitiza (evita path traversal)
  printf '%s' "$n" | tr -cd 'A-Za-z0-9._-'
}

quadro() {
  local out=""
  if [ -f "$ROOT/packages/quadro/bin/quadro.ts" ] && command -v bun >/dev/null 2>&1; then
    out="$(bun "$ROOT/packages/quadro/bin/quadro.ts" resumo 2>/dev/null)" || out=""
  fi
  if [ -z "$out" ] && [ -f "$JARVIS/quadro.db" ] && command -v sqlite3 >/dev/null 2>&1; then
    out="$(sqlite3 "$JARVIS/quadro.db" "select estado||': '||count(*) from cards group by estado;" 2>/dev/null)" || out=""
    [ -n "$out" ] && out="Quadro (cards por estado):
$out"
  fi
  printf '%s' "$out" | head -c 1500
}

CTX=""
add() { [ -n "$2" ] && CTX="${CTX}${CTX:+

}## $1
$2"; }

if [ "$EVENT" = "SessionStart" ]; then
  add "Memória coletiva (coletivo.md)" "$(lê "$MEM/coletivo.md")"
  if [ -z "$IS_SUB" ]; then
    add "Perfil do Fernando (fernando.md)" "$(lê "$MEM/fernando.md")"
    B="$(bot_name)"
    [ -n "$B" ] && add "Caderno do bot $B" "$(lê "$MEM/bots/$B.md")"
  fi
  add "Quadro" "$(quadro)"
else
  add "Quadro" "$(quadro)"
fi

[ -z "$CTX" ] && exit 0
jq -cn --arg e "$EVENT" --arg c "$CTX" '{hookSpecificOutput:{hookEventName:$e,additionalContext:$c}}' 2>/dev/null || true
exit 0
