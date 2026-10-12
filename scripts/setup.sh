#!/usr/bin/env bash
# Setup do Jarvis num Mac: um comando só, idempotente (pode rodar de novo a qualquer hora para atualizar).
#
#   ./scripts/setup.sh             instala tudo o que é padrão
#   ./scripts/setup.sh --dry-run   só mostra o que faria, sem instalar nem reiniciar nada
#
# O que faz, nesta ordem:
#   1. confere os pré-requisitos (macOS, Bun, Xcode Command Line Tools/swift, Python 3.12 ou uv);
#   2. bun install;
#   3. servidor local de voz Kokoro em ~/.local/share/jarvis/tts (venv + modelo, só Apple Silicon);
#   4. comandos em ~/.local/bin: jarvis-fala, jarvis-fala-resposta, jarvis-avisa e jarvis-mcp-stdio;
#   5. LaunchAgents do usuário atual: dev.jarvis.tts, dev.jarvis.dashboard, dev.jarvis.escuta
#      e, só com --com-grok, dev.jarvis.callback;
#   6. registra o MCP "ai-voice" no Claude Code (escopo user), se o `claude` existir;
#   7. imprime o que ainda precisa ser feito à mão.
#
# Ajustes ficam em ~/.config/jarvis/jarvis.env (criado na primeira vez). Variáveis de ambiente
# com o mesmo nome valem mais que o arquivo, e o arquivo é regravado com o valor final.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${JARVIS_CONFIG:-$HOME/.config/jarvis/jarvis.env}"
DATA="$HOME/.local/share/jarvis"
TTS_HOME="${JARVIS_TTS_HOME:-$DATA/tts}"
BIN_DIR="$HOME/.local/bin"
AGENTS_DIR="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"

DRY=0 ECHO=0 GROK=0 ESCUTA=auto VOZ=1 DASHBOARD=1 MCP=1 ASK=1
usage() {
	cat <<'EOF'
Uso: scripts/setup.sh [opções]

  --dry-run        mostra o que faria, sem instalar, gravar ou reiniciar nada
  --com-echo       usa também a Echo (Amazon): pergunta o marketplace e o serial da Echo padrão
  --com-grok       instala o servidor de callback do Grok Bot (dev.jarvis.callback)
  --com-escuta     instala a escuta por voz mesmo sem o herdr no PATH
  --sem-escuta     não instala a escuta por voz
  --sem-voz        não instala o servidor de voz Kokoro (a fala usa o `say` do macOS)
  --sem-dashboard  não instala o dashboard como LaunchAgent
  --sem-mcp        não registra o MCP no Claude Code
  --sim, -y        não pergunta nada; usa o arquivo de config, o ambiente e os padrões
  -h, --help       esta ajuda
EOF
}
while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run) DRY=1 ;;
	--com-echo) ECHO=1 ;;
	--com-grok) GROK=1 ;;
	--com-escuta) ESCUTA=1 ;;
	--sem-escuta) ESCUTA=0 ;;
	--sem-voz) VOZ=0 ;;
	--sem-dashboard) DASHBOARD=0 ;;
	--sem-mcp) MCP=0 ;;
	--sim | -y) ASK=0 ;;
	-h | --help) usage; exit 0 ;;
	*) echo "Opção desconhecida: $1" >&2; usage >&2; exit 2 ;;
	esac
	shift
done
[ -t 0 ] || ASK=0

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '    \033[33maviso:\033[0m %s\n' "$*" >&2; }
run() {
	if [ "$DRY" = 1 ]; then
		printf '    [dry-run] %s\n' "$*"
	else
		"$@"
	fi
}
TODO=()
todo() { TODO+=("$*"); }

# ---------------------------------------------------------------- 1. pré-requisitos
step "Pré-requisitos"
missing=0
if [ "$(uname -s)" != "Darwin" ]; then
	echo "O Jarvis instala serviços do macOS (launchd, EventKit, Speech); este sistema não é macOS." >&2
	exit 1
fi
MACOS="$(sw_vers -productVersion)"
MACOS_MAJOR="${MACOS%%.*}"
info "macOS $MACOS ($(uname -m))"

BUN="$(command -v bun || true)"
[ -n "$BUN" ] || { [ -x "$HOME/.bun/bin/bun" ] && BUN="$HOME/.bun/bin/bun"; }
if [ -z "$BUN" ]; then
	warn "falta o Bun 1.3+: curl -fsSL https://bun.sh/install | bash"
	missing=1
