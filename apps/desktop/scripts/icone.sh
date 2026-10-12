#!/bin/bash
# Gera Resources/AppIcon.icns a partir de Resources/AppIcon.svg (precisa de rsvg-convert: brew install librsvg).
# O .icns fica versionado; rode só quando mudar o SVG.
set -euo pipefail
cd "$(dirname "$0")/.."
SET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$SET"
for size in 16 32 128 256 512; do
  rsvg-convert -w "$size" -h "$size" Resources/AppIcon.svg -o "$SET/icon_${size}x${size}.png"
  rsvg-convert -w $((size * 2)) -h $((size * 2)) Resources/AppIcon.svg -o "$SET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$SET" -o Resources/AppIcon.icns
echo "Resources/AppIcon.icns gerado"
