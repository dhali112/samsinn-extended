// Biometric capture widget — the inline element rendered in place of a
// `\`\`\`biometric` fenced code block. One widget per fenced block instance
// (per captureId).
//
// State machine: requested → active → stopped (terminal).
// Off-paths: denied / failed / unavailable / claimed-elsewhere (all terminal).
//
// Lifecycle invariants:
//   - The widget is the SOLE owner of any MediaStream it opens. Cleanup is
//     guaranteed via three independent paths:
//       (a) explicit user click on Stop
//       (b) DOM removal observed via MutationObserver on the wrapper
//       (c) page-level samsinn:biometric-stop-all event
//     All three end in `await session.stop()` before any state swap.
//   - Re-mount after stop is idempotent: `state: 'stopped'` in the fenced
//     block payload renders a static summary; never reopens the camera.
//   - Multi-tab claim race: late tab receives biometric_capture_claimed
//     and MUST `await session.stop()` to release its own MediaStream
//     before swapping to the claimed-elsewhere placeholder.
//
// All rendering is plain DOM — no framework. Tailwind utility classes
// match the rest of src/ui/modules/. Theme colours come from the
// CSS variables defined globally.

import { createBiometricSession, type CaptureSession, type BiometricSignal } from '../../../biometrics/index.ts'
import { send as sendWS } from '../ws-send.ts'

interface FencedPayload {
  readonly captureId: string
  readonly agentName: string
  readonly reason: string
  readonly state?: 'requested' | 'active' | 'stopped'
  readonly resolution?: { readonly width: number; readonly height: number }
}

const SIGNAL_PUSH_INTERVAL_MS = 2000
const REGISTERED_WIDGETS = new Set<HTMLElement>()
let stopAllListenerAttached = false

const ensureStopAllListener = (): void => {
  if (stopAllListenerAttached) return
  stopAllListenerAttached = true
  document.addEventListener('samsinn:biometric-stop-all', () => {
    for (const w of REGISTERED_WIDGETS) {
      const stop = (w as HTMLElement & { __biometricStop?: () => void }).__biometricStop
      try { stop?.() } catch { /* ignore */ }
    }
  })
  window.addEventListener('beforeunload', () => {
    for (const w of REGISTERED_WIDGETS) {
      const stop = (w as HTMLElement & { __biometricStop?: () => void }).__biometricStop
      try { stop?.() } catch { /* ignore */ }
    }
  })
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))

