#!/bin/bash
# Primeira execução do Jarvis.app num Mac sem o dashboard instalado: deixa o mínimo de pé para o
# onboarding abrir (Bun, dependências do workspace e o LaunchAgent dev.jarvis.dashboard). O resto
# (modelos, voz, Escuta, MCP, segredos) é escolhido e instalado pela tela /onboarding.
#
# Chamado pelo Jarvis.app com o caminho do repositório; pode rodar à mão: apps/desktop/scripts/primeira-execucao.sh
# Idempotente. Log em ~/.local/share/jarvis/onboarding/primeira-execucao.log (o app mostra o fim dele).
set -euo pipefail

REPO="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
LOG_DIR="$HOME/.local/share/jarvis/onboarding"
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/primeira-execucao.log") 2>&1
echo "=== $(date '+%F %T') primeira execução em $REPO"

[ -f "$REPO/scripts/setup.sh" ] || { echo "Repositório do Jarvis não encontrado em $REPO" >&2; exit 2; }

BUN="$(command -v bun || true)"
[ -n "$BUN" ] || BUN="$HOME/.bun/bin/bun"
if [ ! -x "$BUN" ]; then
	echo "==> Instalando o Bun (https://bun.sh)"
	curl -fsSL https://bun.sh/install | bash
	BUN="$HOME/.bun/bin/bun"
fi
export PATH="$(dirname "$BUN"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "bun $("$BUN" --version)"

echo "==> Dependências do workspace (bun install)"
(cd "$REPO" && "$BUN" install)

echo "==> Dashboard (build e LaunchAgent dev.jarvis.dashboard)"
"$REPO/apps/dashboard/scripts/install-launchagent.sh"
echo "=== pronto: o Jarvis.app abre o onboarding"
