// ============================================================================
// Wikis admin routes — read-only post-prune (commit M).
//
// GET    /api/wikis                            list pack-bundled wikis
// POST   /api/wikis/:id/refresh                force re-warm one wiki's pages
//
// Wikis are now distributed exclusively via packs (`<pack>/wikis/<slug>/`).
// Operator-stored wikis (wikis.json) and samsinn-wikis discovery were
// removed in commit M — install/uninstall flows live under
// /api/packs/install (which re-reconciles wikis as a side effect).
// ============================================================================

import { json, errorResponse } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import { resolveActiveWikis } from '../../wiki/resolve-active.ts'

export const wikisRoutes: RouteEntry[] = [
  {
    method: 'GET',
    pattern: /^\/api\/wikis$/,
    handler: async (_req, _match, { system }) => {
      // Single source of truth: resolveActiveWikis scans the packs dir and
      // reconciles the registry on every call. Auto-warm for new ids fires
      // from inside the registry's onNewWiki hook.
      const merged = await resolveActiveWikis(system.wikiRegistry, system.packsDir)
      const live = system.wikiRegistry.list()
      const liveById = new Map(live.map((w) => [w.id, w]))
      const wikis = merged.map((w) => ({
        id: w.id,
        displayName: w.displayName,
        enabled: w.enabled,
        pack: w.pack,
        pageCount: liveById.get(w.id)?.pageCount ?? 0,
        lastWarmAt: liveById.get(w.id)?.lastWarmAt ?? null,
        lastError: liveById.get(w.id)?.lastError ?? null,
      }))
      return json({ wikis, warnings: [] })
    },
  },

  // --- Refresh (force warm) ---
  {
    method: 'POST',
    pattern: /^\/api\/wikis\/([^/]+)\/refresh$/,
    handler: async (_req, match, { system }) => {
      const id = decodeURIComponent(match[1]!)
      // Reconcile before lookup — packs installed since boot become
      // refreshable without operator intervention.
      const merged = await resolveActiveWikis(system.wikiRegistry, system.packsDir)
      if (!merged.some((w) => w.id === id && w.enabled)) {
        return errorResponse(`wiki "${id}" not found`, 404)
      }
      try {
        const result = await system.wikiRegistry.warm(id)
        return json({ ok: true, pageCount: result.pageCount, warnings: result.warnings })
      } catch (err) {
        return errorResponse(`refresh failed: ${(err as Error).message}`, 502)
      }
    },
  },
]
