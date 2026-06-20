#!/usr/bin/env bash
# Installs an audio-capable screenpipe recorder autostart on macOS, with a menu
# bar item that reflects recording state and auto-pauses on battery / resumes on AC.
#
# WHY AN APP BUNDLE: macOS ties microphone permission (TCC) to a launched .app's
# code identity. A bare `screenpipe record` started directly by launchd has no
# such identity, so it can never hold a microphone grant — toggling it under
# System Settings -> Privacy -> Microphone won't bind to it, and audio stays
# disabled. We wrap the binary in a tiny ad-hoc-signed .app, launched via
# LaunchServices (`open`), giving the recorder a stable code identity that CAN be
# granted the microphone.
#
# WHY A COMPILED CONTROLLER: screenpipe only *polls* microphone permission; it
# never actively requests it, so macOS never shows a prompt and the app never
# appears in the Microphone list to grant. The app's executable is therefore a
# small Swift menu bar controller that calls AVCaptureDevice.requestAccess (which
# triggers the prompt and registers the grant against this bundle), then *spawns*
# screenpipe as a child process — so the recorder runs under the bundle's identity
# and inherits the grant. Running screenpipe as a child (rather than exec-ing into
# it) lets the controller keep a menu bar run loop: it watches the power source and
# pauses/resumes the child automatically, and exposes manual Pause/Resume + Quit.
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

# Swift menu bar controller: request mic as this bundle (triggers the prompt),
# then spawn/supervise screenpipe and reflect state in the menu bar.
SWIFT_SRC="$(mktemp -t screenpipe-recorder-controller).swift"
cat > "$SWIFT_SRC" <<SWIFT
import AppKit
import AVFoundation
import IOKit.ps
import Foundation

// LaunchServices-launched apps lose stdout/stderr; send them to the recorder log.
freopen("$LOG_FILE", "a", stdout)
freopen("$LOG_FILE", "a", stderr)

func log(_ message: String) {
    try? FileHandle.standardError.write(contentsOf: Data("[recorder] \(message)\n".utf8))
}

// Menu bar controller: owns the screenpipe child process, reflects recording state
// in the menu bar, auto-pauses on battery / resumes on AC, and allows manual control.
final class RecorderController: NSObject, NSApplicationDelegate {
    enum RecordingState { case recording, paused }

