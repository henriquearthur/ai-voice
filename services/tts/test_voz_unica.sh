#!/bin/bash
# Teste da voz única (JARVIS_BOT) e do TTL da fila, sem áudio: o fala-kokoro.sh é trocado por um mock
# (JARVIS_TTS_HOME), lock/log/quadro são privados. Uso: services/tts/test_voz_unica.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; BIN="$HERE/../bin"
D="$(mktemp -d "${TMPDIR:-/tmp}/voz-unica.XXXXXX")"; trap 'rm -rf "$D"' EXIT
export JARVIS_FALA_LOG="$D/fala.log" JARVIS_FALA_LOCK="$D/fala.lock" JARVIS_FALA_CANCEL="$D/fala.cancel" JARVIS_DIR="$D"
export JARVIS_QUADRO_CLI="$HERE/../../packages/quadro/bin/quadro.ts" JARVIS_TTS_HOME="$D/tts"
mkdir "$D/tts"; printf '#!/bin/bash\necho "$1" >> "%s/toques"\n' "$D" >"$D/tts/fala-kokoro.sh"; chmod +x "$D/tts/fala-kokoro.sh"
fail=0; ck() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FALHA $1: esperado [$2] veio [$3]"; fail=1; fi; }
JARVIS_BOT=vigia zsh "$BIN/jarvis-fala" "do vigia"
JARVIS_BOT=chefe zsh "$BIN/jarvis-fala" "do chefe"
echo "sem bot" | env -u JARVIS_BOT zsh "$BIN/jarvis-fala"
ck "so chefe e sem-bot tocam" "do chefe|sem bot" "$(paste -sd'|' "$D/toques")"
ck "vigia vira log" 1 "$(grep -c 'motivo=bot:vigia' "$D/fala.log")"
if command -v bun >/dev/null; then ck "vigia vira evento no quadro" 1 "$(bun "$JARVIS_QUADRO_CLI" msg 2>/dev/null | grep -c 'vigia→chefe	do vigia')"; fi
echo '{"hook_event_name":"Notification","notification_type":"permission_prompt","cwd":"/x"}' | JARVIS_BOT=vigia zsh "$BIN/jarvis-avisa"
echo '{}' | JARVIS_BOT=vigia python3 -I "$BIN/jarvis-fala-resposta"
ck "avisa/resposta calados em bot" 2 "$(paste -sd'|' "$D/toques" | tr '|' '\n' | wc -l | tr -d ' ')"
( /usr/bin/lockf "$D/fala.lock" sleep 3 ) & sleep 0.5
JARVIS_FALA_TTL_S=1 bash "$HERE/fala-kokoro.sh" "espera demais" 2>/dev/null
wait
ck "ttl descarta" 1 "$(grep -c 'motivo=ttl' "$D/fala.log")"
exit $fail
