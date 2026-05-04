import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { MessageTarget } from '../../../core/types/messaging.ts'
import type { System } from '../../../main.ts'
import { textResult, errorResult, resolveRoom } from './helpers.ts'
import { asAIAgent } from '../../../agents/shared.ts'
import { exportRoomConversation } from '../../../core/rooms/room-export.ts'
import { waitForRoomIdle } from '../../../core/wait-for-idle.ts'

export const registerMessageTools = (mcpServer: McpServer, system: System): void => {
  mcpServer.tool(
    'post_message',
    'Post a message to one or more rooms. Use this to inject messages into conversations.',
    {
      content: z.string().describe('Message content'),
      senderId: z.string().default('mcp-client').describe('Sender ID'),
      senderName: z.string().optional().describe('Sender display name'),
      roomNames: z.array(z.string()).describe('Room names to post to'),
    },
    async ({ content, senderId, senderName, roomNames }) => {
      try {
        const target: MessageTarget = { rooms: roomNames }
        const messages = system.routeMessage(target, {
          senderId,
          senderName: senderName ?? senderId,
          content,
          type: 'chat',
        })
        return textResult({ delivered: messages.length, messages })
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Failed to post message')
      }
    },
  )

  mcpServer.tool(
    'get_room_messages',
    'Get recent messages from a room',
    {
      roomName: z.string().describe('Room name'),
      limit: z.number().default(50).describe('Max messages to return'),
    },
    async ({ roomName, limit }) => {
      try {
        const room = resolveRoom(system, roomName)
        return textResult(room.getRecent(limit))
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'Room not found')
      }
    },
  )

  mcpServer.tool(
    'wait_for_idle',
    'Wait for a room to become idle. Returns {idle, capped, messageCount, lastMessageAt, elapsedMs}. Idle = no new message for quietMs AND all in-room AI agents resolved whenIdle. Capped = room hit maxMessages before quiescence (if set). Polls every 500ms.',
    {
      roomName: z.string().describe('Room name'),
      quietMs: z.number().int().default(5000).describe('Quiet period before idle fires (ms)'),
      timeoutMs: z.number().int().default(120000).describe('Max wait before returning idle:false (ms)'),
      maxMessages: z.number().int().optional().describe('Hard cap on room message count. When reached, returns with capped:true immediately — useful for preventing runaway agent loops.'),
    },
    async ({ roomName, quietMs, timeoutMs, maxMessages }) => {
      try {
        const room = resolveRoom(system, roomName)
        const result = await waitForRoomIdle(room, {
          quietMs,
          timeoutMs,
          ...(maxMessages !== undefined ? { maxMessages } : {}),
          inRoomAIAgents: () => room.getParticipantIds()
            .map(id => system.team.getAgent(id))
            .flatMap(a => { const ai = a ? asAIAgent(a) : null; return ai ? [ai] : [] }),
        })
        return textResult(result)
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'wait_for_idle failed')
      }
    },
  )

  mcpServer.tool(
    'export_room',
    'Export the full conversation of a room as JSON: {roomId, roomName, exportedAt, messageCount, messages}. Each message carries all telemetry fields the system records (tokens, provider, model, generationMs).',
    {
      roomName: z.string().describe('Room name'),
    },
    async ({ roomName }) => {
      try {
        const room = resolveRoom(system, roomName)
        return textResult(exportRoomConversation(room))
      } catch (err) {
        return errorResult(err instanceof Error ? err.message : 'export_room failed')
      }
    },
  )

}
