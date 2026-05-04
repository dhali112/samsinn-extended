// Room list rendering.

import type { RoomProfile } from '../render/render-types.ts'

export interface RenderRoomsOptions {
  rooms: Record<string, RoomProfile>
  selectedRoomId: string | null
  pausedRooms: Set<string>
  unreadCounts: Record<string, number>
  generatingRoomIds: Set<string>
  onSelect: (roomId: string) => void
  onDelete?: (roomId: string, roomName: string) => void
  onTogglePaused?: (roomId: string, roomName: string, nowPaused: boolean) => void
}

export const renderRooms = (
  container: HTMLElement,
  opts: RenderRoomsOptions,
): void => {
  container.innerHTML = ''
  for (const room of Object.values(opts.rooms)) {
    const isPaused = opts.pausedRooms.has(room.id)
    const isSelected = room.id === opts.selectedRoomId
    const unread = opts.unreadCounts[room.id] ?? 0
    const isThinking = opts.generatingRoomIds.has(room.id)
    const div = document.createElement('div')
    div.className = `px-3 py-1 cursor-pointer text-xs flex items-center gap-1.5 group relative ${isSelected ? 'bg-surface-muted font-semibold text-text-strong' : 'text-text hover:bg-surface-muted'}`

    // Status dot doubles as pause toggle (if onTogglePaused provided).
    // Clicking the dot does NOT select the room — it only toggles pause.
    const dot = document.createElement(opts.onTogglePaused ? 'button' : 'span')
    const base = 'inline-block w-2 h-2 rounded-full shrink-0'
    const dotColor = isPaused ? 'bg-border-strong' : isThinking ? 'bg-thinking typing-indicator' : 'bg-success'
    dot.className = `${base} ${dotColor}`
    const onTogglePaused = opts.onTogglePaused
    if (onTogglePaused) {
      const btn = dot as HTMLButtonElement
      btn.type = 'button'
      btn.title = isPaused ? 'Paused — click to resume' : 'Active — click to pause'
      btn.setAttribute('aria-pressed', isPaused ? 'true' : 'false')
      btn.onclick = (e) => { e.stopPropagation(); onTogglePaused(room.id, room.name, !isPaused) }
    }
    div.appendChild(dot)

    const name = document.createElement('span')
    name.className = 'truncate flex-1'
    name.textContent = unread > 0 ? `${room.name} (${unread})` : room.name
    if (unread > 0) name.className += ' font-bold'
    div.appendChild(name)

    const onDelete = opts.onDelete
    if (onDelete) {
      const del = document.createElement('button')
      del.className = 'text-danger hover:text-danger text-xs opacity-0 group-hover:opacity-100 shrink-0'
      del.textContent = '×'
      del.title = 'Delete room'
      del.onclick = (e) => { e.stopPropagation(); onDelete(room.id, room.name) }
      div.appendChild(del)
    }

    div.onclick = () => opts.onSelect(room.id)
    container.appendChild(div)
  }
}
