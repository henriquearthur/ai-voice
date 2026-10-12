#!/bin/bash
# Compila o app nativo do Jarvis (casca WKWebView do dashboard), monta o Jarvis.app, assina e instala.
# Uso: apps/desktop/scripts/instalar.sh [--nao-abrir]
#
# Destino: ~/Applications/Jarvis.app. Se ali já estiver o web app do Safari (com.apple.Safari.WebApp.*),
# ele não é tocado e o app vai para ~/Applications/Jarvis Desktop/Jarvis.app. JARVIS_APP_DEST força outro caminho.
# Assinatura: JARVIS_SIGNING_IDENTITY, senão "Jarvis Local Signing" (a mesma da escuta), senão qualquer identidade
# com "Jarvis" no nome; sem nenhuma, assina ad hoc (o macOS pode pedir permissões de novo a cada build).
set -euo pipefail

cd "$(dirname "$0")/.."
PKG="$PWD"
BUNDLE_ID="dev.jarvis.desktop"

is_safari_webapp() {
  [ -f "$1/Contents/Info.plist" ] &&
    /usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$1/Contents/Info.plist" 2>/dev/null | grep -q '^com\.apple\.Safari\.WebApp'
}

DEST="${JARVIS_APP_DEST:-$HOME/Applications/Jarvis.app}"
if [ -z "${JARVIS_APP_DEST:-}" ] && is_safari_webapp "$DEST"; then
  DEST="$HOME/Applications/Jarvis Desktop/Jarvis.app"
  echo "~/Applications/Jarvis.app é o web app do Safari; instalando em $DEST"
fi
is_safari_webapp "$DEST" && { echo "Recuso sobrescrever o web app do Safari em $DEST" >&2; exit 1; }

IDENTITIES="$(security find-identity -p codesigning 2>/dev/null || true)"
WANTED="${JARVIS_SIGNING_IDENTITY:-Jarvis Local Signing}"
SIGN="$(awk -v n="\"$WANTED\"" 'index($0, n) { print $2; exit }' <<<"$IDENTITIES")"
[ -n "$SIGN" ] || SIGN="$(awk '/"[^"]*Jarvis[^"]*"/ { print $2; exit }' <<<"$IDENTITIES")"
if [ -n "$SIGN" ]; then
  SIGN_NAME="$(awk -v h="$SIGN" '$2 == h { sub(/^[^"]*"/, ""); sub(/".*$/, ""); print; exit }' <<<"$IDENTITIES")"
else
  SIGN="-"; SIGN_NAME="ad hoc"
fi

echo "==> Compilando"
swift build -c release --package-path "$PKG"
BIN="$(swift build -c release --package-path "$PKG" --show-bin-path)/Jarvis"

echo "==> Montando o Jarvis.app"
STAGE="$PKG/.build/Jarvis.app"
rm -rf "$STAGE"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources"
cp "$PKG/Resources/Info.plist" "$STAGE/Contents/Info.plist"
# Onde está o repositório nesta máquina: a primeira execução usa para instalar o dashboard e abrir o onboarding.
/usr/libexec/PlistBuddy -c "Add :JarvisRepo string $(cd "$PKG/../.." && pwd)" "$STAGE/Contents/Info.plist"
cp "$PKG/Resources/AppIcon.icns" "$STAGE/Contents/Resources/AppIcon.icns"
cp "$BIN" "$STAGE/Contents/MacOS/Jarvis"
codesign --force --sign "$SIGN" --identifier "$BUNDLE_ID" "$STAGE"
codesign --verify --strict "$STAGE"

echo "==> Instalando em $DEST"
# Encerra só esta cópia (o processo do web app do Safari também se chama Jarvis).
PIDS="$(ps -axo pid=,comm= | awk -v exe="$DEST/Contents/MacOS/Jarvis" '{ pid = $1; sub(/^ *[0-9]+ /, ""); if ($0 == exe) print pid }')"
if [ -n "$PIDS" ]; then kill $PIDS; sleep 1; fi
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
ditto "$STAGE" "$DEST"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" || true
echo "Jarvis.app instalado em $DEST (assinatura: $SIGN_NAME)"

if [ "${1:-}" != "--nao-abrir" ]; then
  open "$DEST"
fi
