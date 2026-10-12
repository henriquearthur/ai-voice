#!/bin/bash
# Teste de integração do cancelamento de fila (fala-kokoro.sh + jarvis-cala), com lock, marcador e
# log PRIVADOS (JARVIS_FALA_LOCK/CANCEL/LOG num diretório temporário) e um servidor TTS falso que
# devolve 4 s de silêncio: nada toca de verdade e o fala.lock real não é tocado.
# Uso: services/tts/test_cala.sh   (imprime o fala.log do teste e sai com 0 se tudo passou)
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
D="$(mktemp -d "${TMPDIR:-/tmp}/cala-test.XXXXXX")"
export JARVIS_FALA_LOCK="$D/fala.lock" JARVIS_FALA_CANCEL="$D/fala.cancel" JARVIS_FALA_LOG="$D/fala.log"
export JARVIS_TTS_LABEL=dev.jarvis.teste-inexistente
PORT=$((20000 + RANDOM % 20000))
export AI_VOICE_TTS_URL="http://127.0.0.1:$PORT"
python3 -I - "$PORT" "$D" <<'PY' &
import http.server, struct, sys
rate, secs = 24000, 4
data = b"\0\0" * rate * secs
wav = b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", len(data)) + data
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        self.rfile.read(int(self.headers.get("content-length", 0)))
        self.send_response(200); self.send_header("content-type", "audio/wav"); self.send_header("content-length", str(len(wav))); self.end_headers(); self.wfile.write(wav)
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"{}")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
SRV=$!; disown
trap 'kill $SRV 2>/dev/null; rm -rf "$D"' EXIT
for _ in $(seq 1 30); do curl -sf "$AI_VOICE_TTS_URL/health" >/dev/null && break; sleep 0.1; done

FALA="$HERE/fala-kokoro.sh"
fail=0
check() { if eval "$2"; then echo "ok   - $1"; else echo "FALHA - $1"; fail=1; fi; }

"$FALA" "primeira" & P1=$!
sleep 1.5
"$FALA" "segunda" & P2=$!
"$FALA" "terceira" & P3=$!
sleep 1
"$HERE/jarvis-cala" >"$D/cala.out"
wait $P1; R1=$?; wait $P2; R2=$?; wait $P3; R3=$?
"$FALA" "quarta"; R4=$?

echo "--- fala.log do teste"; cat "$JARVIS_FALA_LOG"
check "1ª cortada (rc=143)" 'grep -q "chars=8 audio_s=[0-9?]* rc=143" "$JARVIS_FALA_LOG" && [ $R1 = 143 ]'
check "2ª e 3ª descartadas (2 linhas)" '[ "$(grep -c "motor=descartada .*motivo=interrompida" "$JARVIS_FALA_LOG")" = 2 ]'
check "descartadas saem com 0 e sem tocar" '[ $R2 = 0 ] && [ $R3 = 0 ]'
check "4ª (nova) toca inteira" 'grep -q "motor=kokoro chars=6 audio_s=4 rc=0" "$JARVIS_FALA_LOG" && [ $R4 = 0 ]'
check "cala encerrou o lockf que segurava" 'grep -q lockf "$D/cala.out"'

# Dono intruso (não é fala do Jarvis) não é morto pelo cala.
: >"$JARVIS_FALA_LOG"
/usr/bin/lockf "$JARVIS_FALA_LOCK" sleep 5 & INT=$!
sleep 0.5
"$HERE/jarvis-cala" >"$D/cala2.out" 2>"$D/cala2.err"
sleep 0.3
check "intruso (lockf sleep) não foi morto" 'kill -0 $INT 2>/dev/null && ! grep -q . "$D/cala2.out"'
check "intruso gerou aviso em stderr" 'grep -q "ignorado" "$D/cala2.err"'
kill $INT 2>/dev/null; pkill -f "sleep 5" -P $INT 2>/dev/null
exit $fail
