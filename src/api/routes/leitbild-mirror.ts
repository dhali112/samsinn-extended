// ============================================================================
// Routes for the Leitbild mirror binding on a Samsinn room.
//
// V1: read-only mirror — bind a room to a Leitbild Control Instance.
// Three endpoints:
//   PUT    /api/rooms/:name/leitbild-mirror   set/replace config + attach
//   DELETE /api/rooms/:name/leitbild-mirror   clear + detach
//   GET    /api/rooms/:name/leitbild-mirror   introspect current state
// ============================================================================

import { errorResponse, json, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import type { LeitbildMirrorConfig } from '../../core/types/room.ts'

const parseMirrorConfig = (body: Record<string, unknown>): LeitbildMirrorConfig | { error: string } => {
  if (typeof body.baseUrl !== 'string' || body.baseUrl.trim() === '') return { error: 'baseUrl is required' }
  if (typeof body.instanceId !== 'string' || body.instanceId.trim() === '') return { error: 'instanceId is required' }
  const format = body.format ?? 'summary'
  if (format !== 'summary' && format !== 'full') return { error: 'format must be "summary" or "full"' }
  try { new URL(body.baseUrl) } catch { return { error: 'baseUrl must be a valid URL' } }
  return { baseUrl: body.baseUrl, instanceId: body.instanceId, format }
}

export const leitbildMirrorRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: async (_req, match, { system, leitbildMirror }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      // Lazy self-heal: if room has persisted config but service has no
      // record (Samsinn was restarted), reattach silently. Idempotent —
      // attach() detaches any prior mirror first.
      const persisted = room.getLeitbildMirror()
      const status = leitbildMirror?.statusFor(room)
      if (persisted && leitbildMirror && (!status || !status.connected)) {
        try { await leitbildMirror.attach(room, persisted) } catch { /* surfaced via mirror-error message */ }
      }
      return json({ status: leitbildMirror?.statusFor(room) ?? null })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: async (req, match, { system, leitbildMirror }) => {
      if (!leitbildMirror) return errorResponse('Leitbild integration not initialized', 503)
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const parsed = parseMirrorConfig(body)
      if ('error' in parsed) return errorResponse(parsed.error, 400)
      try {
        await leitbildMirror.attach(room, parsed)
        return json({ status: leitbildMirror.statusFor(room) ?? null }, 200)
      } catch (err) {
        return errorResponse(`attach failed: ${(err as Error).message}`, 502)
      }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: (_req, match, { system, leitbildMirror }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      leitbildMirror?.detach(room)
      return json({ status: null })
    },
  },
]
