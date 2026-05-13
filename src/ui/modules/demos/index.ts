// ============================================================================
// Demos feature — barrel + UI glue.
//
// Exports:
//   - renderDemoStrip(container, roomId, isEmpty)   empty-room cards
//   - openDemosNavPicker()                          Settings → Demos modal
//   - openDemoModal(demoId)                         active demo modal
//   - refreshDemoHeaderIcon()                       🎬 header pin
//   - initDemoDeepLink()                            ?demo=<id> handler
//   - clearDemoForRoom(roomId)                      cleanup on room_deleted
// ============================================================================

import { createModal } from '../modals/detail-modal.ts'
import { showToast } from '../toast.ts'
import { icon } from '../icon.ts'
import { $selectedRoomId } from '../stores.ts'
import { DEMO_CATALOG, getDemo, type Demo } from './catalog.ts'
import { openDemoModal, refreshDemoHeaderIcon } from './demo-modal.ts'
import { $activeDemoByRoom, clearDemoForRoom } from './active-demo-store.ts'

// Build a shareable URL for a demo. Uses the current origin + path so the
// link works whether served from `/`, `/?instance=xyz`, etc. The receiver's
// boot handler in initDemoDeepLink() reads `?demo=<id>` and triggers the
// same flow as clicking the card in the picker modal.
const demoShareUrl = (demo: Demo): string =>
  `${window.location.origin}${window.location.pathname}?demo=${encodeURIComponent(demo.id)}`

export { openDemoModal, refreshDemoHeaderIcon, clearDemoForRoom }

// === Empty-room strip =========================================================

const STRIP_ID = 'demo-empty-state-strip'

export const renderDemoStrip = (
  container: HTMLElement,
  _roomId: string,
  isCurrentRoomEmpty: () => boolean,
): void => {
  // Remove any previous strip — idempotent.
  for (const el of container.querySelectorAll(`#${STRIP_ID}`)) el.remove()
  if (!isCurrentRoomEmpty()) return

  const wrap = document.createElement('div')
  wrap.id = STRIP_ID
  wrap.className = 'mt-4 mx-4 p-3 rounded border border-border bg-surface-muted'

  const header = document.createElement('div')
  header.className = 'text-xs text-text-subtle mb-2'
  header.textContent = 'Try a demo →'
  wrap.appendChild(header)

  const grid = document.createElement('div')
  grid.className = 'flex flex-col gap-2'
  for (const demo of DEMO_CATALOG) {
    const btn = document.createElement('button')
    btn.className = 'w-full text-left px-3 py-2 rounded border border-border bg-surface hover:bg-surface-strong'
    btn.title = demo.blurb
    const t = document.createElement('div')
    t.className = 'text-sm font-semibold text-text'
    t.textContent = demo.title
    const d = document.createElement('div')
    d.className = 'text-xs text-text-subtle'
    d.textContent = demo.blurb.split(/(?<=\.)\s/)[0] ?? demo.blurb
    btn.appendChild(t)
    btn.appendChild(d)
    btn.addEventListener('click', () => { void openDemoModal(demo.id) })
    grid.appendChild(btn)
  }
  wrap.appendChild(grid)
  container.appendChild(wrap)
}

// === Settings → Demos nav picker ==============================================

export const openDemosNavPicker = async (): Promise<void> => {
  const modal = createModal({ title: 'Demos', width: 'max-w-xl' })

  const intro = document.createElement('p')
  intro.className = 'text-sm text-text-subtle mb-3'
  intro.textContent = 'Pick a demo. It pins to the current room — switching demos wipes the previous pin.'
  modal.scrollBody.appendChild(intro)

  for (const demo of DEMO_CATALOG) {
    const card = document.createElement('div')
    card.className = 'mb-2 rounded border border-border bg-surface'

    // Clickable upper section — same affordance as before (open the demo).
    const btn = document.createElement('button')
    btn.className = 'w-full text-left px-3 py-2 hover:bg-surface-strong rounded-t'
    const t = document.createElement('div')
    t.className = 'text-sm font-semibold text-text'
    t.textContent = demo.title
    const d = document.createElement('div')
    d.className = 'text-xs text-text-subtle mt-0.5'
    d.textContent = demo.blurb
    btn.appendChild(t)
    btn.appendChild(d)
    btn.addEventListener('click', () => {
      modal.close()
      void openDemoModal(demo.id)
    })
    card.appendChild(btn)

    // URL strip — click "copy" to copy the share link. The URL is rendered
    // truncated so a long origin/path doesn't break the layout.
    const url = demoShareUrl(demo)
    const urlRow = document.createElement('div')
    urlRow.className = 'flex items-center gap-2 px-3 py-1.5 border-t border-border bg-surface-muted rounded-b text-xs text-text-subtle'

    const urlSpan = document.createElement('span')
    urlSpan.className = 'flex-1 min-w-0 truncate font-mono'
    urlSpan.textContent = url
    urlSpan.title = url
    urlRow.appendChild(urlSpan)

    const copyBtn = document.createElement('button')
    copyBtn.className = 'shrink-0 px-2 py-0.5 hover:bg-surface-strong rounded inline-flex items-center gap-1'
    copyBtn.setAttribute('aria-label', `Copy share link for ${demo.title}`)
    copyBtn.title = 'Copy link'
    copyBtn.appendChild(icon('copy', { size: 14 }))
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      try {
        await navigator.clipboard.writeText(url)
        // Brief inline confirmation — swap icon to 'check' for 1.2s.
        copyBtn.innerHTML = ''
        copyBtn.appendChild(icon('check', { size: 14 }))
        setTimeout(() => {
          copyBtn.innerHTML = ''
          copyBtn.appendChild(icon('copy', { size: 14 }))
        }, 1200)
      } catch {
        showToast(document.body, 'Copy failed — select the URL manually.', { type: 'error', position: 'fixed' })
      }
    })
    urlRow.appendChild(copyBtn)

    card.appendChild(urlRow)
    modal.scrollBody.appendChild(card)
  }

  document.body.appendChild(modal.overlay)
}

// === Deep-link =================================================================

export const initDemoDeepLink = (): void => {
  // Re-render header icon whenever the active-demo map or the selected room
  // changes. Both are cheap.
  $activeDemoByRoom.listen(() => refreshDemoHeaderIcon())
  $selectedRoomId.listen(() => refreshDemoHeaderIcon())
  refreshDemoHeaderIcon()

  const url = new URL(window.location.href)
  const param = url.searchParams.get('demo')
  if (!param) return
  url.searchParams.delete('demo')
  window.history.replaceState(null, '', url.toString())

  const demo = getDemo(param)
  if (!demo) return

  // If a room is already open, launch immediately. Otherwise wait for the
  // first room-select and launch then. One-shot.
  const tryLaunch = (): boolean => {
    const roomId = $selectedRoomId.get()
    if (!roomId) return false
    void openDemoModal(demo.id)
    return true
  }
  if (tryLaunch()) return
  const off = $selectedRoomId.listen(() => {
    if (tryLaunch()) off()
  })
}