const formatPercent = (v: number): string => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`

const buildSignalCard = (signal: BiometricSignal | null): string => {
  if (!signal) return '<div class="text-xs text-muted">No signal yet…</div>'
  if (!signal.presence) return '<div class="text-xs text-muted">No face detected</div>'
  const e = signal.expression
  return `
    <div class="text-xs space-y-0.5">
      <div>Attention: <strong>${formatPercent(signal.attention)}</strong></div>
      <div>Smile: ${formatPercent(e.smile)} · Frown: ${formatPercent(e.frown)}</div>
      <div>Surprise: ${formatPercent(e.surprise)} · Concentration: ${formatPercent(e.concentration)}</div>
      <div>Blinks/min: ${signal.blinkRate.toFixed(1)}</div>
    </div>`
}

const renderConsent = (wrapper: HTMLElement, payload: FencedPayload, onAllow: () => void, onDeny: () => void): void => {
  wrapper.innerHTML = `
    <div class="border border-border rounded p-3 my-2 bg-surface">
      <div class="font-medium mb-1">${escapeHtml(payload.agentName)} requests biometric capture</div>
      <div class="text-xs text-muted mb-2">Reason: ${escapeHtml(payload.reason || '(no reason given)')}</div>
      <div class="text-xs text-muted mb-3">Webcam will be active until you click Stop.</div>
      <div class="flex gap-2">
        <button data-act="allow" class="px-3 py-1 rounded bg-primary text-primary-content text-sm">Allow</button>
        <button data-act="deny" class="px-3 py-1 rounded border border-border text-sm">Deny</button>
      </div>
    </div>`
  wrapper.querySelector('[data-act="allow"]')?.addEventListener('click', onAllow)
  wrapper.querySelector('[data-act="deny"]')?.addEventListener('click', onDeny)
}

const renderActive = (wrapper: HTMLElement, payload: FencedPayload): { videoEl: HTMLVideoElement; canvasEl: HTMLCanvasElement; signalsEl: HTMLElement; stopBtn: HTMLButtonElement; elapsedEl: HTMLElement } => {
  const w = payload.resolution?.width ?? 320
  const h = payload.resolution?.height ?? 240
  wrapper.innerHTML = `
    <div class="border border-border rounded p-3 my-2 bg-surface">
      <div class="flex items-center gap-2 mb-2">
        <span class="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
        <span class="text-sm font-medium">REC</span>
        <span class="text-xs text-muted" data-role="elapsed">0s</span>
        <span class="text-xs text-muted">· ${escapeHtml(payload.agentName)} · ${escapeHtml(payload.reason)}</span>
        <button data-act="stop" class="ml-auto px-2 py-0.5 rounded border border-border text-xs">Stop</button>
      </div>
      <div class="relative inline-block" style="width:${w}px;height:${h}px">
        <video data-role="video" width="${w}" height="${h}" muted playsinline style="transform:scaleX(-1);width:${w}px;height:${h}px;background:#000;"></video>
        <canvas data-role="canvas" width="${w}" height="${h}" style="position:absolute;inset:0;transform:scaleX(-1);pointer-events:none;"></canvas>
      </div>
      <div class="mt-2" data-role="signals"></div>
    </div>`
  return {
    videoEl: wrapper.querySelector('[data-role="video"]') as HTMLVideoElement,
    canvasEl: wrapper.querySelector('[data-role="canvas"]') as HTMLCanvasElement,
    signalsEl: wrapper.querySelector('[data-role="signals"]') as HTMLElement,
    stopBtn: wrapper.querySelector('[data-act="stop"]') as HTMLButtonElement,
    elapsedEl: wrapper.querySelector('[data-role="elapsed"]') as HTMLElement,
  }
}

const renderTerminal = (wrapper: HTMLElement, payload: FencedPayload, kind: 'stopped' | 'denied' | 'failed' | 'unavailable' | 'claimed-elsewhere', detail?: string, finalSignal?: BiometricSignal | null): void => {
  const labels: Record<typeof kind, string> = {
    stopped: 'Capture stopped',
    denied: 'Permission denied',
    failed: 'Capture failed',
    unavailable: 'Webcam unavailable',
    'claimed-elsewhere': 'Active in another tab',
  }
  wrapper.innerHTML = `
    <div class="border border-border rounded p-3 my-2 bg-surface text-sm">
      <div class="font-medium mb-1">${escapeHtml(labels[kind])}</div>
      <div class="text-xs text-muted mb-2">Capture: ${escapeHtml(payload.captureId)} · ${escapeHtml(payload.agentName)}</div>
      ${detail ? `<div class="text-xs text-muted mb-2">${escapeHtml(detail)}</div>` : ''}
      ${kind === 'stopped' ? buildSignalCard(finalSignal ?? null) : ''}
    </div>`
}

const parsePayload = (raw: string): FencedPayload | null => {
  try {
    const obj = JSON.parse(raw) as Partial<FencedPayload>
    if (typeof obj.captureId !== 'string' || !obj.captureId) return null
    return {
      captureId: obj.captureId,
      agentName: obj.agentName ?? 'agent',
      reason: obj.reason ?? '',
      state: obj.state ?? 'requested',
      resolution: obj.resolution,
    }
  } catch {
    return null
  }
}

const mountWidget = (wrapper: HTMLElement, payload: FencedPayload): void => {
  ensureStopAllListener()
  REGISTERED_WIDGETS.add(wrapper)

  // If the fenced block already says stopped, render terminal-only and skip
  // the camera path entirely. This is what makes re-renders idempotent.
  if (payload.state === 'stopped') {
    renderTerminal(wrapper, payload, 'stopped')
    REGISTERED_WIDGETS.delete(wrapper)
    return
  }

  let session: CaptureSession | null = null
  let pushTimer: ReturnType<typeof setInterval> | null = null
  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let claimedListener: ((e: Event) => void) | null = null
  let observer: MutationObserver | null = null
  let stopped = false

  const cleanup = async (reason: 'user' | 'agent' | 'unmount' | 'disconnect' | 'error'): Promise<void> => {
    if (stopped) return
    stopped = true
    if (pushTimer) clearInterval(pushTimer)
    if (elapsedTimer) clearInterval(elapsedTimer)
    if (claimedListener) window.removeEventListener('biometric:claimed', claimedListener)
    if (observer) observer.disconnect()
    REGISTERED_WIDGETS.delete(wrapper)
    let last: BiometricSignal | null = null
    try { last = session?.read() ?? null } catch { last = null }
    try { await session?.stop() } catch { /* ignore */ }
    sendWS({ type: 'biometric_capture_stopped', captureId: payload.captureId, reason })
    renderTerminal(wrapper, payload, 'stopped', undefined, last)
  }

  // Expose stop hook on the DOM node for the global stop-all listener.
  ;(wrapper as HTMLElement & { __biometricStop?: () => void }).__biometricStop = () => { void cleanup('agent') }

  const onAllow = async (): Promise<void> => {
    const ui = renderActive(wrapper, payload)
    try {
      session = createBiometricSession({
        videoEl: ui.videoEl,
        canvasEl: ui.canvasEl,
        ...(payload.resolution ? { resolution: payload.resolution } : {}),
      })
      session.onError((err) => {
        sendWS({ type: 'biometric_capture_failed', captureId: payload.captureId, error: err.message })
        renderTerminal(wrapper, payload, 'failed', err.message)
        REGISTERED_WIDGETS.delete(wrapper)
        stopped = true
      })
      await session.start()
      sendWS({ type: 'biometric_capture_started', captureId: payload.captureId })

      const startedAt = performance.now()
      elapsedTimer = setInterval(() => {
        const s = Math.floor((performance.now() - startedAt) / 1000)
        ui.elapsedEl.textContent = `${s}s`
        ui.signalsEl.innerHTML = buildSignalCard(session?.read() ?? null)
      }, 250)

      pushTimer = setInterval(() => {
        const snap = session?.read()
        if (snap) sendWS({ type: 'biometric_capture_signal', captureId: payload.captureId, snapshot: snap })
      }, SIGNAL_PUSH_INTERVAL_MS)

      ui.stopBtn.addEventListener('click', () => { void cleanup('user') })

      observer = new MutationObserver(() => {
        if (!document.contains(wrapper)) void cleanup('unmount')
      })
      observer.observe(document.body, { childList: true, subtree: true })

      claimedListener = (e: Event) => {
        const detail = (e as CustomEvent<{ captureId: string; claimedBy: string }>).detail
        if (detail.captureId !== payload.captureId) return
        // claimedBy === our session: we won, ignore. Otherwise we lost.
        // We don't have direct access to our own session token here; the
        // claim event arrives ONLY at the loser's tab because the dispatcher
        // is keyed by ws session — but to keep this defensive, the widget
        // takes the conservative path: if a claim arrives after we've sent
        // started, we assume server-side accepted ours unless we receive
        // a follow-up `claimed-elsewhere` semantics. Server broadcasts to
        // all sessions; loser-path is "we receive claim where claimedBy is
        // not us" — without our token, we treat the FIRST claim event for
        // this captureId after our started as the indicator.
        // Simpler invariant: only the loser's started call leaves the
        // registry in the same state, so the server MUST have rejected
        // ours (registry.claim returns null for late tabs). The server
        // therefore does not broadcast claimed for the loser's own claim.
        // The presence of claimed here means we lost.
        // Cleanup as 'disconnect' (we never fully owned the capture).
        void (async () => {
          if (stopped) return
          stopped = true
          if (pushTimer) clearInterval(pushTimer)
          if (elapsedTimer) clearInterval(elapsedTimer)
          if (observer) observer.disconnect()
          REGISTERED_WIDGETS.delete(wrapper)
          try { await session?.stop() } catch { /* ignore */ }
          renderTerminal(wrapper, payload, 'claimed-elsewhere', `Active in another tab (${detail.claimedBy.slice(0, 8)}…)`)
        })()
      }
      window.addEventListener('biometric:claimed', claimedListener)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // Distinguish permission denial from genuine failure.
      if (/denied|not allowed|notallowed/i.test(msg)) {
        sendWS({ type: 'biometric_capture_denied', captureId: payload.captureId })
        renderTerminal(wrapper, payload, 'denied', msg)
      } else {
        sendWS({ type: 'biometric_capture_failed', captureId: payload.captureId, error: msg })
        renderTerminal(wrapper, payload, 'failed', msg)
      }
      REGISTERED_WIDGETS.delete(wrapper)
      stopped = true
    }
  }

  const onDeny = (): void => {
    sendWS({ type: 'biometric_capture_denied', captureId: payload.captureId })
    renderTerminal(wrapper, payload, 'denied')
    REGISTERED_WIDGETS.delete(wrapper)
    stopped = true
  }

  // No webcam at all on this device → bail before consent.
  if (!navigator.mediaDevices?.getUserMedia) {
    sendWS({ type: 'biometric_capture_failed', captureId: payload.captureId, error: 'getUserMedia unavailable' })
    renderTerminal(wrapper, payload, 'unavailable', 'This browser/device does not expose a webcam.')
    REGISTERED_WIDGETS.delete(wrapper)
    return
  }

  renderConsent(wrapper, payload, onAllow, onDeny)
}

export const renderBiometricBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll('code.language-biometric')
  if (blocks.length === 0) return
  for (const block of blocks) {
    const pre = block.parentElement
    if (!pre) continue
    const payload = parsePayload(block.textContent ?? '')
    const wrapper = document.createElement('div')
    if (!payload) {
      wrapper.className = 'border border-border rounded p-3 my-2 bg-surface text-xs text-muted'
      wrapper.textContent = 'Invalid biometric block payload.'
      pre.replaceWith(wrapper)
      continue
    }
    pre.replaceWith(wrapper)
    mountWidget(wrapper, payload)
  }
}
