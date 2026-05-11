// Diagnostic endpoints. Read-only introspection of agent tool surfaces
// and recent evals — the "no more SSH" layer.
//
// GET /api/agents/:name/surface?roomId=:id
//   Pure, no eval triggered. Answers "what does this agent actually see
//   when invoked in this room, and why" with per-tool pack attribution.
//
// GET /api/diagnostics/evals/recent?limit=20&agent=:name
//   Per-instance ring buffer of the last N agent evals, newest first.
//   Filterable by agent name.
//
// GET /api/diagnostics/evals/:traceId
//   Single eval trace — context_ready messages, tool calls, warnings,
//   outcome. The traceId is broadcast on every agent_activity event so
//   the UI can deep-link.

import { json, errorResponse } from './helpers.ts'
import { introspectAgentSurface } from '../../diagnostics/surface-introspect.ts'
import type { RouteEntry } from './types.ts'

export const diagnosticRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/agents\/([^/]+)\/surface$/,
    handler: (req, match, { system }) => {
      const name = decodeURIComponent(match[1]!)
      const url = new URL(req.url)
      const roomId = url.searchParams.get('roomId')
      if (!roomId) return errorResponse('roomId query parameter required', 400)
      const result = introspectAgentSurface(system, name, roomId)
      if ('error' in result) return errorResponse(result.error, 404)
      return json(result)
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/diagnostics\/evals\/recent$/,
    handler: (req, _match, { system }) => {
      const url = new URL(req.url)
      const limit = Number(url.searchParams.get('limit') ?? '20')
      const agent = url.searchParams.get('agent') ?? undefined
      const records = system.evalBuffer.listRecent({
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20,
        ...(agent ? { agent } : {}),
      })
      return json({ records })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/diagnostics\/evals\/([^/]+)$/,
    handler: (_req, match, { system }) => {
      const traceId = decodeURIComponent(match[1]!)
      const rec = system.evalBuffer.getByTraceId(traceId)
      if (!rec) return errorResponse(`trace "${traceId}" not found`, 404)
      return json(rec)
    },
  },
]
