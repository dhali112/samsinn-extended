// ============================================================================
// Shared "confirm + run scenario" helper.
//
// Used by all three entry points (share-link, settings panel, empty-state
// strip). Centralises:
//   - Pack-install consent gating (when meta.opKinds includes 'install-pack',
//     surface a checkbox; otherwise short-circuit straight to run).
//   - The POST /api/scenarios/:pack/:name/run round-trip.
//   - Run-ownership claim (so this tab's overlay renders, not other tabs').
//   - Failure toasts.
//
// Returns the runId on success, null otherwise. Caller decides what to do
// next (the share-link strips the URL param, the panel re-renders the
// catalog with a Stop button, the strip just disappears).
// ============================================================================

import { showToast } from './toast.ts'
import { claimRunOwnership } from './scenario-overlay.ts'

export interface ScenarioConsentMeta {
  readonly id: string
  readonly pack: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly opKinds: ReadonlyArray<string>
  // Optional — only the share-link entry point provides narration (it pre-
  // fetches the full source). The panel + strip pass undefined and the
  // helper renders without it.
  readonly narration?: string
  // For "this scenario will install a pack" the helper surfaces a confirm
  // dialog. Defaults true; false skips even the install-consent dialog
  // (used by the boot welcome path which auto-runs).
  readonly requireConsent?: boolean
}

const containsInstallOp = (meta: ScenarioConsentMeta): boolean =>
  meta.opKinds.includes('install-pack')

const startRun = async (meta: ScenarioConsentMeta, allowInstall: boolean): Promise<string | null> => {
  try {
    const res = await fetch(
      `/api/scenarios/${encodeURIComponent(meta.pack)}/${encodeURIComponent(meta.name)}/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowInstall }),
      },
    )
    if (!res.ok) {
      const reason = await res.text().catch(() => '')
      showToast(document.body, `Could not start scenario: ${reason || res.statusText}`, {
        type: 'error', position: 'fixed', durationMs: 10000,
      })
      return null
    }
    const data = await res.json() as { runId?: string }
    if (typeof data.runId === 'string') {
      claimRunOwnership(data.runId)
      return data.runId
    }
    return null
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    showToast(document.body, `Network error starting scenario: ${reason}`, {
      type: 'error', position: 'fixed', durationMs: 10000,
    })
    return null
  }
}

// Show the consent dialog (or short-circuit) and return the runId on success.
export const confirmRunWithConsent = async (
  meta: ScenarioConsentMeta,
): Promise<string | null> => {
  // Short-circuit: requireConsent: false bypasses the dialog entirely.
  if (meta.requireConsent === false) {
    return startRun(meta, containsInstallOp(meta))
  }

  return new Promise<string | null>((resolve) => {
    const backdrop = document.createElement('div')
    // Use the same --shadow-overlay token the project's other modals use
    // (light: 40% black, dark: 60% black). bg-black/40 was a fixed value
    // that didn't theme-flip and looked thin against the dark theme.
    backdrop.className = 'fixed inset-0 z-50 flex items-center justify-center'
    backdrop.style.background = 'var(--shadow-overlay)'
    backdrop.setAttribute('data-scenario-consent', '')

    const card = document.createElement('div')
    card.className = 'bg-surface-strong border border-border rounded shadow-lg p-4 max-w-lg w-full text-sm'

    const eyebrow = document.createElement('div')
    eyebrow.className = 'text-xs text-text-subtle mb-1'
    eyebrow.textContent = `Scenario from pack: ${meta.pack}`
    card.appendChild(eyebrow)

    const h = document.createElement('h2')
    h.className = 'text-base font-semibold mb-1'
    h.textContent = meta.title
    card.appendChild(h)

    if (meta.description) {
      const d = document.createElement('div')
      d.className = 'text-text-subtle mb-3'
      d.textContent = meta.description
      card.appendChild(d)
    }

    if (meta.narration) {
      const narr = document.createElement('div')
      narr.className = 'text-text whitespace-pre-wrap mb-3 max-h-64 overflow-y-auto border border-border rounded p-2 bg-surface-muted'
      narr.textContent = meta.narration
      card.appendChild(narr)
    }

    let allowInstall = false
    const hasInstall = containsInstallOp(meta)
    if (hasInstall) {
      const wrap = document.createElement('label')
      wrap.className = 'flex items-start gap-2 mb-3 text-xs text-text'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.className = 'mt-0.5'
      cb.addEventListener('change', () => { allowInstall = cb.checked })
      const label = document.createElement('span')
      label.textContent = 'This scenario contains install-pack operations. Check to allow it to install packs from remote git sources.'
      wrap.appendChild(cb)
      wrap.appendChild(label)
      card.appendChild(wrap)
    }

    const btnRow = document.createElement('div')
    btnRow.className = 'flex gap-2 justify-end'

    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.className = 'px-3 py-1 text-xs rounded bg-surface-muted text-text-subtle hover:bg-surface'
    cancel.addEventListener('click', () => {
      backdrop.remove()
      resolve(null)
    })

    const run = document.createElement('button')
    run.textContent = 'Run scenario'
    run.className = 'px-3 py-1 text-xs rounded bg-accent text-white hover:bg-accent-hover'
    run.addEventListener('click', async () => {
      if (hasInstall && !allowInstall) {
        showToast(document.body, 'Tick the install-pack consent box first, or cancel.', { type: 'error', position: 'fixed' })
        return
      }
      backdrop.remove()
      const runId = await startRun(meta, allowInstall)
      resolve(runId)
    })

    btnRow.appendChild(cancel)
    btnRow.appendChild(run)
    card.appendChild(btnRow)
    backdrop.appendChild(card)
    document.body.appendChild(backdrop)
  })
}
