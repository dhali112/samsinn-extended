// ============================================================================
// Room-data fetchers — HTTP GET for the per-room collections that populate
// on room selection (messages, members).
//
// Each function writes into the appropriate nanostore. Failures log to
// console.error via safeFetchJson — acceptable noise for room-data fetches
// that may race with room deletion on the server.
// ============================================================================

import { safeFetchJson } from './fetch-helpers.ts'
import { $roomMessages, $roomMembers } from './stores.ts'
import type { RoomProfile, UIMessage } from './render/render-types.ts'

export const fetchRoomMessages = async (_roomId: string, roomName: string): Promise<void> => {
  const data = await safeFetchJson<{ profile: RoomProfile; messages: UIMessage[] }>(
    `/api/rooms/${encodeURIComponent(roomName)}?limit=50`,
  )
  if (!data) return
  $roomMessages.setKey(data.profile.id, data.messages)
}

export const fetchRoomMembers = async (roomId: string, roomName: string): Promise<void> => {
  const members = await safeFetchJson<Array<{ id: string }>>(
    `/api/rooms/${encodeURIComponent(roomName)}/members`,
  )
  if (!members) return
  $roomMembers.setKey(roomId, members.map(m => m.id))
}
