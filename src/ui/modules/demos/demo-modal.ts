// ============================================================================
// Demo modal — opens for the currently-active demo. Shows blurb + clickable
// prompt rows. Click a row → post the prompt as the current human into the
// current room. Also wires the 🎬 header-icon that re-opens the modal while
// a demo is pinned.
// ============================================================================

import { createModal } from '../modals/detail-modal.ts'
import { showToast } from '../toast.ts'
import { send } from '../ws-send.ts'
import { $selectedRoomId, $rooms, $agents, $roomMembers, $selectedHumanByRoom } from '../stores.ts'
import { icon } from '../icon.ts'
import { getDemo, type Demo, type DemoPrompt } from './catalog.ts'
import { $activeDemoByRoom } from './active-demo-store.ts'

// Post `content` as if the user typed it in chat. Mirrors the same
// resolution logic the chat form uses (sender = last-picked human for
// the room, or the sole human if exactly one is present). Returns false
// with a toast when prerequisites aren't met.
const sendAsCurrentHuman = (content: string): boolean => {
  const roomId = $selectedRoomId.get()
  if (!roomId) {
    showToast(document.body, 'Open a room first to try a demo prompt.', { type: 'error', position: 'fixed' })
    return false
  }
  const roomName = $rooms.get()[roomId]?.name
  if (!roomName) return false

  const members = $roomMembers.get()[roomId] ?? []
  const agents = $agents.get()
  const memberAgents = members.map(id => agents[id]).filter((a): a is NonNullable<typeof a> => !!a)
  const humans = memberAgents.filter(a => a.kind === 'human')
  const ais = memberAgents.filter(a => a.kind === 'ai')

  if (humans.length === 0) {
    showToast(document.body, 'This room has no human member to post as. Add one in the room members panel.', { type: 'error', position: 'fixed', durationMs: 8000 })
    return false
  }
  if (ais.length === 0) {
    showToast(document.body, 'No AI in this room — the prompt will post, but no agent will reply. Add an AI from the room members panel.', { type: 'error', position: 'fixed', durationMs: 8000 })
    // Continue anyway — the user explicitly clicked the demo prompt.
  }

  let senderId = $selectedHumanByRoom.get()[roomId]
  if (!senderId) {
    if (humans.length === 1) {
      senderId = humans[0]!.id
      $selectedHumanByRoom.setKey(roomId, senderId)
    } else {
      showToast(document.body, 'Multiple humans in this room — pick one with the send-as control, then click the prompt again.', { type: 'error', position: 'fixed', durationMs: 8000 })
      return false
    }
  }

  send({ type: 'post_message', target: { rooms: [roomName] }, content, senderId })
  return true
}

const buildPromptRow = (entry: DemoPrompt, onSent: () => void): HTMLButtonElement => {
  const btn = document.createElement('button')
  btn.className = 'w-full text-left px-3 py-2 mb-2 rounded border border-border bg-surface hover:bg-surface-strong'
  btn.title = entry.prompt

  const label = document.createElement('div')
  label.className = 'text-sm font-semibold text-text'
  label.textContent = entry.label

  const desc = document.createElement('div')
  desc.className = 'text-xs text-text-subtle mt-0.5'
  desc.textContent = entry.description

  btn.appendChild(label)
  btn.appendChild(desc)
  btn.addEventListener('click', () => {
    if (sendAsCurrentHuman(entry.prompt)) onSent()
  })
  return btn
}

// Ensure the demo packs are merged into the current room's active set.
// Awaited so the user can't click a prompt before activation lands and
// hit "no tools available." Returns true iff activation succeeded (or
// was a no-op because packs were already active).
const ensureRoomPacks = async (roomId: string, packs: ReadonlyArray<string>): Promise<boolean> => {
  if (packs.length === 0) return true
  const roomName = $rooms.get()[roomId]?.name
  if (!roomName) return false
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/packs`)
    if (!res.ok) return false
    const data = await res.json() as { activePacks?: ReadonlyArray<string> }
    const current = new Set(data.activePacks ?? [])
    let changed = false
    for (const p of packs) {
      if (!current.has(p)) { current.add(p); changed = true }
    }
    if (!changed) return true
    const put = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/packs`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activePacks: [...current] }),
    })
    return put.ok
  } catch {
    return false
  }
}

