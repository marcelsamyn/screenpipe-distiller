#!/usr/bin/env bash
# Installs an audio-capable screenpipe recorder autostart on macOS.
#
# WHY AN APP BUNDLE: macOS ties microphone permission (TCC) to a launched .app's
# code identity. A bare `screenpipe record` started directly by launchd has no
# such identity, so it can never hold a microphone grant — toggling it under
# System Settings -> Privacy -> Microphone won't bind to it, and audio stays
# disabled. We wrap the binary in a tiny ad-hoc-signed .app, launched via
# LaunchServices (`open`), giving the recorder a stable code identity that CAN be
# granted the microphone.
#
# WHY A COMPILED LAUNCHER: screenpipe only *polls* microphone permission; it never
# actively requests it, so macOS never shows a prompt and the app never appears in
# the Microphone list to grant. The app's executable is therefore a tiny Swift
# launcher that calls AVCaptureDevice.requestAccess (which triggers the prompt and
# registers the grant against this bundle), then exec()s screenpipe in place — so
# the recording process keeps the bundle's identity and inherits the grant.
#
# Audio device: defaults to pinning the Mac's built-in mic (captures your voice
# and in-person conversations, with no system-output media noise). Override with
# AUDIO_DEVICE="Some Device (input)", or set AUDIO_DEVICE="" to follow the system
# default input+output. Set RECORD_AUDIO=0 for a screen-only recorder (no mic).
set -euo pipefail

APP_DIR="$HOME/Applications/Screenpipe Recorder.app"
AGENTS="$HOME/Library/LaunchAgents"
LABEL="com.screenpipe-distiller.record"
LOG_DIR="$HOME/.screenpipe"
LOG_FILE="$LOG_DIR/record.app.log"
AUDIO_DEVICE="${AUDIO_DEVICE-MacBook Pro Microphone (input)}"

SCREENPIPE="$(command -v screenpipe || true)"
if [ -z "$SCREENPIPE" ]; then
  echo "error: 'screenpipe' not found on PATH. Install the screenpipe CLI first." >&2
  exit 1
fi
if ! command -v swiftc >/dev/null 2>&1; then
  echo "error: 'swiftc' not found. Install the Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$APP_DIR/Contents/MacOS" "$AGENTS" "$LOG_DIR"

# Build the screenpipe argument vector (Swift array literal) + whether to prompt.
REQUEST_MIC="true"
if [ "${RECORD_AUDIO:-1}" = "0" ]; then
  REQUEST_MIC="false"
  SWIFT_ARGV="[\"$SCREENPIPE\", \"record\", \"--disable-audio\"]"
elif [ -n "$AUDIO_DEVICE" ]; then
  SWIFT_ARGV="[\"$SCREENPIPE\", \"record\", \"--audio-device\", \"$AUDIO_DEVICE\"]"
else
  SWIFT_ARGV="[\"$SCREENPIPE\", \"record\", \"--use-system-default-audio\"]"
fi

# Info.plist — the app identity + the microphone usage string macOS shows on the prompt.
cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>co.samyn.screenpipe-recorder</string>
  <key>CFBundleName</key><string>Screenpipe Recorder</string>
  <key>CFBundleDisplayName</key><string>Screenpipe Recorder</string>
  <key>CFBundleExecutable</key><string>run</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSMicrophoneUsageDescription</key><string>Screenpipe records audio so your personal memory assistant can recall meetings and conversations.</string>
</dict>
</plist>
PLIST

# Swift launcher: request mic as this bundle (triggers the prompt), then exec screenpipe.
SWIFT_SRC="$(mktemp -t screenpipe-recorder-launcher).swift"
cat > "$SWIFT_SRC" <<SWIFT
import AVFoundation
import Foundation

// LaunchServices-launched apps lose stdout/stderr; send them to the recorder log.
freopen("$LOG_FILE", "a", stdout)
freopen("$LOG_FILE", "a", stderr)

// screenpipe only polls mic permission and never prompts, so request access here.
// The grant is recorded against THIS bundle's identity; the exec'd screenpipe,
// running under the same identity, then inherits it.
if $REQUEST_MIC {
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        let sema = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in sema.signal() }
        sema.wait()
    }
}

// Replace this process with screenpipe in place, keeping the bundle TCC identity.
let argv: [String] = $SWIFT_ARGV
let cargs: [UnsafeMutablePointer<CChar>?] = argv.map { strdup(\$0) } + [nil]
execv(argv[0], cargs)
perror("execv screenpipe failed")
exit(1)
SWIFT

swiftc -O -framework AVFoundation -o "$APP_DIR/Contents/MacOS/run" "$SWIFT_SRC"
rm -f "$SWIFT_SRC"

# Ad-hoc sign so TCC has a stable code identity to attach the microphone grant to.
codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || codesign --force --sign - "$APP_DIR"

# Stop any previous recorder (old bare-launchd agent, legacy .app agent, manual
# processes) so we never run two recorders against one sqlite database.
if [ -f "$AGENTS/$LABEL.plist" ]; then
  launchctl unload "$AGENTS/$LABEL.plist" 2>/dev/null || true
fi
if [ -f "$AGENTS/screenpipe.plist" ]; then
  launchctl unload "$AGENTS/screenpipe.plist" 2>/dev/null || true
  rm -f "$AGENTS/screenpipe.plist"
fi
pkill -f "screenpipe record" 2>/dev/null || true
sleep 2

# LaunchAgent: launch the app via `open -W` (LaunchServices, so the app holds the
# TCC identity). KeepAlive restarts it if screenpipe exits; RunAtLoad at login.
cat > "$AGENTS/$LABEL.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-W</string>
    <string>$APP_DIR</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/record.launchd.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/record.launchd.err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$AGENTS/$LABEL.plist" 2>/dev/null || true
launchctl load "$AGENTS/$LABEL.plist"
echo "loaded $LABEL"
echo "app:    $APP_DIR"
echo "audio:  ${RECORD_AUDIO:-1}/1   device: ${AUDIO_DEVICE:-<system default>}"
echo "log:    $LOG_FILE"
if [ "$REQUEST_MIC" = "true" ]; then
  echo
  echo "ONE-TIME STEP: a microphone prompt for 'Screenpipe Recorder' will appear shortly. Click Allow."
fi