else
	info "bun $("$BUN" --version) em $BUN"
fi

if ! xcode-select -p >/dev/null 2>&1 || ! command -v swift >/dev/null; then
	warn "faltam as Xcode Command Line Tools (swift), usadas pelo helper do Calendário e pela escuta: xcode-select --install"
	missing=1
else
	info "$(swift --version 2>/dev/null | head -n 1)"
fi

if [ "$VOZ" = 1 ]; then
	if [ "$(uname -m)" != "arm64" ]; then
		warn "este Mac não é Apple Silicon: o servidor Kokoro fica de fora e a fala usa o \`say\` do macOS"
		VOZ=0
	elif command -v uv >/dev/null; then
		info "uv $(uv --version | cut -d' ' -f2) (baixa o Python 3.12 do servidor de voz)"
	elif command -v python3.12 >/dev/null || python3 -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 1)' 2>/dev/null; then
		info "Python 3.12 encontrado"
	else
		warn "o servidor de voz precisa de Python 3.12: brew install uv (recomendado) ou brew install python@3.12; ou rode com --sem-voz"
		missing=1
	fi
fi

command -v jq >/dev/null || todo "Instale o jq (brew install jq) se for usar o hook jarvis-avisa do Claude Code."
CLAUDE="$(command -v claude || true)"
[ -n "$CLAUDE" ] || { [ -x "$HOME/.local/bin/claude" ] && CLAUDE="$HOME/.local/bin/claude"; }

HERDR="$(command -v herdr || true)"
[ -n "$HERDR" ] || { [ -x "$HOME/.local/bin/herdr" ] && HERDR="$HOME/.local/bin/herdr"; }
if [ "$ESCUTA" != 0 ] && [ "$MACOS_MAJOR" -lt 26 ]; then
	warn "a escuta por voz precisa do macOS 26 ou mais novo (SpeechAnalyzer); fica de fora"
	ESCUTA=0
fi
if [ "$ESCUTA" = auto ]; then
	if [ -n "$HERDR" ]; then
		ESCUTA=1
	else
		ESCUTA=0
		todo "A escuta por voz não foi instalada: ela entrega os pedidos a uma sessão do herdr, que não está instalado. Com o herdr, rode o setup de novo (ou use --com-escuta)."
	fi
fi

if [ "$missing" = 1 ]; then
	if [ "$DRY" = 1 ]; then
		warn "faltam pré-requisitos (acima); no modo de verdade o setup pararia aqui"
	else
		echo "Instale o que falta (acima) e rode o setup de novo." >&2
		exit 1
	fi
fi

# ---------------------------------------------------------------- configuração
step "Configuração ($CONFIG)"
CONFIG_KEYS=(AI_VOICE_LOCALE AI_VOICE_AMAZON_PAGE AI_VOICE_OUTPUT AI_VOICE_DEFAULT_DEVICE AI_VOICE_TTS_VOICE
	JARVIS_CALLBACK_PORT ESCUTA_PANE ESCUTA_ORQUESTRADOR ESCUTA_MIC)
# Lê só as chaves conhecidas do arquivo, sem sobrescrever o que já veio do ambiente.
load_config() {
	[ -f "$CONFIG" ] || return 0
	local line key value
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in '' | '#'*) continue ;; esac
		key="${line%%=*}"
		value="${line#*=}"
		value="${value#\"}"
		value="${value%\"}"
		case " ${CONFIG_KEYS[*]} " in *" $key "*) ;; *) continue ;; esac
		[ -n "${!key+x}" ] || printf -v "$key" '%s' "$value"
	done <"$CONFIG"
}
load_config

ask() { # ask VAR "pergunta" — só pergunta em terminal interativo, sem --sim
	local var="$1" prompt="$2" answer
	[ "$ASK" = 1 ] || return 0
	read -r -p "    $prompt [${!var}]: " answer || true
	[ -z "$answer" ] || printf -v "$var" '%s' "$answer"
}

: "${AI_VOICE_LOCALE:=pt-BR}"
: "${AI_VOICE_AMAZON_PAGE:=amazon.com.br}"
: "${AI_VOICE_OUTPUT:=mac}"
: "${AI_VOICE_DEFAULT_DEVICE:=}"
: "${AI_VOICE_TTS_VOICE:=pf_dora}"
: "${JARVIS_CALLBACK_PORT:=7348}"
: "${ESCUTA_PANE:=}"
: "${ESCUTA_ORQUESTRADOR:=}"
: "${ESCUTA_MIC:=}"

