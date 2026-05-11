// In-memory capture registry — one per House instance. Holds the lifecycle
// state and latest snapshot of every active biometric capture so the
// `biometrics_read` tool can answer "what's the current user state" without
// reaching back to the browser.
//
// Ephemeral by design: never persisted to snapshot, cleared on house
// teardown / instance evict, no on-disk trace. The widget pushes snapshots
// over WS roughly every 2 s while a capture is active; the registry is the
// server-side cache the agent reads from.
//
// Lifecycle states reflect what the user / widget has done:
//   pending_consent — agent called biometrics_start; user hasn't decided
//   active          — user accepted; widget is streaming snapshots
//   stopped         — capture ended (any reason); read returns last snapshot
//   denied          — user declined the consent prompt
//   failed          — error during inference / device init
//
// claimedBy is set when the first tab to send biometric_capture_started
// wins; subsequent tabs are told via biometric_capture_claimed and switch
// to a "active in another tab" placeholder.

import type { BiometricSignalWire } from '../types/ws-protocol.ts'

// Server-side type alias — the registry stores wire-shape snapshots received
// from the browser-side widget. Renamed for clarity at call sites.
export type BiometricSnapshot = BiometricSignalWire

export type CaptureStatus =
  | 'pending_consent'
  | 'active'
  | 'stopped'
  | 'denied'
  | 'failed'

export interface CaptureEntry {
  readonly captureId: string
  readonly agentId: string
  readonly agentName: string
  readonly roomId: string
  readonly reason: string
  readonly createdAt: number
  readonly status: CaptureStatus
  readonly claimedBy?: string                // ws session id
  readonly lastSnapshot?: BiometricSnapshot
  readonly stoppedAt?: number
  readonly stoppedReason?: string
  readonly error?: string
}

export interface CaptureRegistry {
  readonly create: (entry: Omit<CaptureEntry, 'createdAt' | 'status'>) => CaptureEntry
  readonly claim: (captureId: string, sessionId: string) => CaptureEntry | null
  readonly setSnapshot: (captureId: string, snapshot: BiometricSnapshot) => CaptureEntry | null
  readonly setStopped: (captureId: string, reason: string) => CaptureEntry | null
  readonly setDenied: (captureId: string) => CaptureEntry | null
  readonly setFailed: (captureId: string, error: string) => CaptureEntry | null
  readonly get: (captureId: string) => CaptureEntry | null
  readonly listForRoom: (roomId: string) => ReadonlyArray<CaptureEntry>
  readonly clearForRoom: (roomId: string) => void
  readonly clearAll: () => void
  // Subscribe to agent-initiated stop requests. The wire layer registers
  // one listener at server boot to broadcast biometric_capture_stop_requested
  // so any live widget for that captureId tears down its MediaStream.
  readonly onAgentStop: (cb: (captureId: string) => void) => () => void
}

export const createCaptureRegistry = (): CaptureRegistry => {
  const entries = new Map<string, CaptureEntry>()
  const agentStopListeners = new Set<(captureId: string) => void>()

  const update = (captureId: string, patch: Partial<CaptureEntry>): CaptureEntry | null => {
    const existing = entries.get(captureId)
    if (!existing) return null
    const next: CaptureEntry = { ...existing, ...patch }
    entries.set(captureId, next)
    return next
  }

  return {
    create: (input) => {
      const entry: CaptureEntry = {
        ...input,
        createdAt: Date.now(),
        status: 'pending_consent',
      }
      entries.set(input.captureId, entry)
      return entry
    },
    claim: (captureId, sessionId) => {
      const e = entries.get(captureId)
      if (!e) return null
      // First-claim-wins. If already claimed, return null so the caller can
      // emit a biometric_capture_claimed event to the late tab.
      if (e.claimedBy && e.claimedBy !== sessionId) return null
      return update(captureId, { claimedBy: sessionId, status: 'active' })
    },
    setSnapshot: (captureId, snapshot) => update(captureId, { lastSnapshot: snapshot }),
    setStopped: (captureId, reason) => {
      const updated = update(captureId, { status: 'stopped', stoppedAt: Date.now(), stoppedReason: reason })
      // Agent-initiated stop (vs user/unmount/disconnect): notify listeners
      // so the wire layer can broadcast biometric_capture_stop_requested to
      // tear down the still-live widget. UI-initiated stops already came
      // FROM the widget so a re-broadcast would be redundant.
      if (updated && reason === 'agent') {
        for (const l of agentStopListeners) {
          try { l(captureId) } catch (err) { console.error('[capture] agentStop listener failed', err) }
        }
      }
      return updated
    },
    setDenied: (captureId) =>
      update(captureId, { status: 'denied', stoppedAt: Date.now() }),
    setFailed: (captureId, error) =>
      update(captureId, { status: 'failed', error, stoppedAt: Date.now() }),
    get: (captureId) => entries.get(captureId) ?? null,
    listForRoom: (roomId) => [...entries.values()].filter(e => e.roomId === roomId),
    clearForRoom: (roomId) => {
      for (const [id, e] of entries) if (e.roomId === roomId) entries.delete(id)
    },
    clearAll: () => entries.clear(),
    onAgentStop: (cb) => {
      agentStopListeners.add(cb)
      return () => agentStopListeners.delete(cb)
    },
  }
}

// Process-wide singleton — pack-loaded tools reach the registry via this
// getter rather than receiving it through the pack-tool dep-injection
// contract (matches how built-ins access globally available state). The
// soft layering violation is documented and accepted in the v4 plan.
let singleton: CaptureRegistry | null = null
export const getCaptureRegistry = (): CaptureRegistry => {
  if (!singleton) singleton = createCaptureRegistry()
  return singleton
}
