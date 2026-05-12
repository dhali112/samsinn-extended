// ============================================================================
// Scenario guide overlay — tooltips + modals dispatched from
// `scenario_guide_shown` WS events.
//
// Transient. No persistent UI surface (no right-rail panel) — this matches
// the rejected-artifacts precedent: chat is the canonical persistent surface,
// scenarios layer guidance on top and disappear when the run ends.
//
// Tooltips anchor to existing CSS selectors (e.g. existing `data-*`
// attributes). On `waitFor: click`, the user clicks "Next" to advance.
// On `waitFor: post`, the tooltip lingers until the server resumes the run
// based on a posted message (which fires `scenario_op_executed` and the
// next `scenario_guide_shown` if any).
// ============================================================================

import { safeFetch } from './fetch-helpers.ts'
import { showToast } from './toast.ts'
import { computeTooltipPlacement } from './scenario-pure.ts'

interface GuideShownDetail {
  readonly runId: string
  readonly kind: 'tooltip' | 'modal' | 'toast'
  readonly selector?: string
  readonly title?: string
  readonly body: string
  readonly variant?: 'success' | 'error'
  readonly waitFor: { readonly type: 'click' | 'post' | 'timer'; readonly selector?: string; readonly room?: string; readonly seconds?: number } | null
}

let activeRunId: string | null = null
let activeOverlay: HTMLElement | null = null
// The element currently carrying the amber pulse. Tracked at module scope
// so a new tooltip (or scenario completion / stop) clears the prior anchor's
// class deterministically — without this, the prior anchor's class lingered
// until its own 4 s timeout fired, causing two anchors to pulse at once.
let pulsedAnchor: HTMLElement | null = null

const clearPulsedAnchor = (): void => {
  if (pulsedAnchor) {
    pulsedAnchor.classList.remove('scenario-target-pulse')
    pulsedAnchor = null
  }
}

const removeOverlay = (): void => {
  if (activeOverlay) {
    activeOverlay.remove()
    activeOverlay = null
  }
  clearPulsedAnchor()
}

// Wrap `document.querySelector` so a malformed CSS selector authored in a
// scenario .md doesn't throw out of the WS dispatch tick. Returns null on
// any error and logs once for diagnosis.
const safeQuerySelector = (selector: string): HTMLElement | null => {
  try {
    return document.querySelector(selector) as HTMLElement | null
  } catch (err) {
    console.warn(`[scenario-overlay] invalid selector "${selector}": ${err instanceof Error ? err.message : err}`)
    return null
  }
}

const advance = async (): Promise<void> => {
  if (!activeRunId) return
  await safeFetch(`/api/scenarios/runs/${encodeURIComponent(activeRunId)}/advance`, { method: 'POST' })
}