if [ "$ECHO" = 1 ]; then
	ask AI_VOICE_AMAZON_PAGE "Marketplace da Amazon da sua conta (amazon.com.br, amazon.com, amazon.co.uk...)"
	ask AI_VOICE_DEFAULT_DEVICE "Serial da Echo padrão (vazio = decidir depois; veja com: bun apps/mcp/src/main.ts devices)"
	ask AI_VOICE_OUTPUT "Onde falar por padrão: mac ou echo"
fi
case "$AI_VOICE_OUTPUT" in mac | echo) ;; *) echo "AI_VOICE_OUTPUT precisa ser mac ou echo (veio: $AI_VOICE_OUTPUT)" >&2; exit 2 ;; esac
if [ "$ESCUTA" = 1 ]; then
	ask ESCUTA_ORQUESTRADOR "Nome do agente do herdr que recebe os pedidos falados"
	ask ESCUTA_MIC "Parte do nome do microfone preferido (vazio = o embutido)"
fi

for k in "${CONFIG_KEYS[@]}"; do
	case "${!k}" in *[\"\$\`\\]*) echo "Valor inválido em $k: sem aspas, \$, crase ou barra invertida." >&2; exit 2 ;; esac
	info "$k=${!k}"
done
NEW_CONFIG="$(mktemp)"
trap 'rm -f "$NEW_CONFIG"' EXIT
{
	echo "# Ajustes do Jarvis neste Mac. Gerado e mantido pelo scripts/setup.sh; pode editar à mão."
	echo "# Os instaladores (setup, dashboard e escuta) leem este arquivo. Sem segredos aqui:"
	echo "# a sessão da Amazon fica em ~/.local/share/ai-voice e as chaves do Grok Bot no Keychain."
	for k in "${CONFIG_KEYS[@]}"; do printf '%s="%s"\n' "$k" "${!k}"; done
} >"$NEW_CONFIG"
if cmp -s "$NEW_CONFIG" "$CONFIG"; then
	info "config já está em dia"
else
	run mkdir -p "$(dirname "$CONFIG")"
	run install -m 600 "$NEW_CONFIG" "$CONFIG"
fi
# Os instaladores filhos leem o mesmo arquivo; no dry-run ele ainda não existe, então vai pelo ambiente.
for k in "${CONFIG_KEYS[@]}"; do export "${k?}"; done
export JARVIS_CONFIG="$CONFIG"

# ---------------------------------------------------------------- helpers de instalação
xml() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
sed_value() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }

# render MODELO DESTINO MODO: troca os @MARCADORES@ e grava só se mudou. Devolve 0 se gravou (ou gravaria).
render() {
	local template="$1" dest="$2" mode="$3" out args=() k v
	out="$(mktemp)"
	for k in REPO BUN DATA TTS_HOME "${CONFIG_KEYS[@]}"; do
		v="${!k}"
		case "$dest" in *.plist) v="$(xml "$v")" ;; esac
		args+=(-e "s|@$k@|$(sed_value "$v")|g")
	done
	sed "${args[@]}" "$template" >"$out"
	if grep -q '@[A-Z_]*@' "$out"; then
		echo "Sobrou marcador sem valor em $template" >&2
		rm -f "$out"
		exit 1
	fi
	case "$dest" in *.plist) plutil -lint "$out" >/dev/null ;; esac
	if cmp -s "$out" "$dest"; then
		rm -f "$out"
		return 1
	fi
	if [ "$DRY" = 1 ]; then
		info "[dry-run] gravaria $dest:"
		diff -u "$dest" "$out" 2>/dev/null | sed 's/^/      /' | head -n 40 || true
		[ -f "$dest" ] || sed 's/^/      /' "$out" | head -n 40
		rm -f "$out"
	else
		mkdir -p "$(dirname "$dest")"
		install -m "$mode" "$out" "$dest"
		rm -f "$out"
		info "gravado $dest"
	fi
	return 0
}

