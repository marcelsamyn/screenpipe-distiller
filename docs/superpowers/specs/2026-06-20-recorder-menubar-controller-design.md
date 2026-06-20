# Screenpipe Recorder menu bar controller — design

**Date:** 2026-06-20
**Status:** Approved, pending implementation plan

## Problem

The screenpipe recorder autostarts at login and runs continuously, draining
battery when the Mac is unplugged. There is no easy way to pause it: the launchd
agent `com.screenpipe-distiller.record` has `KeepAlive: true` and runs
`open -W "Screenpipe Recorder.app"`, so quitting the app just makes launchd
relaunch it. Stopping recording today requires `launchctl bootout` plus a
`pkill` — too fiddly to do every time the user goes on battery.

We want recording to **pause automatically on battery and resume on AC**, with a
**menu bar item** that reflects the current state and allows manual control.

## Current setup (for context)

`scripts/install-record-app.sh` builds `~/Applications/Screenpipe Recorder.app`,
whose `Contents/MacOS/run` is a compiled Swift launcher. The launcher:

1. requests microphone access via `AVCaptureDevice.requestAccess` (so the grant
   binds to this bundle's code identity), then
2. `execv`s itself **into** `screenpipe record --audio-device "<device>"` in
   place, so the recording process keeps the bundle's TCC identity.

The app bundle exists purely so macOS can attach a microphone grant to a stable
code identity (a bare launchd-spawned `screenpipe` has no identity TCC can bind).

The launchd agent runs `open -W <app>` with `RunAtLoad` + `KeepAlive`.

## Approach

Replace the headless exec-launcher with a small **`LSUIElement` menu bar app**
that *spawns* `screenpipe record` as a child process instead of becoming it.

This collapses the process boundaries. Instead of
`launchd → open -W → app → exec screenpipe`, the shape becomes
`launchd → menu bar app → (spawns/kills) screenpipe`. launchd only keeps the
**controller** alive; pause/resume happens inside the app, so no `launchctl`
juggling is ever needed for normal use.

The microphone grant is preserved: the controller keeps the same bundle
identity, ad-hoc signing, and `AVCaptureDevice.requestAccess` call on first
launch. `screenpipe` runs as a **child** of the signed bundle, so TCC attributes
its microphone use to the app as the responsible process — the same inheritance
the current exec approach relies on, just child-of instead of exec-into.

## Components

### 1. Menu bar controller app (rewritten `Contents/MacOS/run`)

A Swift `NSApplication` with `NSApplicationActivationPolicy.accessory`
(`LSUIElement` true in `Info.plist`, already set). Owns an `NSStatusItem`.

Responsibilities:

- On launch: request mic permission (only if `RECORD_AUDIO != 0`, as today),
  then evaluate power state and `apply()` the resulting desired state.
- Manage the `screenpipe record` child process.
- Watch power-source changes and apply the auto policy.
- Host the menu bar icon + menu.

### 2. State machine

A single `desiredState: RecordingState` (`.recording` | `.paused`) plus an
idempotent `apply()` that reconciles the world to it:

- `.recording` and no child running → spawn `screenpipe record …`.
- `.paused` and child running → terminate the child.
- otherwise → no-op.

Inputs that change `desiredState`:

- **Power events** — `IOPSNotificationCreateRunLoopSource` callback. On each
  power *transition*: battery → `.paused`, AC → `.recording`. This is the only
  power-reactive path and it fires only on actual transitions.
- **Manual toggle** — the Pause/Resume menu item sets `desiredState` directly.
  Because the auto policy only runs on power transitions, a manual choice
  persists until the next plug/unplug event. This realizes the agreed rule:
  **manual override wins until the next power-state change.**

Child lifecycle:

- **Child crash/exit** — `Process.terminationHandler`. If `desiredState ==
  .recording`, respawn after a short backoff (e.g. 2s). This takes over the
  "keep the recorder running" role that launchd `KeepAlive` plays today, but is
  pause-aware: it never respawns against a deliberate `.paused` state.

Power-source reading: use `IOPSCopyPowerSourcesInfo` /
`IOPSGetProvidingPowerSourceType` to classify AC vs battery in the callback.

### 3. Menu bar surface

- **Icon** — SF Symbols, template/monochrome (adapts to light/dark menu bar):
  a filled-dot glyph when recording, a pause glyph when paused. No color.
- **Status line** — a disabled `NSMenuItem`: `Recording`,
  `Paused (on battery)`, or `Paused`.
- **Pause / Resume** — toggle item; title flips with state.
- **Quit** — quits the controller. Note: launchd `KeepAlive` will relaunch it at
  next login (or immediately, since `open -W` returns when the app exits — this
  is acceptable; Quit is the explicit "stop now" escape hatch, the menu Pause is
  the everyday control).

### 4. screenpipe invocation

The controller embeds the same argv the install script builds today: absolute
`screenpipe` path baked in at install time, plus the audio-device selection
logic (`--audio-device "<device>"`, `--use-system-default-audio`, or
`--disable-audio` when `RECORD_AUDIO=0`). stdout/stderr of both the controller
and the child are redirected to `~/.screenpipe/record.app.log`.

## Data flow

```
login ─▶ launchd (RunAtLoad, KeepAlive)
          └─▶ open -W "Screenpipe Recorder.app"
                └─▶ controller app (menu bar)
                      ├─ mic request (first launch)
                      ├─ power watcher ──(transition)──▶ desiredState
                      ├─ menu toggle ───(click)────────▶ desiredState
                      └─ apply() ⇄ screenpipe record child
                                      └─ terminationHandler ─▶ respawn if recording
```

## What changes in the repo

- `scripts/install-record-app.sh`: replace the embedded Swift source (launcher →
  menu bar controller). The baked `screenpipe` path and audio-device argv logic
  are unchanged. The `Info.plist` block is unchanged (already `LSUIElement`).
  The launchd plist block (`open -W`, `RunAtLoad`, `KeepAlive`) is unchanged.
- The manual `launchctl bootout` / `pkill` soft-pause workflow is no longer
  needed for everyday use; pausing is a menu click.

No changes to `install-record-autostart.sh` (the bare, non-app variant) — it
stays as the audio-disabled fallback.

## Edge cases

- **Two recorders on one sqlite db** — must never happen. The install script
  already `pkill`s existing `screenpipe record` and unloads prior agents before
  loading. The controller spawns exactly one child and tracks it; `apply()` is
  idempotent so it never double-spawns.
- **Mic already granted** — `requestAccess` is a no-op once `authorizationStatus`
  is `.authorized`; only prompts when `.notDetermined`, as today.
- **Rapid plug/unplug** — `apply()` reconciliation is idempotent; a spawn
  immediately followed by a kill (or vice versa) settles to the latest
  `desiredState`.
- **Controller crash** — launchd `KeepAlive` relaunches it; on relaunch it
  re-evaluates power state and resumes the correct behavior.
- **screenpipe exits cleanly on its own** — treated like a crash: respawn if
  `desiredState == .recording`.

## Testing

GUI macOS app — verified manually against this checklist (captured here so it can
be re-run after changes):

1. Run install script → microphone prompt appears once → Allow.
2. On AC: icon shows recording glyph; `pgrep -f "screenpipe record"` returns a pid.
3. Click **Pause** → screenpipe process gone; icon shows pause glyph; status reads `Paused`.
4. Click **Resume** → screenpipe respawns; icon back to recording.
5. Unplug power → auto-pauses; status reads `Paused (on battery)`.
6. Plug in → auto-resumes; recording glyph returns.
7. Manual **Resume** while unplugged → records on battery; stays recording until
   next plug/unplug transition.
8. **Quit** → controller exits, all screenpipe processes stop.
9. Kill the `screenpipe` child directly while recording → controller respawns it
   within a few seconds.

## Out of scope (YAGNI)

- Low-battery percentage thresholds (binary AC/battery only).
- "Open log file" menu item.
- Preferences UI / configurable audio device at runtime (set at install time).
- Automated tests (GUI + TCC + power state are not unit-testable here).