// Show a tooltip anchored to the element matched by `selector`. If the
// selector doesn't resolve, fall back to a centered toast — better than
// silently dropping the guidance.
const renderTooltip = (detail: GuideShownDetail): void => {
  removeOverlay()
  const target = detail.selector ? safeQuerySelector(detail.selector) : null
  const wrap = document.createElement('div')
  wrap.className = 'fixed z-[1100] bg-surface-strong border border-border rounded shadow-lg p-3 max-w-sm text-sm pointer-events-auto'
  wrap.setAttribute('data-scenario-overlay', 'tooltip')

  const bodyEl = document.createElement('div')
  bodyEl.className = 'text-text whitespace-pre-wrap'
  bodyEl.textContent = detail.body
  wrap.appendChild(bodyEl)

  // Pulse-highlight the target so users see what the tooltip points at.
  // Tracked in pulsedAnchor so removeOverlay (or the next tooltip) can
  // clear the prior class — no stale 4s-decoupled timeout pile-up.
  if (target) {
    target.classList.add('scenario-target-pulse')
    pulsedAnchor = target
  }

  if (detail.waitFor && detail.waitFor.type === 'click') {
    const btnRow = document.createElement('div')
    btnRow.className = 'flex gap-2 mt-2 justify-end'
    const next = document.createElement('button')
    next.textContent = 'Next'
    next.className = 'px-2 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-wait'
    // Disable on click so a rapid double-click doesn't fire two POSTs (the
    // second 400s "not awaiting" — harmless but the error toast is noise).
    // Re-enabled implicitly when the next guide arrives (fresh button).
    next.addEventListener('click', () => {
      next.disabled = true
      void advance()
    })
    const skip = document.createElement('button')
    skip.textContent = 'Skip'
    skip.className = 'px-2 py-1 text-xs rounded bg-surface-muted text-text-subtle hover:bg-surface disabled:opacity-50'
    skip.addEventListener('click', () => {
      skip.disabled = true
      next.disabled = true
      void stopRun()
    })
    btnRow.appendChild(skip)
    btnRow.appendChild(next)
    wrap.appendChild(btnRow)
  } else if (detail.waitFor && detail.waitFor.type === 'post') {
    const hint = document.createElement('div')
    hint.className = 'text-xs text-text-subtle mt-2'
    hint.textContent = `(continues when you post in "${detail.waitFor.room}")`
    wrap.appendChild(hint)
  }

  document.body.appendChild(wrap)
  activeOverlay = wrap

  // Position via the pure helper (testable without a DOM). When the
  // anchor doesn't resolve, the helper returns a centered position with
  // the `useTransform` flag set so we apply the translate trick.
  const wrapRect = wrap.getBoundingClientRect()
  const placement = computeTooltipPlacement(
    target ? target.getBoundingClientRect() : null,
    { width: wrapRect.width, height: wrapRect.height },
    { innerWidth: window.innerWidth, innerHeight: window.innerHeight },
  )
  wrap.style.left = `${placement.left}px`
  wrap.style.top = `${placement.top}px`
  if (placement.useTransform) wrap.style.transform = 'translate(-50%, -50%)'
}

const renderModal = (detail: GuideShownDetail): void => {
  removeOverlay()
  const backdrop = document.createElement('div')
  backdrop.className = 'fixed inset-0 z-[1100] flex items-center justify-center pointer-events-auto'
  // Same --shadow-overlay token other modals use; theme-flips with dark mode.
  backdrop.style.background = 'var(--shadow-overlay)'
  backdrop.setAttribute('data-scenario-overlay', 'modal')
  const card = document.createElement('div')
  card.className = 'bg-surface-strong border border-border rounded shadow-lg p-4 max-w-md text-sm'
  if (detail.title) {
    const h = document.createElement('h2')
    h.className = 'text-base font-semibold mb-2'
    h.textContent = detail.title
    card.appendChild(h)
  }
  const body = document.createElement('div')
  body.className = 'text-text whitespace-pre-wrap'
  body.textContent = detail.body
  card.appendChild(body)
  if (detail.waitFor && detail.waitFor.type === 'click') {
    const btnRow = document.createElement('div')
    btnRow.className = 'flex gap-2 mt-4 justify-end'
    const skip = document.createElement('button')
    skip.textContent = 'Skip'
    skip.className = 'px-3 py-1 text-xs rounded bg-surface-muted text-text-subtle hover:bg-surface disabled:opacity-50'
    skip.addEventListener('click', () => {
      skip.disabled = true; next.disabled = true
      void stopRun()
    })
    const next = document.createElement('button')
    next.textContent = 'Next'
    next.className = 'px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-wait'
    next.addEventListener('click', () => {
      next.disabled = true
      void advance()
    })
    btnRow.appendChild(skip)
    btnRow.appendChild(next)
    card.appendChild(btnRow)
  }
  backdrop.appendChild(card)
  document.body.appendChild(backdrop)
  activeOverlay = backdrop
}

const stopRun = async (): Promise<void> => {
  if (!activeRunId) return
  const id = activeRunId
  activeRunId = null
  removeOverlay()
  await safeFetch(`/api/scenarios/runs/${encodeURIComponent(id)}/stop`, { method: 'POST' })
}