# load_agent LABEL [mudou]: (re)carrega o LaunchAgent; com "mudou", descarrega antes e espera sumir.
load_agent() {
	local label="$1" changed="${2:-}" plist="$AGENTS_DIR/$1.plist"
	if [ "$DRY" = 1 ]; then
		info "[dry-run] launchctl bootout/bootstrap $DOMAIN/$label (só se o plist mudou ou não está carregado)"
		return 0
	fi
	if [ -n "$changed" ]; then
		launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
		for _ in $(seq 1 50); do launchctl print "$DOMAIN/$label" >/dev/null 2>&1 || break; sleep 0.2; done
	fi
	if ! launchctl print "$DOMAIN/$label" >/dev/null 2>&1; then
		# O bootout é assíncrono: mesmo após o print falhar, o bootstrap pode dar "Bootstrap failed: 5".
		local carregado=0 tentativa
		for tentativa in 1 2 3 4 5; do
			if launchctl bootstrap "$DOMAIN" "$plist"; then
				carregado=1
				break
			fi
			if [ "$tentativa" -lt 5 ]; then sleep 1; fi
		done
		if [ "$carregado" != 1 ]; then
			echo "Falha ao carregar $label após 5 tentativas de launchctl bootstrap." >&2
			exit 1
		fi
		info "$label carregado"
	else
		info "$label já está no ar"
	fi
}

# install_file ORIGEM DESTINO: copia se mudou; guarda um .bak de um arquivo diferente que já estava lá.
install_file() {
	local src="$1" dest="$2"
	cmp -s "$src" "$dest" && { info "$dest já está em dia"; return 0; }
	if [ -e "$dest" ] && [ ! -L "$dest" ]; then
		run cp -p "$dest" "$dest.bak"
		info "o $dest anterior ficou em $dest.bak"
	fi
	run install -m 755 "$src" "$dest"
}

# ---------------------------------------------------------------- 2. dependências
step "Dependências (bun install)"
if [ -n "$BUN" ]; then
	(cd "$REPO" && run "$BUN" install)
else
	info "[dry-run] bun install (falta o Bun)"
	BUN="$HOME/.bun/bin/bun"
fi

# ---------------------------------------------------------------- 3. voz local
if [ "$VOZ" = 1 ]; then
	step "Servidor de voz (Kokoro)"
	if [ "$DRY" = 1 ]; then
		JARVIS_TTS_HOME="$TTS_HOME" "$REPO/services/tts/install.sh" --dry-run
	else
		JARVIS_TTS_HOME="$TTS_HOME" "$REPO/services/tts/install.sh"
	fi
	if render "$REPO/services/launchd/dev.jarvis.tts.plist.in" "$AGENTS_DIR/dev.jarvis.tts.plist" 644; then
		load_agent dev.jarvis.tts mudou
	else
		load_agent dev.jarvis.tts
	fi
else
	todo "Sem o servidor Kokoro, a fala no Mac usa \`say -v Luciana\`. Para instalar depois: scripts/setup.sh (num Mac Apple Silicon, com uv ou Python 3.12)."
fi

# ---------------------------------------------------------------- 4. comandos
step "Comandos em $BIN_DIR"
run mkdir -p "$BIN_DIR"
for f in jarvis-fala jarvis-fala-resposta jarvis-avisa; do
	install_file "$REPO/services/bin/$f" "$BIN_DIR/$f"
done
render "$REPO/services/bin/jarvis-mcp-stdio.in" "$BIN_DIR/jarvis-mcp-stdio" 700 || info "$BIN_DIR/jarvis-mcp-stdio já está em dia"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) todo "Ponha $BIN_DIR no PATH (ex.: echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc)." ;; esac

# ---------------------------------------------------------------- 5. LaunchAgents
if [ "$DASHBOARD" = 1 ]; then
	step "Dashboard (dev.jarvis.dashboard, http://127.0.0.1:7350)"
	if [ "$DRY" = 1 ]; then
		info "[dry-run] apps/dashboard/scripts/install-launchagent.sh  (build, helper do Calendário, plist e restart)"
	else
		"$REPO/apps/dashboard/scripts/install-launchagent.sh"
	fi
fi

if [ "$ESCUTA" = 1 ]; then
	step "Escuta por voz (dev.jarvis.escuta)"
	if [ "$DRY" = 1 ]; then
		info "[dry-run] apps/escuta/scripts/instalar.sh --carregar  (swift build, Escuta.app e LaunchAgent)"
	else
		"$REPO/apps/escuta/scripts/instalar.sh" --carregar
	fi
fi

if [ "$GROK" = 1 ]; then
	step "Callback do Grok Bot (dev.jarvis.callback, 127.0.0.1:$JARVIS_CALLBACK_PORT)"
	run mkdir -p "$DATA/callback/logs"
	if render "$REPO/services/launchd/dev.jarvis.callback.plist.in" "$AGENTS_DIR/dev.jarvis.callback.plist" 644; then
		load_agent dev.jarvis.callback mudou
	else
		load_agent dev.jarvis.callback
	fi
