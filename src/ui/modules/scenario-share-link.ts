// ============================================================================
// Share-link boot handler — reads `?scenario=<pack>/<name>` from the URL
// at app startup and (with explicit user consent) starts a scenario run.
//
// Flow:
//   1. Parse `?scenario=<pack>/<name>` from URL.
//   2. Fetch /api/scenarios/<pack>/<name> for title + description + narration.
//   3. Hand off to confirmRunWithConsent (shared with the panel + strip).
//   4. Strip `?scenario=` from the URL so refresh doesn't re-trigger.
// ============================================================================

import { showToast } from './toast.ts'
import { parseScenarioId } from './scenario-pure.ts'
import { confirmRunWithConsent, type ScenarioConsentMeta } from './scenario-consent.ts'

interface ScenarioFullMeta extends ScenarioConsentMeta {
  readonly opCount: number
  readonly source: string
}

const stripScenarioParam = (): void => {
  const url = new URL(window.location.href)
  if (!url.searchParams.has('scenario')) return
  url.searchParams.delete('scenario')
  window.history.replaceState({}, '', url.toString())
}

// Public entry point — call once at app boot, after WS handlers are wired.
export const initScenarioShareLink = async (): Promise<void> => {
  const url = new URL(window.location.href)
  const id = url.searchParams.get('scenario')
  if (!id) return
  const parsed = parseScenarioId(id)
  if (!parsed.ok) {
    // Cast: tsconfig.ui.json runs in non-strict mode so discriminated-union
    // narrowing on `parsed.ok` doesn't tighten access.
    const { reason } = parsed as { reason: string }
    showToast(document.body, `Invalid scenario id "${id}": ${reason}`, { type: 'error', position: 'fixed' })
    stripScenarioParam()
    return
  }
  const { pack, name } = parsed
  // Plain fetch (not safeFetch) so we can distinguish 404 ("scenario not on
  // this server — pack probably not installed") from network errors.
  let meta: ScenarioFullMeta
  try {
    const res = await fetch(`/api/scenarios/${encodeURIComponent(pack)}/${encodeURIComponent(name)}`)
    if (res.status === 404) {
      showToast(document.body, `Scenario "${id}" is not installed on this server. The pack may not be installed yet.`, { type: 'error', position: 'fixed', durationMs: 10000 })
      stripScenarioParam()
      return
    }
    if (!res.ok) {
      showToast(document.body, `Could not load scenario "${id}": HTTP ${res.status}`, { type: 'error', position: 'fixed', durationMs: 10000 })
      stripScenarioParam()
      return
    }
    meta = await res.json() as ScenarioFullMeta
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    showToast(document.body, `Network error loading scenario "${id}": ${reason}`, { type: 'error', position: 'fixed', durationMs: 10000 })
    stripScenarioParam()
    return
  }
  // URL is stripped before consent dialog so a refresh during the consent
  // dialog doesn't re-prompt. The dialog still has the meta in scope.
  stripScenarioParam()
  await confirmRunWithConsent(meta)
}
