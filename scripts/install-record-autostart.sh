#!/usr/bin/env bash
# Installs a launchd agent (macOS) that keeps `screenpipe record` running at login.
# Set RECORD_AUDIO=0 to disable audio capture (e.g. if a launchd microphone-permission
# issue makes audio-enabled recording crash-loop).
set -euo pipefail
AGENTS="$HOME/Library/LaunchAgents"
LABEL="com.screenpipe-distiller.record"
mkdir -p "$AGENTS"

SCREENPIPE="$(command -v screenpipe || true)"
if [ -z "$SCREENPIPE" ]; then
  echo "error: 'screenpipe' not found on PATH. Install the screenpipe CLI first." >&2
  exit 1
fi

AUDIO_ARG=""
if [ "${RECORD_AUDIO:-1}" = "0" ]; then
  AUDIO_ARG=$'\n    <string>--disable-audio</string>'
fi

# Remove the legacy screenpipe.app autostart if present.
if [ -f "$AGENTS/screenpipe.plist" ]; then
  launchctl unload "$AGENTS/screenpipe.plist" 2>/dev/null || true
  rm -f "$AGENTS/screenpipe.plist"
fi
# Stop any manually-started recorder so we don't run two on one sqlite db.
pkill -f "screenpipe record" 2>/dev/null || true
sleep 2

cat > "$AGENTS/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$SCREENPIPE</string>
    <string>record</string>$AUDIO_ARG
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$HOME/.screenpipe/record.launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/.screenpipe/record.launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$AGENTS/$LABEL.plist" 2>/dev/null || true
launchctl load "$AGENTS/$LABEL.plist"
echo "loaded $LABEL"