fi

# ---------------------------------------------------------------- 6. MCP no Claude Code
if [ "$MCP" = 1 ]; then
	step "MCP no Claude Code"
	if [ -z "$CLAUDE" ]; then
		todo "O Claude Code não foi encontrado; depois de instalar, rode o setup de novo para registrar o MCP (ou veja o README para Codex e outros clientes)."
	elif "$CLAUDE" mcp get ai-voice >/dev/null 2>&1; then
		info "o MCP ai-voice já está registrado (para refazer: claude mcp remove ai-voice -s user e rode o setup de novo)"
	else
		mcp_env=(--env AI_VOICE_ENABLE_SPEECH=1 --env "AI_VOICE_LOCALE=$AI_VOICE_LOCALE"
			--env "AI_VOICE_AMAZON_PAGE=$AI_VOICE_AMAZON_PAGE" --env "AI_VOICE_OUTPUT=$AI_VOICE_OUTPUT"
			--env "AI_VOICE_TTS_VOICE=$AI_VOICE_TTS_VOICE")
		[ -z "$AI_VOICE_DEFAULT_DEVICE" ] || mcp_env+=(--env "AI_VOICE_DEFAULT_DEVICE=$AI_VOICE_DEFAULT_DEVICE")
		run "$CLAUDE" mcp add ai-voice -s user "${mcp_env[@]}" -- "$BIN_DIR/jarvis-mcp-stdio"
	fi
fi

# ---------------------------------------------------------------- 7. o que falta à mão
todo "Permissões do macOS (aparecem no primeiro uso; se negar, vá em Ajustes do Sistema > Privacidade e Segurança): Calendários e Lembretes para o dashboard e o MCP, Automação para o osascript, e, na escuta, Microfone e Reconhecimento de Fala."
if [ "$ECHO" = 1 ]; then
	if [ -f "${AI_VOICE_STATE_DIR:-$HOME/.local/share/ai-voice}/session.json" ]; then
		[ -n "$AI_VOICE_DEFAULT_DEVICE" ] || todo "Escolha a Echo padrão: bun apps/mcp/src/main.ts devices, ponha o serial em AI_VOICE_DEFAULT_DEVICE no $CONFIG e rode o setup de novo."
	else
		todo "Entre na Amazon para usar a Echo: AI_VOICE_AMAZON_PAGE=$AI_VOICE_AMAZON_PAGE bun apps/mcp/src/main.ts login e abra http://127.0.0.1:3456/ (a senha vai só no navegador). Depois: bun apps/mcp/src/main.ts devices, ponha o serial em AI_VOICE_DEFAULT_DEVICE no $CONFIG e rode o setup de novo."
	fi
else
	todo "Echo (opcional, desligada): rode o setup com --com-echo para entrar na Amazon e escolher a Echo."
fi
if [ "$GROK" = 1 ]; then
	todo "Grok Bot: grave os segredos no Keychain (nunca em arquivo): security add-generic-password -a jarvis -s jarvis-grokbot-webhook-url -w   e   security add-generic-password -a jarvis -s jarvis-grokbot-key -w  (cada um pede o valor)."
	todo "Grok Bot: a URL local do callback (com o token) sai de: bun apps/mcp/src/callback-main.ts --print-url. Para o Grok alcançar o Mac, publique a porta $JARVIS_CALLBACK_PORT com o Tailscale Funnel (tailscale funnel --bg $JARVIS_CALLBACK_PORT) e use https://<sua-máquina>.<seu-tailnet>.ts.net/mcp/<token> no conector."
else
	todo "Grok Bot e Funnel (opcionais, desligados): rode o setup com --com-grok."
fi
todo "Hooks de voz do Claude Code (opcionais): no ~/.claude/settings.json, ponha ~/.local/bin/jarvis-avisa nos hooks Notification e Stop (async) e ~/.local/bin/jarvis-fala-resposta no Stop. Veja o README."
[ -z "$CLAUDE" ] || [ "$MCP" = 0 ] || todo "Reinicie as sessões abertas do Claude Code para elas verem o MCP ai-voice."

step "Pronto$([ "$DRY" = 1 ] && echo " (dry-run: nada foi alterado)")"
bold "Falta fazer à mão:"
for t in "${TODO[@]}"; do printf '  - %s\n' "$t"; done
