#!/usr/bin/env bash
# Installs the persistent WhatsApp ingestion sidecar on macOS.
set -euo pipefail

LABEL="com.screenpipe-distiller.whatsapp"
AGENTS="$HOME/Library/LaunchAgents"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun || true)"

if [ -z "$BUN" ]; then
  echo "error: 'bun' not found on PATH." >&2
  exit 1
fi

mkdir -p "$AGENTS" "$HOME/.screenpipe-distiller/whatsapp"
chmod 700 "$HOME/.screenpipe-distiller" "$HOME/.screenpipe-distiller/whatsapp"

cat > "$AGENTS/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BUN</string><string>run</string><string>whatsapp</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>WHATSAPP_HTTP_PORT</key><string>3036</string>
    <key>WHATSAPP_DATA_DIR</key><string>$HOME/.screenpipe-distiller/whatsapp</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$REPO/whatsapp.out.log</string>
  <key>StandardErrorPath</key><string>$REPO/whatsapp.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$AGENTS/$LABEL.plist" 2>/dev/null || true
launchctl load "$AGENTS/$LABEL.plist"
echo "loaded $LABEL"
echo "status: curl -fsS http://127.0.0.1:3036/status"
