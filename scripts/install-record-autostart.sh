#!/usr/bin/env bash
set -euo pipefail
AGENTS="$HOME/Library/LaunchAgents"
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# 1. Remove the dead .app autostart (points at the uninstalled desktop app).
if [ -f "$AGENTS/screenpipe.plist" ]; then
  launchctl unload "$AGENTS/screenpipe.plist" 2>/dev/null || true
  rm -f "$AGENTS/screenpipe.plist"
  echo "removed dead screenpipe.plist"
fi

# 2. Stop any manually-started recorder so we don't run two on one sqlite db.
pkill -f "screenpipe record" 2>/dev/null || true
sleep 2

# 3. Install + load the new record agent.
cp "$REPO/launchd/com.marcel.screenpipe.record.plist" "$AGENTS/"
launchctl unload "$AGENTS/com.marcel.screenpipe.record.plist" 2>/dev/null || true
launchctl load "$AGENTS/com.marcel.screenpipe.record.plist"
echo "loaded com.marcel.screenpipe.record"