// Leitbild demo setup: create a fresh oslo-ambulance CI on
// leitbild.samsinn.app, bind the current room's mirror to it, and
// patch any AI agents in the room to add a matching leitbildBinding
// + the lb_* read tools. If no AI is in the room, the mirror still
// works and the iframe shows; the user just won't get agent answers
// to the demo prompts until they add an AI member.
const setupLeitbildDemo = async (roomId: string): Promise<{ ok: true; instanceId: string } | { ok: false; reason: string }> => {
  const roomName = $rooms.get()[roomId]?.name
  if (!roomName) return { ok: false, reason: 'Room not found' }
  const LEITBILD_BASE = 'https://leitbild.samsinn.app'

  // 1. Create a fresh CI on Leitbild
  let instanceId: string
  try {
    const res = await fetch(`${LEITBILD_BASE}/api/control-instances`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenarioId: 'oslo-ambulance' }),
    })
    if (!res.ok) return { ok: false, reason: `Failed to create CI on Leitbild: HTTP ${res.status}` }
    const body = await res.json() as { id?: string }
    if (!body.id) return { ok: false, reason: 'Leitbild returned no instance id' }
    instanceId = body.id
  } catch (err) {
    return { ok: false, reason: `Could not reach Leitbild: ${(err as Error).message}` }
  }

  // 2. Bind the room mirror
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/leitbild-mirror`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ baseUrl: LEITBILD_BASE, instanceId, format: 'summary' }),
    })
    if (!res.ok) return { ok: false, reason: `Failed to bind room mirror: HTTP ${res.status}` }
  } catch (err) {
    return { ok: false, reason: `Bind error: ${(err as Error).message}` }
  }

  // 3. PATCH any AI members of the room with leitbildBinding + lb_* tools.
  const members = $roomMembers.get()[roomId] ?? []
  const agents = $agents.get()
  const ais = members.map(id => agents[id]).filter((a): a is NonNullable<typeof a> => !!a && a.kind === 'ai')
  for (const ai of ais) {
    try {
      // Fetch current tools so we don't overwrite the agent's allowlist.
      const detailRes = await fetch(`/api/agents/${encodeURIComponent(ai.name)}`, { credentials: 'same-origin' })
      const detail = detailRes.ok ? await detailRes.json() as { tools?: ReadonlyArray<string> } : { tools: [] as string[] }
      const existingTools = new Set(detail.tools ?? [])
      const lbTools = ['lb_state', 'lb_object', 'lb_query', 'lb_scenario', 'lb_dispatch_context']
      for (const t of lbTools) existingTools.add(t)
      await fetch(`/api/agents/${encodeURIComponent(ai.name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          tools: [...existingTools],
          leitbildBinding: { baseUrl: LEITBILD_BASE, instanceId, role: 'observer' },
        }),
      })
    } catch { /* non-fatal — toast in caller will note no-AI case */ }
  }

  return { ok: true, instanceId }
}

// Best-effort: install an external pack if it isn't already present.
// Biometrics demo uses this for `samsinn-packs/biometrics`. Awaited so
// the room-pack-activation step (which only succeeds if the pack is
// already known) finds it.
const ensurePackInstalled = async (packShortName: string, registryFullName: string): Promise<void> => {
  try {
    const res = await fetch('/api/packs')
    if (!res.ok) return
    const data = await res.json() as { packs?: ReadonlyArray<{ namespace: string }> }
    const installed = (data.packs ?? []).some(p => p.namespace === packShortName)
    if (installed) return
    await fetch('/api/packs/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: registryFullName }),
    })
  } catch { /* non-fatal — modal still opens; tool calls will surface a clearer error */ }
}

