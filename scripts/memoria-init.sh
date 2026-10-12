#!/bin/bash
# Cria os templates da memória do Jarvis em ${JARVIS_DIR:-~/.jarvis}/memoria/ sem sobrescrever nada.
# Entradas separadas por "\n§\n". Limites: coletivo 8000, fernando 1500, bots/<nome> 2200 caracteres.
set -e
M="${JARVIS_DIR:-$HOME/.jarvis}/memoria"
mkdir -p "$M/bots"
novo() { [ -e "$1" ] || { printf '%s\n' "$2" > "$1"; echo "criado: $1"; }; }
novo "$M/coletivo.md" "<!-- Memória coletiva. Só o Chefe escreve. Limite: 8000 caracteres. Entradas separadas por uma linha com § -->"
novo "$M/fernando.md" "<!-- Perfil do dono. Só o Fernando e o Chefe escrevem. Limite: 1500 caracteres. Entradas separadas por uma linha com § -->"
for b in "$@"; do
  b="$(printf '%s' "$b" | tr -cd 'A-Za-z0-9._-')"
  [ -n "$b" ] && novo "$M/bots/$b.md" "<!-- Caderno do bot $b. Limite: 2200 caracteres. Entradas separadas por uma linha com § -->"
done
echo "memória em $M"
