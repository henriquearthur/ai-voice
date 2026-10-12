#!/usr/bin/env bash
# Instala ou atualiza o servidor local de voz (Kokoro-82M via mlx-audio) em $JARVIS_TTS_HOME
# (padrão ~/.local/share/jarvis/tts): copia server.py, normaliza.py e fala-kokoro.sh (e o jarvis-cala em ~/.local/bin), cria o venv Python com as
# versões travadas em requirements.lock.txt e baixa o modelo com só as vozes pt-BR (~330 MB).
#
# Idempotente: o venv só é refeito quando o lock muda, e o modelo só é baixado se faltar.
# O LaunchAgent dev.jarvis.tts é gravado e carregado pelo scripts/setup.sh.
#
# Uso: services/tts/install.sh [--dry-run]
# Precisa de Mac com Apple Silicon (o MLX não roda em Intel) e de Python 3.12 (o lock pede 3.12 e o
# mlx-audio ainda não aceita 3.13+). Com o `uv` instalado, ele baixa o Python certo sozinho.
set -euo pipefail

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TTS_HOME="${JARVIS_TTS_HOME:-$HOME/.local/share/jarvis/tts}"
VENV="$TTS_HOME/.venv"
MODEL_REPO="mlx-community/Kokoro-82M-bf16"
# Revisão fixa do modelo validada com o requirements.lock.txt.
MODEL_REVISION="a71e4d38b236d968966a2002c4c895dbd12b1c3c"
MODEL_DIR="$TTS_HOME/models/kokoro-82m-bf16"

say_step() { printf '==> %s\n' "$*"; }
run() {
	if [ "$DRY" = 1 ]; then
		printf '    [dry-run] %s\n' "$*"
	else
		"$@"
	fi
}

if [ "$(uname -m)" != "arm64" ]; then
	echo "O servidor Kokoro precisa de Apple Silicon; neste Mac a voz fica com o \`say\` do macOS." >&2
	exit 3
fi

# Python 3.12: o uv resolve sozinho; sem ele, procura um no PATH.
python_ok() { "$1" -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)' 2>/dev/null; }
UV="$(command -v uv || true)"
PY=""
if [ -z "$UV" ]; then
	for cand in python3.12 python3; do
		p="$(command -v "$cand" || true)"
		if [ -n "$p" ] && python_ok "$p"; then PY="$p"; break; fi
	done
	if [ -z "$PY" ]; then
		echo "Falta Python 3.12 para o servidor de voz. Instale o uv (brew install uv) ou python@3.12 (brew install python@3.12) e rode de novo." >&2
		exit 1
	fi
fi

say_step "Servidor de voz em $TTS_HOME"
run mkdir -p "$TTS_HOME/logs" "$TTS_HOME/models" "$TTS_HOME/hf-cache"
for f in server.py normaliza.py requirements.lock.txt; do
	cmp -s "$SRC/$f" "$TTS_HOME/$f" 2>/dev/null || run install -m 644 "$SRC/$f" "$TTS_HOME/$f"
done
cmp -s "$SRC/fala-kokoro.sh" "$TTS_HOME/fala-kokoro.sh" 2>/dev/null || run install -m 755 "$SRC/fala-kokoro.sh" "$TTS_HOME/fala-kokoro.sh"
# jarvis-cala: o comando único que interrompe a fala e limpa a fila (fica no PATH, ao lado do jarvis-fala).
BIN_DIR="${JARVIS_BIN_DIR:-$HOME/.local/bin}"
run mkdir -p "$BIN_DIR"
cmp -s "$SRC/jarvis-cala" "$BIN_DIR/jarvis-cala" 2>/dev/null || run install -m 755 "$SRC/jarvis-cala" "$BIN_DIR/jarvis-cala"

LOCK_SUM="$(shasum -a 256 "$SRC/requirements.lock.txt" | cut -d' ' -f1)"
STAMP="$VENV/.jarvis-lock.sha256"
# O venv vale se tem exatamente os pacotes do lock (cobre um venv criado à mão, sem o carimbo).
venv_matches_lock() {
	"$VENV/bin/python" -I -c '
import importlib.metadata as m, re, sys
have = {re.sub(r"[-_.]+", "-", d.metadata["Name"]).lower() + "==" + d.version for d in m.distributions()}
want = {l.strip() for l in open(sys.argv[1]) if l.strip() and not l.startswith("#")}
sys.exit(0 if have == want else 1)
' "$SRC/requirements.lock.txt" 2>/dev/null
}
if [ -x "$VENV/bin/python" ] && python_ok "$VENV/bin/python" &&
	{ [ "$(cat "$STAMP" 2>/dev/null)" = "$LOCK_SUM" ] || venv_matches_lock; }; then
	echo "venv já está em dia"
	[ "$DRY" = 1 ] || [ "$(cat "$STAMP" 2>/dev/null)" = "$LOCK_SUM" ] || echo "$LOCK_SUM" >"$STAMP"
else
	say_step "Criando o venv com as versões travadas"
	run rm -rf "$VENV"
	if [ -n "$UV" ]; then
		run "$UV" venv --python 3.12 "$VENV"
		run "$UV" pip install --python "$VENV/bin/python" -r "$SRC/requirements.lock.txt"
	else
		run "$PY" -m venv "$VENV"
		run "$VENV/bin/python" -m pip install --quiet --upgrade pip
		run "$VENV/bin/python" -m pip install --quiet -r "$SRC/requirements.lock.txt"
	fi
	if [ "$DRY" = 1 ]; then
		printf '    [dry-run] echo %s > %s\n' "$LOCK_SUM" "$STAMP"
	else
		echo "$LOCK_SUM" >"$STAMP"
	fi
fi

if [ -s "$MODEL_DIR/kokoro-v1_0.safetensors" ] && compgen -G "$MODEL_DIR/voices/p*.safetensors" >/dev/null; then
	echo "modelo já baixado"
else
	say_step "Baixando $MODEL_REPO (só as vozes pt-BR)"
	run env HF_HOME="$TTS_HOME/hf-cache" HF_HUB_OFFLINE=0 HF_HUB_DISABLE_TELEMETRY=1 "$VENV/bin/python" -I -c '
import sys
from huggingface_hub import snapshot_download
snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3],
                  allow_patterns=["config.json", "kokoro-v1_0.safetensors", "voices/p*.safetensors", "*.md"])
' "$MODEL_REPO" "$MODEL_REVISION" "$MODEL_DIR"
fi

[ "$DRY" = 1 ] || echo "Servidor de voz instalado. Teste depois do setup: curl -s http://127.0.0.1:7349/health"
