#!/usr/bin/env bash
# Sobe (ou adota) os três bots fixos do Jarvis no workspace herdr atual:
# chefe (opus), despachante (sonnet), vigia (haiku). Idempotente.
#
#   subir.sh            cria/adota os panes e inicia o claude onde faltar
#   subir.sh --dry-run  só mostra o que faria (lê o herdr, não muda nada)
#
# Cada bot roda num pane com label igual ao nome, cwd na pasta do bot
# (onde está o CLAUDE.md do papel), sem bypassPermissions. A sessão do
# chefe vai para ~/.local/share/jarvis/voz-sempre: ele é a única voz.
set -euo pipefail

DRY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "argumento desconhecido: $arg" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERDR="${HERDR_BIN_PATH:-$(command -v herdr || true)}"
JARVIS_DATA="${JARVIS_DATA:-$HOME/.local/share/jarvis}"
STATE="$JARVIS_DATA/claude-bots"
VOZ_SEMPRE="$JARVIS_DATA/voz-sempre"
BOTS=(chefe despachante vigia)

[[ -x "$HERDR" ]] || { echo "herdr não encontrado" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq não encontrado" >&2; exit 1; }

model_of() {
  case "$1" in
    chefe) echo opus ;;
    despachante) echo sonnet ;;
    vigia) echo haiku ;;
  esac
}

log() { printf '%s\n' "$*"; }

# Roda um comando que muda estado; no dry-run só mostra.
act() {
  if (( DRY )); then
    printf '[dry-run] %q' "$1"; shift; printf ' %q' "$@"; printf '\n'
  else
    "$@" >/dev/null
  fi
}

# Workspace: o do pane atual, senão o focado.
WS="${HERDR_WORKSPACE_ID:-}"
if [[ -z "$WS" ]]; then
  WS="$("$HERDR" workspace list | jq -r '[.result.workspaces[] | select(.focused)][0].workspace_id // .result.workspaces[0].workspace_id // empty')"
fi
[[ -n "$WS" ]] || { echo "nenhum workspace herdr aberto" >&2; exit 1; }

PANES_JSON="$("$HERDR" pane list --workspace "$WS")"
AGENTS_JSON="$("$HERDR" agent list)"

pane_by_label() { jq -r --arg l "$1" '[.result.panes[] | select(.label == $l)][0].pane_id // empty' <<<"$PANES_JSON"; }
pane_agent() { jq -r --arg p "$1" '[.result.panes[] | select(.pane_id == $p)][0].agent // empty' <<<"$PANES_JSON"; }
agent_named() { jq -r --arg n "$1" '[.result.agents[] | select(.name == $n)][0].pane_id // empty' <<<"$AGENTS_JSON"; }

# Pane de onde os novos saem: o atual, senão o primeiro do workspace.
ANCHOR="${HERDR_PANE_ID:-}"
if [[ -z "$ANCHOR" || "${HERDR_WORKSPACE_ID:-}" != "$WS" ]]; then
  ANCHOR="$(jq -r '.result.panes[0].pane_id // empty' <<<"$PANES_JSON")"
fi

# Sessão fixa do chefe: guardada em $STATE para sobreviver a reinícios.
CHEFE_SESSION_FILE="$STATE/chefe.session-id"
CHEFE_SESSION=""
if [[ -s "$CHEFE_SESSION_FILE" ]]; then
  CHEFE_SESSION="$(tr -d '[:space:]' <"$CHEFE_SESSION_FILE")"
fi
chefe_transcript_exists() {
  local enc
  enc="$(printf '%s' "$HERE/chefe" | sed 's#[/.]#-#g')"
  [[ -n "$CHEFE_SESSION" && -f "$HOME/.claude/projects/$enc/$CHEFE_SESSION.jsonl" ]]
}

claude_args() {
  local bot="$1"
  local args=(--model "$(model_of "$bot")")
  if [[ "$bot" == chefe ]]; then
    if chefe_transcript_exists; then
      args+=(--resume "$CHEFE_SESSION")
    else
      args+=(--session-id "$CHEFE_SESSION")
    fi
  fi
  printf '%s\n' "${args[@]}"
}

# Chefe que ainda vai ser iniciado precisa de sessão conhecida: gera aqui (fora de subshell).
chefe_pane="$(pane_by_label chefe)"
[[ -n "$chefe_pane" ]] || chefe_pane="$(agent_named chefe)"
if [[ -z "$CHEFE_SESSION" && ( -z "$chefe_pane" || "$(pane_agent "$chefe_pane")" != claude ) ]]; then
  CHEFE_SESSION="$(uuidgen | tr '[:upper:]' '[:lower:]')"
fi

log "workspace: $WS (âncora: ${ANCHOR:-nenhuma})"
act mkdir -p "$STATE"

for bot in "${BOTS[@]}"; do
  dir="$HERE/$bot"
  [[ -f "$dir/CLAUDE.md" ]] || { echo "falta $dir/CLAUDE.md" >&2; exit 1; }

  pane="$(pane_by_label "$bot")"
  [[ -n "$pane" ]] || pane="$(agent_named "$bot")"

  if [[ -n "$pane" && "$(pane_agent "$pane")" == claude ]]; then
    log "$bot: adotado ($pane, claude já rodando)"
    act "$HERDR" pane rename "$pane" "$bot"
    continue
  fi

  if [[ -z "$pane" ]]; then
    [[ -n "$ANCHOR" ]] || { echo "sem pane âncora para abrir $bot" >&2; exit 1; }
    log "$bot: criando pane (split de $ANCHOR, cwd $dir)"
    if (( DRY )); then
      act "$HERDR" pane split --pane "$ANCHOR" --direction down --cwd "$dir" --env "JARVIS_BOT=$bot" --no-focus
      pane="<novo-$bot>"
    else
      pane="$("$HERDR" pane split --pane "$ANCHOR" --direction down --cwd "$dir" --env "JARVIS_BOT=$bot" --no-focus | jq -r '.result.pane.pane_id')"
    fi
  else
    log "$bot: pane $pane existe sem claude; iniciando"
    act "$HERDR" pane run "$pane" "export JARVIS_BOT=$bot"
  fi

  args=()
  while IFS= read -r a; do args+=("$a"); done < <(claude_args "$bot")
  act "$HERDR" pane rename "$pane" "$bot"
  log "$bot: claude ${args[*]}"
  act "$HERDR" agent start "$bot" --kind claude --pane "$pane" --timeout 90000 -- "${args[@]}"
done

# Sessão do chefe: grava e garante em voz-sempre.
if [[ -n "$CHEFE_SESSION" ]]; then
  if (( DRY )); then
    log "[dry-run] gravaria $CHEFE_SESSION em $CHEFE_SESSION_FILE"
  else
    printf '%s\n' "$CHEFE_SESSION" >"$CHEFE_SESSION_FILE"
  fi
  if grep -qxF "$CHEFE_SESSION" "$VOZ_SEMPRE" 2>/dev/null; then
    log "voz-sempre: chefe já está ($CHEFE_SESSION)"
  elif (( DRY )); then
    log "[dry-run] acrescentaria $CHEFE_SESSION em $VOZ_SEMPRE"
  else
    mkdir -p "$(dirname "$VOZ_SEMPRE")"
    printf '%s\n' "$CHEFE_SESSION" >>"$VOZ_SEMPRE"
    log "voz-sempre: chefe adicionado ($CHEFE_SESSION)"
  fi
else
  log "aviso: chefe adotado sem sessão conhecida em $CHEFE_SESSION_FILE; voz-sempre não foi alterado" >&2
fi

log "pronto."
