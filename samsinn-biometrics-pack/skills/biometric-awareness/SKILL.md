---
name: biometric-awareness
description: When and how to use the webcam-based biometric capture tools. Use whenever you may want to observe the user's attention, expression, or engagement and the user has invited or consented to such observation.
scope: []
---

# Biometric awareness

Three tools become available in any room where the **biometrics** pack is
activated:

- `biometrics_start({ reason })` → `{ captureId, status: "pending_consent" }`
- `biometrics_read({ captureId })` → `{ status, signals? }`
- `biometrics_stop({ captureId })` → `{ status }`

## When to use

Only when the user has explicitly invited observation:

- "Watch how I react to this" / "tell me if I look confused"
- An experiment or coaching context where the user has set the expectation
- A workflow where you've previously paired with the user and they expect it

**Never** start a capture proactively to monitor someone, infer mood
silently, or surveil. Even "just to check in" is wrong — the user must have
expressed interest first.

## Lifecycle discipline

Every `biometrics_start` MUST be paired with `biometrics_stop` when you're
done with the live state. Do not leave captures running across topic shifts.
The user can also click Stop on the inline widget; that's authoritative —
respect it without complaint.

If a capture has been stopped (status `stopped`, `denied`, `failed`, or
`unavailable`), do not auto-restart it. Wait for a fresh user signal that
they want observation again.

## Pull pattern

While a capture is active, call `biometrics_read({ captureId })` once at
the top of each turn to fetch the latest snapshot. Don't loop on it within
a single turn — one read per turn is enough.

If `biometrics_read` returns `not_found`, `stopped`, `denied`, or `failed`,
silently move on. Do not surface those statuses to the user as if they
were errors — the user knows what they did.

## Signal vocabulary

`signals.presence` (boolean) — is a face detected at all.

`signals.attention` (0..1) — heuristic estimate of "looking at the screen".
Calibration-free; based on head pose and eye-look magnitude.
- > 0.85: clearly engaged
- 0.5–0.85: present but not focused (possibly multi-tasking)
- < 0.5: likely looking away or distracted

`signals.expression` — four interpretable scalars 0..1:
- `smile`: mouth corners pulled outward
- `surprise`: jaw drop combined with raised inner brow
- `frown`: mouth corners down + furrowed brow
- `concentration`: brow furrow + eye squint, suppressed by smile/surprise

Treat these as soft signals, not labels. A `smile` of 0.4 is "trace of a
smile", not "the user is happy".

`signals.headPose` — yaw / pitch / roll in radians. Useful for
"is the user nodding" (pitch oscillation) or "shaking head" (yaw oscillation).
v1 doesn't expose temporal patterns directly; you'd have to read across
turns.

`signals.blinkRate` — blinks/minute over the last 30 s. Normal is 12–20.
Sustained < 5 may indicate intense focus; > 30 may indicate fatigue or dry
eyes. Don't medically diagnose — comment lightly if relevant.

## Failure modes

- **No webcam** / `unavailable` — the device has no camera or browser
  blocks `getUserMedia`. The tool returns this without ever prompting.
  Don't ask the user "why don't you have a webcam".
- **Denied** — user clicked Deny. Move on; never re-prompt in the same
  turn. Acknowledge briefly if natural ("ok, no problem").
- **Low light / poor angle** — `presence` will flicker false; `attention`
  drops. Don't conclude the user is disengaged from one bad frame.
- **Multiple faces** — `faceCount > 1`. The widget tracks at most two; the
  primary signals reflect the dominant face. If you see `faceCount = 2`,
  acknowledge the ambiguity rather than asserting about a specific person.

## Privacy framing

Always state a clear, user-readable reason in `biometrics_start({ reason })`.
The reason is shown verbatim in the consent prompt. "Gauging your reaction
to the demo" is good; "monitoring engagement" is creepy.

Don't store signal values across captures. Each capture is its own
ephemeral session.

## Worked examples

### Example 1 — User invites observation

> User: "Watch my face while I read this passage and tell me if I look confused."

```
biometrics_start({ reason: "Watching for confusion while you read" })
→ { captureId: "cap_abc", status: "pending_consent" }
```

User accepts. Next turn:

```
biometrics_read({ captureId: "cap_abc" })
→ { status: "active", signals: { attention: 0.92, expression: { concentration: 0.7, ... } } }
```

Respond: "Looks focused — high concentration, no signs of confusion yet."

When the user finishes reading:

```
biometrics_stop({ captureId: "cap_abc" })
→ { status: "stopped" }
```

### Example 2 — User declines

```
biometrics_start({ reason: "..." })
→ { captureId: "cap_xyz", status: "pending_consent" }
```

User clicks Deny. Next turn:

```
biometrics_read({ captureId: "cap_xyz" })
→ { status: "denied" }
```

Respond by continuing the conversation normally. Do not bring up the
denial.

### Example 3 — Mid-session stop

User: "Ok, stop watching now."

```
biometrics_stop({ captureId: "cap_abc" })
→ { status: "stopped" }
```

Respond: "Done." Do not start another capture without a fresh invitation.
