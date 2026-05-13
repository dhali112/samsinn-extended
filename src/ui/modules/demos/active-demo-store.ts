// ============================================================================
// $activeDemoByRoom — per-room nanostore mapping roomId → active DemoId.
// Persisted to localStorage so a refresh keeps the 🎬 pin in place.
// Cleaned up when a room is deleted (wired in app.ts).
// ============================================================================

import { map } from '../../lib/nanostores.ts'
import type { DemoId } from './catalog.ts'

const STORAGE_KEY = 'samsinn:active-demo-by-room'

const loadInitial = (): Record<string, DemoId> => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, DemoId>
    if (parsed && typeof parsed === 'object') return parsed
  } catch { /* fall through */ }
  return {}
}

export const $activeDemoByRoom = map<Record<string, DemoId>>(loadInitial())

$activeDemoByRoom.listen((value) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)) } catch { /* quota / private mode */ }
})

// Drop the entry for a deleted room. Wired in app.ts on the room_deleted
// WS event so stale ids don't accumulate.
export const clearDemoForRoom = (roomId: string): void => {
  const current = $activeDemoByRoom.get()
  if (!(roomId in current)) return
  const { [roomId]: _removed, ...rest } = current
  $activeDemoByRoom.set(rest)
}