// === Per-tab run ownership ===
//
// A scenario run's WS events broadcast to every tab of the same cookie-
// bound instance. To keep two tabs from independently rendering overlays
// for the same run, only the tab that initiated the run (via the share-
// link consent dialog OR the welcome-boot codepath) shows the overlay.
//
// Ownership is recorded in sessionStorage (per-tab) under this key. The
// scenario-share-link module writes the runId after a successful POST
// /run; this module reads it on every WS event.
//
// Notable: tabs other than the owner are still informed by the WS events;
// they just stay quiet. If a non-owner tab needs to surface a guide, that's
// a future "show overlay in spectator mode" feature.

const OWNED_RUNS_KEY = 'samsinn:owned-scenario-runs'

const isOwnedRun = (runId: string): boolean => {
  try {
    const raw = sessionStorage.getItem(OWNED_RUNS_KEY)
    if (!raw) return false
    const set = new Set(raw.split(',').filter(Boolean))
    return set.has(runId)
  } catch {
    return true   // sessionStorage unavailable (test/incognito/quota): show by default
  }
}

// Public — called by scenario-share-link.ts after a successful POST /run.
// Also called by the boot codepath if we ever reintroduce ?scenario= for
// non-share-link autoplay.
//
// Bounded: we keep at most MAX_OWNED runs (most-recent first). Server-side
// ended runs are pruned 60 s after they finish; the client's
// `releaseRunOwnership` covers the WS-arrives-after-claim case, but a fast
// scenario can fire `scenario_completed` BEFORE the POST /run response
// returns and we get a chance to claim. The bound prevents unbounded
// accumulation of stale runIds in sessionStorage from that race.
const MAX_OWNED = 50

export const claimRunOwnership = (runId: string): void => {
  try {
    const raw = sessionStorage.getItem(OWNED_RUNS_KEY) ?? ''
    const list = raw.split(',').filter(Boolean).filter(x => x !== runId)
    list.push(runId)
    while (list.length > MAX_OWNED) list.shift()
    sessionStorage.setItem(OWNED_RUNS_KEY, list.join(','))
  } catch { /* sessionStorage unavailable */ }
}

const releaseRunOwnership = (runId: string): void => {
  try {
    const raw = sessionStorage.getItem(OWNED_RUNS_KEY) ?? ''
    const set = new Set(raw.split(',').filter(Boolean))
    set.delete(runId)
    sessionStorage.setItem(OWNED_RUNS_KEY, [...set].join(','))
  } catch { /* sessionStorage unavailable */ }
}

// === WS event handlers ===
//
// `runs.ts` forwards scenario_* events here. The scenario engine's contract
// is one run per instance at a time, so we don't need a per-runId map for
// active overlays — but we DO need ownership filtering (above) so two
// tabs of the same instance don't both render the overlay.

export const handleScenarioStarted = (runId: string, _title: string): void => {
  if (!isOwnedRun(runId)) return
  activeRunId = runId
  removeOverlay()
}

export const handleScenarioGuideShown = (detail: GuideShownDetail): void => {
  if (!isOwnedRun(detail.runId)) return
  activeRunId = detail.runId
  if (detail.kind === 'toast') {
    // Toasts are non-blocking — no overlay state mutation, no waitFor.
    showToast(document.body, detail.body, {
      type: detail.variant ?? 'success',
      position: 'fixed',
    })
    return
  }
  if (detail.kind === 'modal') renderModal(detail)
  else renderTooltip(detail)
}

export const handleScenarioCompleted = (runId: string): void => {
  if (!isOwnedRun(runId)) return
  if (activeRunId !== runId && activeRunId !== null) return
  activeRunId = null
  removeOverlay()
  releaseRunOwnership(runId)
  showToast(document.body, 'Scenario complete', { type: 'success', position: 'fixed' })
}

export const handleScenarioFailed = (runId: string, reason: string): void => {
  if (!isOwnedRun(runId)) return
  if (activeRunId !== runId && activeRunId !== null) return
  activeRunId = null
  removeOverlay()
  releaseRunOwnership(runId)
  showToast(document.body, `Scenario failed: ${reason}`, { type: 'error', position: 'fixed', durationMs: 10000 })
}

export const handleScenarioStopped = (runId: string): void => {
  if (!isOwnedRun(runId)) return
  if (activeRunId !== runId && activeRunId !== null) return
  activeRunId = null
  removeOverlay()
  releaseRunOwnership(runId)
}
