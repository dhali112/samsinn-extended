// ============================================================================
// Message Router — Routes messages to rooms.
//
// Room.post() handles storage and member delivery internally.
// correlationId is shared across all rooms in a single routing call.
// ============================================================================

import type { Message, MessageTarget } from './types/messaging.ts'
import type { RouterDeps, RouteMessage } from './types/agent.ts'

export const createMessageRouter = ({ house }: RouterDeps): RouteMessage => {
  return (target: MessageTarget, params) => {
    const correlationId = crypto.randomUUID()
    const delivered: Message[] = []

    for (const roomId of target.rooms) {
      const room = house.getRoom(roomId)
      if (!room) {
        // Visible to operator so a typo'd / deleted room target is loud
        // instead of silently dropped. The caller's `delivered` array still
        // returns short, but most callers don't compare against target.rooms.
        console.warn(`[router] skipping non-existent room: ${roomId}`)
        continue
      }
      const message = room.post({ ...params, correlationId })
      delivered.push(message)
    }

    return delivered
  }
}
