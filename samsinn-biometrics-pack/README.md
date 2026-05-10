# samsinn-biometrics

Webcam-based face / attention / expression tracking for Samsinn.

## Install

```
install_pack samsinn-packs/biometrics
```

(or via the Settings → Packs UI)

Activate the pack in any room where you want agents to be able to start a
capture. The `biometrics_start` / `biometrics_stop` / `biometrics_read`
tools become available to agents in that room.

## What this pack contains

- `pack.json` — declares the `biometrics` UI extension to be mounted in
  the browser.
- `skills/biometric-awareness/SKILL.md` — agent-facing documentation:
  when to capture, how to interpret signals, ethics and privacy notes.

The implementation (the inline widget, settings panel, capture registry,
WS commands, and tool factories) lives in samsinn core and is gated on
this pack being installed and activated. Path C of the v4 plan: pack
declares, core implements.

## Privacy

- Captures require **explicit per-capture user consent** in the inline
  widget. No agent can start the camera silently.
- Captures are **ephemeral** — landmark data, video frames, and signal
  history are never persisted. The save-time snapshot redactor strips
  capture content from any on-disk record.
- All processing is **client-side** in the browser via MediaPipe
  Tasks Vision. No frame ever leaves the user's machine.

## Caveats

- Uninstalling the pack while the process is running removes the tools
  from the registry. They re-register on the next process restart. For
  clean uninstall, restart the samsinn server after `uninstall_pack`.
- v1 tracks face only. Pose / hand / gesture modules ship as separate
  packs (`samsinn-pose`, `samsinn-gesture`) when those modules land.
- Eye gaze is heuristic (head pose + eye-look blendshapes). For
  pixel-accurate screen-coordinate gaze, a dedicated tracker is needed —
  not in scope for this pack.
