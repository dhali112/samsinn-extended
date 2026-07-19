// Plant historian trend data — backend for the front-end trend control.
//
//   GET /api/trends/tags — tag catalog (name, label, unit, kind, limits)
//   GET /api/trends/data?tags=A,B&window=8h
//                        ?tags=A&from=ISO&to=ISO
//                        ?tags=A&points=N
//     → { from, to, modeLabel, series, events, analysis }
//
// The trend control in the UI fetches from these endpoints directly; trend
// fences in chat carry only a config (pens + time axis), never data.

import { TREND_TAGS, queryTrends, setSelectedRegion, getSelectedRegion } from '../../trends/historian.ts'
import { json, errorResponse } from './helpers.ts'
import type { RouteEntry } from './types.ts'

export const trendRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/trends\/tags$/,
    handler: () =>
      json(Object.entries(TREND_TAGS).map(([tag, m]) => ({
        tag, label: m.label, unit: m.unit, kind: m.kind, category: m.category,
        ...(m.limits ? { limits: m.limits } : {}),
      }))),
  },
  {
    method: 'GET',
    pattern: /^\/api\/trends\/data$/,
    handler: async (req) => {
      const url = new URL(req.url)
      const tags = (url.searchParams.get('tags') ?? '').split(',').map(s => s.trim()).filter(Boolean)
      const window = url.searchParams.get('window') ?? undefined
      const from = url.searchParams.get('from') ?? undefined
      const to = url.searchParams.get('to') ?? undefined
      const pointsRaw = url.searchParams.get('points')
      const points = pointsRaw !== null ? Number(pointsRaw) : undefined

      const result = await queryTrends({ tags, window, from, to, points })
      if ('error' in result) return errorResponse(result.error, 400)
      return json(result)
    },
  },
  {
    // Operator region selection (Region mode drag on a trend display).
    // Stored server-side so the agent can resolve "the window shown"
    // via trend_query { useSelectedRegion: true }.
    method: 'POST',
    pattern: /^\/api\/trends\/selection$/,
    handler: async (req) => {
      let body: { from?: number; to?: number; tags?: string[] } | null
      try { body = await req.json() as typeof body } catch { return errorResponse('Invalid JSON body', 400) }
      if (body === null || body.from === undefined || body.to === undefined) {
        setSelectedRegion(null)
        return json({ cleared: true })
      }
      if (typeof body.from !== 'number' || typeof body.to !== 'number' || body.from >= body.to) {
        return errorResponse('Selection needs numeric from < to (epoch seconds)', 400)
      }
      setSelectedRegion({ from: body.from, to: body.to, tags: Array.isArray(body.tags) ? body.tags.map(String) : [] })
      return json({ saved: true })
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/trends\/selection$/,
    handler: () => json({ selection: getSelectedRegion() }),
  },
]
