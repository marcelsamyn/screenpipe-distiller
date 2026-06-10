#!/usr/bin/env bash
# Installs launchd agents (macOS): daily distill at 22:00, health checks at 12:00 & 20:00.
set -euo pipefail
AGENTS="$HOME/Library/LaunchAgents"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$AGENTS"

BUN="$(command -v bun || true)"
if [ -z "$BUN" ]; then
  echo "error: 'bun' not found on PATH." >&2
  exit 1
fi

load_plist() {
  local label="$1"
  local plist="$AGENTS/$label.plist"
  cat > "$plist"
  launchctl unload "$plist" 2>/dev/null || true
  launchctl load "$plist"
  echo "loaded $label"
}

load_plist "com.screenpipe-distiller.daily" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.screenpipe-distiller.daily</string>
  <key>ProgramArguments</key>
  <array><string>$BUN</string><string>run</string><string>distill</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>22</integer><key>Minute</key><integer>0</integer></dict>
  <key>StandardOutPath</key><string>$REPO/distill.out.log</string>
  <key>StandardErrorPath</key><string>$REPO/distill.err.log</string>
</dict>
</plist>
PLIST

load_plist "com.screenpipe-distiller.health" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.screenpipe-distiller.health</string>
  <key>ProgramArguments</key>
  <array><string>$BUN</string><string>run</string><string>health-check</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string></dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>12</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key><string>$REPO/health.out.log</string>
  <key>StandardErrorPath</key><string>$REPO/health.err.log</string>
</dict>
</plist>
PLIST
