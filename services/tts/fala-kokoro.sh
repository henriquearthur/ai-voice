#!/bin/bash
# Cliente do servidor local de TTS (Kokoro). Uso: fala-kokoro.sh "texto" [voz]
# Sintetiza no servidor local (AI_VOICE_TTS_URL, padrão http://127.0.0.1:7349) e toca com afplay;
# se o servidor estiver fora do ar, sobe o LaunchAgent dev.jarvis.tts e tenta de novo; só se ainda
# falhar (ou passar de 10 s) cai para `say -v $AI_VOICE_MAC_VOICE` (padrão Luciana).
# Serializa a fala com lockf no mesmo arquivo que o servidor MCP usa (JARVIS_FALA_LOCK, ou
# AI_VOICE_MAC_LOCK por compatibilidade).
# Cancelamento de fila: antes de esperar o lock a fala anota o conteúdo do marcador fala.cancel
# (JARVIS_FALA_CANCEL, padrão ao lado do lock). O `jarvis-cala` regrava o marcador; ao conseguir o
# lock, quem encontra o marcador diferente do que anotou foi interrompido na fila: não toca, só
# registra motor=descartada no fala.log. Falas que entram depois do cala tocam normalmente.
set -u

TEXT="${1:-}"
VOICE="${2:-${JARVIS_TTS_VOICE:-pf_dora}}"
[ -n "$TEXT" ] || { echo "uso: $0 \"texto\" [voz]" >&2; exit 2; }

TTS_URL="${AI_VOICE_TTS_URL:-http://127.0.0.1:7349}"
MAC_VOICE="${AI_VOICE_MAC_VOICE:-Luciana}"
LOCK="${JARVIS_FALA_LOCK:-${AI_VOICE_MAC_LOCK:-$HOME/.local/share/jarvis/fala.lock}}"
CANCEL="${JARVIS_FALA_CANCEL:-$(dirname "$LOCK")/fala.cancel}"
mkdir -p "$(dirname "$LOCK")"

# Reentra sob o lock (mesmo lock do jarvis-fala). O -t limita só a espera na fila por quem
# ainda não tem o lock (sai com 75, EX_TEMPFAIL); quem já o segura toca até o fim, sem prazo.
# TTL da fila: fala que espera mais de JARVIS_FALA_TTL_S (60 s) pelo lock é descartada e registrada.
if [ -z "${JARVIS_FALA_LOCKED:-}" ]; then
  TTL="${JARVIS_FALA_TTL_S:-60}"
  JARVIS_FALA_ENTRY="$(cat "$CANCEL" 2>/dev/null)" JARVIS_FALA_LOCKED=1 /usr/bin/lockf -t "$TTL" "$LOCK" "$0" "$@"
  RC=$?
  if [ "$RC" -eq 75 ]; then
    LOG="${JARVIS_FALA_LOG:-$HOME/.local/share/jarvis/tts/logs/fala.log}"
    mkdir -p "$(dirname "$LOG")" 2>/dev/null
    printf '%s pid=%s motor=descartada chars=%s audio_s=0 rc=0 dur_s=%s motivo=ttl\n' \
      "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "${#TEXT}" "$TTL" >>"$LOG" 2>/dev/null
    exit 0
  fi
  exit "$RC"
fi

# Uma linha por fala em FALA_LOG: quanto áudio havia e como o tocador terminou. Código 143 é
# SIGTERM (o barge-in da escuta, ou outro processo que segura o mesmo lock); 0 é fala inteira.
FALA_LOG="${JARVIS_FALA_LOG:-$HOME/.local/share/jarvis/tts/logs/fala.log}"
T0=$(date +%s)
registra() {
  mkdir -p "$(dirname "$FALA_LOG")" 2>/dev/null
  printf '%s pid=%s motor=%s chars=%s audio_s=%s rc=%s dur_s=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$1" "${#TEXT}" "$2" "$3" "$(( $(date +%s) - T0 ))" \
    >>"$FALA_LOG" 2>/dev/null
}
# Cancelada na fila (o marcador mudou desde que esta fala entrou): não toca.
if [ -n "${JARVIS_FALA_ENTRY+x}" ] && [ "$(cat "$CANCEL" 2>/dev/null)" != "$JARVIS_FALA_ENTRY" ]; then
  mkdir -p "$(dirname "$FALA_LOG")" 2>/dev/null
  printf '%s pid=%s motor=descartada chars=%s audio_s=0 rc=0 dur_s=%s motivo=interrompida\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "${#TEXT}" "$(( $(date +%s) - T0 ))" >>"$FALA_LOG" 2>/dev/null
  exit 0
fi

TMP="$(mktemp -t jarvis-tts).wav" || exit 1
trap 'rm -f "$TMP" "${TMP%.wav}"' EXIT

json_str() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"; s="${s//$'\r'/\\r}"; s="${s//$'\t'/\\t}"
  s="$(printf '%s' "$s" | LC_ALL=C tr -d '\000-\010\013\014\016-\037')"
  printf '"%s"' "$s"
}
BODY="{\"text\":$(json_str "$TEXT"),\"voice\":$(json_str "$VOICE")}"

trap 'registra "${MOTOR:-?}" "${AUDIO_S:-?}" 143; exit 143' TERM

sintetiza() {
  /usr/bin/curl -sf --max-time 10 \
    -H 'Content-Type: application/json' \
    --data-binary "$BODY" \
    -o "$TMP" "${TTS_URL%/}/synthesize" \
    && [ -s "$TMP" ]
}

# Servidor fora do ar (LaunchAgent descarregado por uma reinstalação, ou morto): sobe o
# dev.jarvis.tts e espera o /health antes de desistir do Kokoro, em vez de cair direto no say.
TTS_LABEL="${JARVIS_TTS_LABEL:-dev.jarvis.tts}"
TTS_PLIST="$HOME/Library/LaunchAgents/$TTS_LABEL.plist"
sobe_servidor() {
  local dom="gui/$(id -u)" i
  if /bin/launchctl print "$dom/$TTS_LABEL" >/dev/null 2>&1; then
    /bin/launchctl kickstart "$dom/$TTS_LABEL" >/dev/null 2>&1
  elif [ -f "$TTS_PLIST" ]; then
    /bin/launchctl bootstrap "$dom" "$TTS_PLIST" >/dev/null 2>&1
  else
    return 1
  fi
  for i in $(seq 1 "${JARVIS_TTS_ESPERA_S:-20}"); do
    /usr/bin/curl -sf --max-time 1 "${TTS_URL%/}/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

if sintetiza || { ! /usr/bin/curl -sf --max-time 2 "${TTS_URL%/}/health" >/dev/null 2>&1 \
                  && sobe_servidor && sintetiza; }; then
  MOTOR=kokoro
  # WAV mono 16 bits a 24 kHz com cabeçalho de 44 bytes.
  AUDIO_S=$(( ($(stat -f %z "$TMP") - 44) / 48000 ))
  /usr/bin/afplay "$TMP"
else
  MOTOR=say AUDIO_S=?
  /usr/bin/say -v "$MAC_VOICE" -- "$TEXT"
fi
RC=$?
registra "$MOTOR" "$AUDIO_S" "$RC"
exit "$RC"