    // screenpipe argv, baked in at install time: [path, "record", ...flags].
    private let argv: [String] = $SWIFT_ARGV
    private let requestMic = $REQUEST_MIC

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let statusLine = NSMenuItem(title: "Starting…", action: nil, keyEquivalent: "")
    private let toggleItem = NSMenuItem(title: "Pause", action: #selector(toggle), keyEquivalent: "")

    private var desired: RecordingState = .recording
    private var child: Process?
    private var intentionalStop = false
    private var lastOnAC = true
    private var respawn: DispatchWorkItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        updateUI()
        startPowerMonitoring()

        // screenpipe only polls mic permission and never prompts, so request access
        // here. The grant binds to THIS bundle's identity; the child screenpipe,
        // running under the same identity, then inherits it.
        if requestMic, AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                DispatchQueue.main.async { self.evaluateInitial() }
            }
        } else {
            evaluateInitial()
        }
    }

    // MARK: menu bar surface

    private func buildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false
        statusLine.isEnabled = false
        toggleItem.target = self
        let quitItem = NSMenuItem(title: "Quit Screenpipe Recorder", action: #selector(quit), keyEquivalent: "q")
        quitItem.target = self
        menu.addItem(statusLine)
        menu.addItem(.separator())
        menu.addItem(toggleItem)
        menu.addItem(.separator())
        menu.addItem(quitItem)
        statusItem.menu = menu
    }

    private func updateUI() {
        let symbolName = desired == .recording ? "record.circle.fill" : "pause.circle"
        let description = desired == .recording ? "Recording" : "Paused"
        if let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: description) {
            image.isTemplate = true
            statusItem.button?.image = image
        }
        statusLine.title = statusText()
        toggleItem.title = desired == .recording ? "Pause" : "Resume"
    }

    private func statusText() -> String {
        switch desired {
        case .recording: return "Recording"
        case .paused: return currentlyOnAC() ? "Paused" : "Paused (on battery)"
        }
    }

    // MARK: manual actions

    @objc private func toggle() {
        // Auto policy only reacts to power transitions, so this manual choice
        // persists until the next plug/unplug — manual override wins.
        desired = desired == .recording ? .paused : .recording
        apply()
        updateUI()
    }

    @objc private func quit() {
        desired = .paused
        stopChild()
        NSApp.terminate(nil)
    }

    // MARK: power source

    private func evaluateInitial() {
        // A crashed predecessor can leave an orphaned recorder; never run two
        // against one sqlite database. Clear strays, let the db settle, start fresh.
        killStrayRecorders()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            self.lastOnAC = self.currentlyOnAC()
            self.desired = self.lastOnAC ? .recording : .paused
            self.apply()
            self.updateUI()
        }
    }

    private func startPowerMonitoring() {
        let context = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        guard let source = IOPSNotificationCreateRunLoopSource({ ctx in
            guard let ctx = ctx else { return }
            Unmanaged<RecorderController>.fromOpaque(ctx).takeUnretainedValue().powerChanged()
        }, context)?.takeRetainedValue() else {
            log("failed to create power notification source")
            return
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .defaultMode)
    }

    private func powerChanged() {
        let onAC = currentlyOnAC()
        guard onAC != lastOnAC else { return }   // act only on real transitions
        lastOnAC = onAC
        desired = onAC ? .recording : .paused    // resets any manual override
        apply()
        updateUI()
    }

    private func currentlyOnAC() -> Bool {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() else { return true }
        guard let type = IOPSGetProvidingPowerSourceType(blob)?.takeUnretainedValue() else { return true }
        return (type as String) == kIOPSACPowerValue
    }

    // MARK: child process

    private func apply() {
        switch desired {
        case .recording: if child == nil { startChild() }
        case .paused: if child != nil { stopChild() }
        }
    }

    private func startChild() {
        respawn?.cancel()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: argv[0])
        process.arguments = Array(argv.dropFirst())
        process.terminationHandler = { [weak self] finished in
            DispatchQueue.main.async { self?.childDidExit(finished) }
        }
        do {
            try process.run()
            child = process
            intentionalStop = false
            log("started screenpipe (pid \(process.processIdentifier))")
        } catch {
            log("failed to start screenpipe: \(error)")
        }
    }

    private func stopChild() {
        respawn?.cancel()
        guard let process = child else { return }
        intentionalStop = true
        child = nil
        process.terminate()
        log("stopped screenpipe")
    }

    private func childDidExit(_ process: Process) {
        if intentionalStop { intentionalStop = false; return }   // we asked it to stop
        guard child === process else { return }                  // stale handler from a replaced child
        child = nil
        log("screenpipe exited (status \(process.terminationStatus))")
        // screenpipe crashed/exited on its own: take over launchd's keep-alive role,
        // but only while we still intend to record (never fight a deliberate pause).
        if desired == .recording {
            let work = DispatchWorkItem { [weak self] in self?.apply() }
            respawn = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
        }
        updateUI()
    }

    private func killStrayRecorders() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pkill")
        process.arguments = ["-f", "screenpipe record"]
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            log("failed to run pkill: \(error)")
        }
    }
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
let controller = RecorderController()
application.delegate = controller
application.run()
SWIFT

swiftc -O -framework AppKit -framework AVFoundation -framework IOKit -o "$APP_DIR/Contents/MacOS/run" "$SWIFT_SRC"
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
# TCC identity). KeepAlive restarts the controller if it ever exits/crashes (the
# controller itself keeps screenpipe alive while recording); RunAtLoad at login.
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
echo "menu:   a status item appears in the menu bar — it auto-pauses on battery,"
echo "        resumes on AC, and offers manual Pause/Resume + Quit."
if [ "$REQUEST_MIC" = "true" ]; then
  echo
  echo "ONE-TIME STEP: a microphone prompt for 'Screenpipe Recorder' will appear shortly. Click Allow."
fi
