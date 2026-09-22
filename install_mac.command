#!/bin/bash
# ═══════════════════════════════════════════════════════════════
#  SFX Manager — one-click installer for macOS
#  Installs the panel for After Effects & enables CEP debug mode
# ═══════════════════════════════════════════════════════════════
set -e

EXT_ID="com.nadim.sfxmanager"
SRC="$(cd "$(dirname "$0")" && pwd)/SFXManager"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"

echo "────────────────────────────────────────"
echo "  SFX Manager — macOS installer"
echo "────────────────────────────────────────"

if [ ! -d "$SRC" ]; then
  echo "✗ Could not find the SFXManager folder next to this script."
  exit 1
fi

echo "→ Copying panel to:"
echo "  $DEST"
mkdir -p "$DEST"
# fresh copy
find "$DEST" -mindepth 1 -delete 2>/dev/null || true
cp -R "$SRC"/. "$DEST"/

echo "→ Enabling unsigned CEP extensions (PlayerDebugMode)…"
for v in 7 8 9 10 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 >/dev/null 2>&1 || true
done
killall cfprefsd >/dev/null 2>&1 || true

echo ""
echo "✓ Installed successfully."
echo ""
echo "  1. Quit After Effects completely (⌘Q)."
echo "  2. Reopen After Effects."
echo "  3. Open the panel:  Window ▸ SFX Manager"
echo ""
read -n 1 -s -r -p "Press any key to close…"
echo ""