export const openDemoModal = async (demoId: string): Promise<void> => {
  const demo = getDemo(demoId)
  if (!demo) {
    showToast(document.body, `Unknown demo: ${demoId}`, { type: 'error', position: 'fixed' })
    return
  }
  const roomId = $selectedRoomId.get()
  if (!roomId) {
    showToast(document.body, 'Open a room first, then launch the demo.', { type: 'error', position: 'fixed' })
    return
  }

  // Side-effects: install biometrics if needed, then merge required packs
  // into the current room's active set so the tools become visible to the
  // AI BEFORE the user can click a prompt. Order matters: pack must be
  // installed before activation can succeed.
  if (demo.id === 'biometrics') {
    await ensurePackInstalled('biometrics', 'samsinn-packs/biometrics')
  }
  if (demo.id === 'leitbild') {
    const setup = await setupLeitbildDemo(roomId)
    if (setup.ok === false) {
      showToast(document.body, `Leitbild demo setup failed: ${setup.reason}`, { type: 'error', position: 'fixed', durationMs: 10000 })
      return
    }
    // Inform the user — and warn if no AI to consume the agent tools.
    const aiCount = ($roomMembers.get()[roomId] ?? [])
      .map(id => $agents.get()[id])
      .filter(a => !!a && a.kind === 'ai').length
    const aiHint = aiCount > 0
      ? `${aiCount} AI agent${aiCount > 1 ? 's' : ''} configured with lb_* tools.`
      : 'Add an AI agent to this room (from room members panel) so it can use the lb_* tools — then try the prompts.'
    showToast(document.body, `Leitbild bound: ${setup.instanceId.slice(0, 36)}… · ${aiHint}`, { type: 'success', position: 'fixed', durationMs: 10000 })
  }
  const activated = await ensureRoomPacks(roomId, demo.requiredPacks)
  if (!activated) {
    showToast(document.body, `Couldn't activate required packs (${demo.requiredPacks.join(', ')}) — the AI may not see this demo's tools.`, { type: 'error', position: 'fixed', durationMs: 8000 })
  }

  $activeDemoByRoom.setKey(roomId, demo.id)

  const modal = createModal({ title: demo.title, width: 'max-w-2xl' })

  const blurb = document.createElement('p')
  blurb.className = 'text-sm text-text mb-3'
  blurb.textContent = demo.blurb
  modal.scrollBody.appendChild(blurb)

  const hint = document.createElement('div')
  hint.className = 'text-xs text-text-subtle mb-2'
  hint.textContent = `Click any prompt to post it as you in the current room:`
  modal.scrollBody.appendChild(hint)

  const onSent = (): void => { modal.close() }
  for (const p of demo.prompts) {
    modal.scrollBody.appendChild(buildPromptRow(p, onSent))
  }

  document.body.appendChild(modal.overlay)
}

// === Room-header icon ============================================================
// Ensure a 🎬 button is present in the room header iff a demo is pinned for
// the currently-selected room. Click → re-open the demo modal.

const HEADER_ICON_ID = 'demo-header-icon'

const buildHeaderIcon = (demo: Demo): HTMLButtonElement => {
  const btn = document.createElement('button')
  btn.id = HEADER_ICON_ID
  btn.setAttribute('data-room-icon-id', 'demo')
  btn.setAttribute('data-room-icon-label', 'Demo')
  btn.className = 'mode-btn icon-btn'
  btn.title = `Open ${demo.title}`
  btn.setAttribute('aria-label', `Open ${demo.title}`)
  btn.appendChild(icon('wand', { size: 16, title: demo.title }))
  btn.addEventListener('click', () => { void openDemoModal(demo.id) })
  return btn
}

export const refreshDemoHeaderIcon = (): void => {
  const roomId = $selectedRoomId.get()
  // Room header layout: `#room-header > div(name) + div(icon-cluster)` with
  // `justify-between`. Append into the icon cluster (second child) so the
  // existing right-aligned cluster keeps its layout. Appending to
  // `#room-header` directly adds a third flex child and the name/cluster
  // pair collapses to centered.
  const cluster = document.querySelector('#room-header > div:nth-child(2)') as HTMLElement | null
  if (!cluster) return
  const existingGroup = document.getElementById(`${HEADER_ICON_ID}-group`)
  const removeIcon = (): void => { existingGroup?.remove() }
  if (!roomId) { removeIcon(); return }
  const demoId = $activeDemoByRoom.get()[roomId]
  if (!demoId) { removeIcon(); return }
  const demo = getDemo(demoId)
  if (!demo) { removeIcon(); return }
  if (existingGroup) return  // already correct
  // Append as a new toolbar-group at the end of the icon cluster so the
  // wand sits to the right of the Summary group, with a divider.
  const group = document.createElement('div')
  group.className = 'toolbar-group toolbar-divider'
  group.id = `${HEADER_ICON_ID}-group`
  group.appendChild(buildHeaderIcon(demo))
  cluster.appendChild(group)
}
