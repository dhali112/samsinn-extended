// ============================================================================
// resolveActiveWikis — single source of truth for "what wikis are active right
// now" across the server. Replaces the boot-once-then-drift pattern that
// caused the v0.9.x wiki refresh bug (registry frozen at boot, discovery
// changes later, hasWiki(id) returns false on user click → 404).
//
// Every consumer that needs the active set — REST routes, agent tools,
// background warmers — should go through this function. The registry's
// internal state (per-wiki adapter + page cache) is reconciled on each call,
// so callers never observe a stale id-set.
//
// Cost: one disk read of wikis.json + one discovery call (cached 5 min).
// Trivially cheap for the failure mode it prevents.
// ============================================================================

import type { WikiRegistry } from './registry.ts'
import type { MergedWikiEntryWithSource } from './store.ts'
import type { DiscoveredWiki } from './discovery.ts'
import { loadWikiStore, mergeWithDiscovery } from './store.ts'
import { getAvailableWikis } from './discovery.ts'
import { scanPackWikis } from './pack-source.ts'

export const resolveActiveWikis = async (
  storePath: string,
  registry: WikiRegistry,
  packsDir?: string,
): Promise<ReadonlyArray<MergedWikiEntryWithSource>> => {
  const { data: store } = await loadWikiStore(storePath)
  let discovered: ReadonlyArray<DiscoveredWiki> = []
  try { discovered = await getAvailableWikis() } catch { /* discovery failures are non-fatal */ }
  const merged = mergeWithDiscovery(store, discovered)

  // Pack-bundled wikis layered on top: each <pack>/wikis/<slug>/ becomes a
  // MergedWikiEntry with dirPath set, routed to the filesystem adapter by
  // the registry's default factory. Their ids are namespaced (`<pack>:<slug>`)
  // so they can't collide with operator-configured or discovered ids.
  // packsDir undefined = caller (test, MCP-only) doesn't have a packs root;
  // skip pack scan entirely.
  let packWikis: ReadonlyArray<MergedWikiEntryWithSource> = []
  if (packsDir) {
    try {
      const scanned = await scanPackWikis(packsDir)
      packWikis = scanned.map(w => ({ ...w, source: 'pack' as const }))
    } catch (err) {
      console.warn(`[wiki/pack] scan failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const all = [...merged, ...packWikis]
  registry.reconcile(all.filter(w => w.enabled))
  return all
}
