// ============================================================================
// Empty-state inline strip — discoverability lure for showcase prompts
// and the small set of scenario-backed demos (e.g. Watch Me).
//
// Renders inside the messages container when:
//   - the current room has zero non-system messages
//   - AND no scenario is currently running in this tab's ownership
//
// Two sources merged into one strip:
//   1. SHOWCASE_PROMPTS — static chips that post a natural-language prompt
//      into the current room as the user's existing human. No scenarios
//      runner, no setup ceremony. The simplest path for "click to try."
//   2. Scenarios tagged `category: demo` — for demos that genuinely need
//      orchestration (pack install, dedicated agent with tool whitelist,
//      consent flow). Currently only Watch Me. Renders as a "Run" card
//      with the existing consent dialog.
//
// Pre-2026-05 design forced every demo through scenarios. After the
// scenarios-runner cascade of issues (auto-switch-to-manual heuristic,
// __DEFAULT_HUMAN__ resolution, persona-vs-system-trailer fights), the
// 4 data demos moved to plain chips. Watch Me stays a scenario because
// it actually needs the pack install + agent spawn + biometrics consent
// flow.
// ============================================================================

import { confirmRunWithConsent, type ScenarioConsentMeta } from './scenario-consent.ts'
import { $selectedRoomId, $rooms } from './stores.ts'
import { SHOWCASE_PROMPTS, sendAsCurrentHuman, type ShowcasePrompt } from './showcase-prompts.ts'

interface CatalogScenario {
  readonly id: string
  readonly pack: string
  readonly name: string
  readonly title: string
  readonly description: string
  readonly category: 'demo' | 'tutorial' | 'onboarding'
  readonly opCount: number
  readonly opKinds: ReadonlyArray<string>
}

const STRIP_ID = 'scenario-empty-state-strip'

const fetchDemoScenarios = async (): Promise<CatalogScenario[]> => {
  try {
    const res = await fetch('/api/scenarios')
    if (!res.ok) return []
    const data = await res.json() as { scenarios: CatalogScenario[] }
    return data.scenarios.filter(s => s.category === 'demo')
  } catch { return [] }
}

// Verify owned scenario-runs against the server. The previous version
// returned true if sessionStorage had ANY runId — stale ids from
// abandoned/failed runs never get cleared and the strip hid forever.
// Now we query each owned run; only running/awaiting count as "active."
// Stale ids are pruned from sessionStorage so they don't accumulate.
const hasOwnedActiveRun = async (): Promise<boolean> => {
  let owned: string[]
  try {
    const raw = sessionStorage.getItem('samsinn:owned-scenario-runs') ?? ''
    owned = raw.split(',').filter(Boolean)
  } catch { return false }
  if (owned.length === 0) return false

  const stillActive: string[] = []
  let foundActive = false
  for (const runId of owned) {
    try {
      const res = await fetch(`/api/scenarios/runs/${encodeURIComponent(runId)}`)
      if (!res.ok) continue                     // 404 / 4xx → stale, drop it
      const r = await res.json() as { status: string }
      if (r.status === 'running' || r.status === 'awaiting') {
        stillActive.push(runId)
        foundActive = true
      }
      // completed / failed / stopped → drop from sessionStorage
    } catch { /* network error — drop conservatively */ }
  }
  // Persist the pruned list so subsequent calls are cheaper.
  try {
    sessionStorage.setItem('samsinn:owned-scenario-runs', stillActive.join(','))
  } catch { /* private mode / quota — non-fatal */ }
  return foundActive
}

const currentRoomName = (): string | undefined => {
  const id = $selectedRoomId.get()
  if (!id) return undefined
  return $rooms.get()[id]?.name
}

// === Card builders ==========================================================

const buildPromptChip = (entry: ShowcasePrompt, onSent: () => void): HTMLElement => {
  const btn = document.createElement('button')
  btn.className = 'w-full text-left px-3 py-2 rounded border border-border bg-surface hover:bg-surface-strong'
  btn.title = entry.prompt
  const t = document.createElement('div')
  t.className = 'text-xs font-semibold text-text'
  t.textContent = entry.label
  const d = document.createElement('div')
  d.className = 'text-xs text-text-subtle'
  d.textContent = entry.description
  btn.appendChild(t)
  btn.appendChild(d)
  btn.addEventListener('click', () => {
    const ok = sendAsCurrentHuman(entry.prompt)
    if (ok) onSent()   // strip will hide once the room has a non-system message
  })
  return btn
}

const buildScenarioCard = (
  scenario: CatalogScenario,
  onStarted: () => void,
): HTMLElement => {
  const btn = document.createElement('button')
  btn.className = 'w-full text-left px-3 py-2 rounded border border-border bg-surface hover:bg-surface-strong'
  btn.title = scenario.description
  const t = document.createElement('div')
  t.className = 'text-xs font-semibold text-text'
  t.textContent = scenario.title
  const d = document.createElement('div')
  d.className = 'text-xs text-text-subtle'
  d.textContent = scenario.description
  btn.appendChild(t)
  btn.appendChild(d)
  btn.addEventListener('click', async () => {
    const meta: ScenarioConsentMeta = {
      id: scenario.id,
      pack: scenario.pack,
      name: scenario.name,
      title: scenario.title,
      description: scenario.description,
      opKinds: scenario.opKinds,
    }
    const runId = await confirmRunWithConsent(meta, currentRoomName())
    if (runId) onStarted()
  })
  return btn
}

// === Strip ==================================================================

const buildStrip = (
  scenarios: ReadonlyArray<CatalogScenario>,
  refresh: () => void,
): HTMLElement => {
  const wrap = document.createElement('div')
  wrap.id = STRIP_ID
  wrap.className = 'mt-4 mx-4 p-3 rounded border border-border bg-surface-muted'

  const header = document.createElement('div')
  header.className = 'text-xs text-text-subtle mb-2'
  header.textContent = 'Try a demo →'
  wrap.appendChild(header)

  const grid = document.createElement('div')
  grid.className = 'flex flex-col gap-2'

  // Showcase chips first — one-click, no consent dialog needed.
  for (const entry of SHOWCASE_PROMPTS) {
    grid.appendChild(buildPromptChip(entry, refresh))
  }
  // Then scenario-backed demos (currently just Watch Me).
  for (const scenario of scenarios) {
    grid.appendChild(buildScenarioCard(scenario, refresh))
  }

  wrap.appendChild(grid)
  return wrap
}

// Per-call token — incremented on every render-strip entry. The async
// fetch+append phase checks the token on resume; if a newer call has run
// in the meantime, the older one drops out instead of double-appending.
let renderToken = 0

export const renderScenarioStrip = async (
  messagesContainer: HTMLElement,
  isCurrentRoomEmpty: () => boolean,
): Promise<void> => {
  const myToken = ++renderToken
  for (const el of messagesContainer.querySelectorAll(`#${STRIP_ID}`)) el.remove()

  if (!isCurrentRoomEmpty()) return
  if (await hasOwnedActiveRun()) return
  if (myToken !== renderToken) return

  const scenarios = await fetchDemoScenarios()
  if (myToken !== renderToken) return

  // Re-check both predicates after the awaits — state may have changed.
  if (!isCurrentRoomEmpty()) return
  if (await hasOwnedActiveRun()) return
  if (myToken !== renderToken) return

  const refresh = (): void => { void renderScenarioStrip(messagesContainer, isCurrentRoomEmpty) }
  messagesContainer.appendChild(buildStrip(scenarios, refresh))
}
