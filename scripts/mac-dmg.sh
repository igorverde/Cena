#!/usr/bin/env bash
# Gera os .dmg do Cena para macOS (Intel e Apple Silicon). Roda num Mac (ou no GitHub Actions).
# Sem conta de desenvolvedor Apple, o app recebe uma assinatura "ad hoc", necessária para
# rodar em Macs com chip Apple. Na primeira abertura o usuário confirma em
# clique direito → Abrir (ou Ajustes do Sistema → Privacidade e Segurança → Abrir Mesmo Assim).
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
mkdir -p release/dmg
for app in release/mac*/Cena.app; do
  dir=$(basename "$(dirname "$app")")
  arch=$([ "$dir" = "mac-arm64" ] && echo "apple-silicon" || echo "intel")
  echo "→ assinando (ad hoc) $app"
  codesign --force --deep --sign - "$app"
  codesign --verify --deep --strict "$app"
  stage=$(mktemp -d)
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Aplicativos"
  out="release/dmg/Cena-$VERSION-mac-$arch.dmg"
  rm -f "$out"
  hdiutil create -volname "Cena $VERSION" -srcfolder "$stage" -ov -format UDZO "$out" >/dev/null
  rm -rf "$stage"
  echo "✓ $out"
done
