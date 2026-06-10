#!/usr/bin/env bash
set -euo pipefail
AGENTS="$HOME/Library/LaunchAgents"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
for plist in com.marcel.screenpipe-distiller.daily com.marcel.screenpipe-distiller.health; do
  cp "$REPO/launchd/$plist.plist" "$AGENTS/"
  launchctl unload "$AGENTS/$plist.plist" 2>/dev/null || true
  launchctl load "$AGENTS/$plist.plist"
  echo "loaded $plist"
done
