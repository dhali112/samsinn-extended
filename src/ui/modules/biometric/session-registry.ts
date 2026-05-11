// Tab-scoped registry of live biometric capture sessions, keyed by
// captureId. The MediaStream is owned here — outside the DOM widget — so
// re-renders, room switches, and any other event that detaches the widget
// wrapper cannot orphan a camera. A 2 s sweep timer is the unconditional
// safety net: if the registered wrapper is no longer in the document, the
// session is stopped.
//
// Lifecycle invariants:
//   - attach() registers a freshly-started session with its wrapper.
//   - setWrapper() swaps the attached wrapper on widget re-mount (the
//     fenced block was re-parsed by markdown and a new wrapper element
//     took the old one's place). The session keeps streaming; no
//     re-consent, no second getUserMedia.
//   - release() is the SOLE chokepoint that stops a session. Multiple
//     callers (Stop button, claimed-elsewhere, agent-stop, sweep, page
//     unload) all funnel through here. Idempotent.
//   - sweepOrphans() releases any session whose wrapper has been detached.
//     This is what makes the leak structurally impossible — no matter
//     which mutation event fires (or doesn't), the next sweep tick stops
//     the camera.
//
// The registry is tab-scoped. Cross-tab claim resolution still happens
// over WS via biometric_capture_claimed broadcast.

import type { CaptureSession } from '../../../biometrics/index.ts'

export type ReleaseReason = 'user' | 'agent' | 'unmount' | 'disconnect' | 'error'

export interface LiveSession {
  readonly captureId: string
  readonly session: CaptureSession
  readonly attachedWrapper: HTMLElement | null
}

export interface SessionRegistry {
  readonly get: (captureId: string) => LiveSession | null
  readonly attach: (captureId: string, session: CaptureSession, wrapper: HTMLElement) => void
  readonly setWrapper: (captureId: string, wrapper: HTMLElement) => void
  readonly release: (captureId: string, reason: ReleaseReason) => Promise<void>
  readonly sweepOrphans: () => Promise<void>
  readonly _entries: () => ReadonlyArray<LiveSession>
}

const SWEEP_INTERVAL_MS = 2000

export interface SessionRegistryConfig {
  // Optional override for tests — when null, sweepOrphans() can still be
  // driven manually. Production uses setInterval.
  readonly scheduler?: {
    readonly setInterval: (cb: () => void, ms: number) => unknown
    readonly clearInterval: (handle: unknown) => void
  }
  // Optional onRelease hook used by the widget to send a WS stopped
  // message. Decoupled from the registry so the registry has no WS
  // dependency and stays unit-testable.
  readonly onRelease?: (captureId: string, reason: ReleaseReason) => void
}

export const createSessionRegistry = (config: SessionRegistryConfig = {}): SessionRegistry => {
  const entries = new Map<string, { session: CaptureSession; wrapper: HTMLElement | null }>()
  const scheduler = config.scheduler ?? {
    setInterval: (cb, ms) => globalThis.setInterval(cb, ms),
    clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
  }
  let sweepHandle: unknown = null

  const ensureSweeper = (): void => {
    if (sweepHandle !== null) return
    sweepHandle = scheduler.setInterval(() => { void registry.sweepOrphans() }, SWEEP_INTERVAL_MS)
  }
  const stopSweeperIfEmpty = (): void => {
    if (entries.size === 0 && sweepHandle !== null) {
      scheduler.clearInterval(sweepHandle)
      sweepHandle = null
    }
  }

  const registry: SessionRegistry = {
    get: (captureId) => {
      const e = entries.get(captureId)
      return e ? { captureId, session: e.session, attachedWrapper: e.wrapper } : null
    },
    attach: (captureId, session, wrapper) => {
      entries.set(captureId, { session, wrapper })
      ensureSweeper()
      console.debug('[biometric:lifecycle] attach', { captureId })
    },
    setWrapper: (captureId, wrapper) => {
      const e = entries.get(captureId)
      if (!e) return
      e.wrapper = wrapper
      console.debug('[biometric:lifecycle] setWrapper', { captureId })
    },
    release: async (captureId, reason) => {
      const e = entries.get(captureId)
      if (!e) return
      entries.delete(captureId)
      console.debug('[biometric:lifecycle] release', { captureId, reason })
      try { await e.session.stop() } catch { /* always swallow — release must complete */ }
      try { config.onRelease?.(captureId, reason) } catch { /* ignore */ }
      stopSweeperIfEmpty()
    },
    sweepOrphans: async () => {
      const orphans: string[] = []
      for (const [id, e] of entries) {
        if (e.wrapper && !e.wrapper.isConnected) orphans.push(id)
      }
      for (const id of orphans) {
        console.debug('[biometric:lifecycle] sweep released', { captureId: id, reason: 'unmount' })
        await registry.release(id, 'unmount')
      }
    },
    _entries: () => [...entries].map(([captureId, e]) => ({
      captureId, session: e.session, attachedWrapper: e.wrapper,
    })),
  }

  return registry
}
