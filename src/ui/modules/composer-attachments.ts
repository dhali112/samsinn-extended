// ============================================================================
// Composer attachments — per-room pending image attachments for the chat
// input. Used by the Leitbild iframe panel's screenshot button (and any
// future "attach image" entry point).
//
// Lifecycle:
//   - addAttachment(roomId, attachment)  — pushed onto the pending list
//   - getAttachments(roomId)             — read for the send handler
//   - removeAttachment(roomId, idx)      — chip × button
//   - clearAttachments(roomId)           — called on successful post
//   - subscribe(roomId, listener)        — re-render chip strip on change
//
// State is in-memory only. Pending attachments are NOT persisted; if the
// user reloads before sending they are gone. This matches the existing
// behavior of unsent chat input text.
// ============================================================================

import type { MessageAttachment } from '../../core/types/messaging.ts'

type Listener = (attachments: ReadonlyArray<MessageAttachment>) => void

const byRoom = new Map<string, MessageAttachment[]>()
const listenersByRoom = new Map<string, Set<Listener>>()

const notify = (roomId: string): void => {
  const ls = listenersByRoom.get(roomId)
  if (!ls) return
  const current = byRoom.get(roomId) ?? []
  for (const l of ls) {
    try { l(current) } catch { /* listener errors don't kill the store */ }
  }
}

export const addAttachment = (roomId: string, attachment: MessageAttachment): void => {
  const list = byRoom.get(roomId) ?? []
  list.push(attachment)
  byRoom.set(roomId, list)
  notify(roomId)
}

export const removeAttachment = (roomId: string, index: number): void => {
  const list = byRoom.get(roomId)
  if (!list || index < 0 || index >= list.length) return
  list.splice(index, 1)
  byRoom.set(roomId, list)
  notify(roomId)
}

export const getAttachments = (roomId: string): ReadonlyArray<MessageAttachment> => {
  return byRoom.get(roomId) ?? []
}

export const clearAttachments = (roomId: string): void => {
  if (!byRoom.has(roomId)) return
  byRoom.delete(roomId)
  notify(roomId)
}

export const subscribe = (roomId: string, listener: Listener): () => void => {
  let ls = listenersByRoom.get(roomId)
  if (!ls) { ls = new Set(); listenersByRoom.set(roomId, ls) }
  ls.add(listener)
  // Fire once so the listener sees current state.
  try { listener(byRoom.get(roomId) ?? []) } catch { /* */ }
  return () => {
    const s = listenersByRoom.get(roomId)
    s?.delete(listener)
  }
}

// === DOM helper: chip strip ===
//
// Renders a horizontal scrollable strip of thumbnail chips into the given
// host element. Each chip shows a 60x40 image preview + × button to
// remove. Auto-updates on store changes.

export const mountAttachmentChips = (host: HTMLElement, getRoomId: () => string | undefined): () => void => {
  let unsubscribe: (() => void) | undefined
  let currentRoom: string | undefined

  const render = (atts: ReadonlyArray<MessageAttachment>): void => {
    if (atts.length === 0) {
      host.innerHTML = ''
      host.style.display = 'none'
      return
    }
    host.style.display = 'flex'
    host.style.flexWrap = 'wrap'
    host.style.gap = '6px'
    host.style.padding = '6px'
    host.style.borderTop = '1px solid var(--border, #374151)'
    host.style.background = 'var(--surface-soft, #1a2332)'
    host.innerHTML = ''
    atts.forEach((att, idx) => {
      const chip = document.createElement('div')
      chip.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 6px;border:1px solid var(--border, #374151);border-radius:6px;background:var(--surface, #0f172a);max-width:200px'
      const img = document.createElement('img')
      img.src = att.dataUrl
      img.style.cssText = 'width:60px;height:40px;object-fit:cover;border-radius:3px;cursor:pointer;flex:0 0 auto'
      img.title = `Click to preview · ${att.width}×${att.height}`
      img.addEventListener('click', () => openPreview(att))
      const meta = document.createElement('span')
      meta.style.cssText = 'font-size:11px;color:var(--text-subtle, #94a3b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
      meta.textContent = `${att.source ?? 'image'} · ${att.width}×${att.height}`
      const removeBtn = document.createElement('button')
      removeBtn.type = 'button'
      removeBtn.textContent = '×'
      removeBtn.title = 'Remove this attachment'
      removeBtn.style.cssText = 'background:none;border:none;color:var(--text-subtle, #94a3b8);font-size:18px;cursor:pointer;padding:0 4px;line-height:1;flex:0 0 auto'
      removeBtn.addEventListener('click', () => {
        const roomId = getRoomId()
        if (roomId) removeAttachment(roomId, idx)
      })
      chip.appendChild(img)
      chip.appendChild(meta)
      chip.appendChild(removeBtn)
      host.appendChild(chip)
    })
  }

  const refresh = (): void => {
    if (unsubscribe) unsubscribe()
    currentRoom = getRoomId()
    if (!currentRoom) {
      host.innerHTML = ''
      host.style.display = 'none'
      return
    }
    unsubscribe = subscribe(currentRoom, render)
  }

  refresh()
  // Return a re-subscribe function so callers can re-target when the
  // active room changes.
  return refresh
}

// === Preview modal — click thumbnail → full-size view ===

const openPreview = (att: MessageAttachment): void => {
  const overlay = document.createElement('div')
  overlay.style.cssText = 'position:fixed;inset:0;z-index:5000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;cursor:zoom-out'
  overlay.addEventListener('click', () => overlay.remove())
  const img = document.createElement('img')
  img.src = att.dataUrl
  img.style.cssText = 'max-width:95vw;max-height:95vh;box-shadow:0 8px 32px rgba(0,0,0,0.5)'
  overlay.appendChild(img)
  document.body.appendChild(overlay)
}
