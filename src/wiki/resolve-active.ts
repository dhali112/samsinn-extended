// ============================================================================
// resolveActiveWikis — single source of truth for "what wikis are active right
// now." Post-prune (commit M): wikis only come from packs. Each call scans
// <packsDir>/<ns>/wikis/<slug>/ and reconciles the registry. No GitHub
// discovery, no wikis.json. Cheap (one disk walk per pack-with-wikis) and
// always correct — there's no boot-time freeze for state to drift from.
// ============================================================================

import type { WikiRegistry } from './registry.ts'
import type { MergedWikiEntry } from './types.ts'
import { scanPackWikis } from './pack-source.ts'

export const resolveActiveWikis = async (
  registry: WikiRegistry,
  packsDir: string,
): Promise<ReadonlyArray<MergedWikiEntry>> => {
  const scanned = await scanPackWikis(packsDir)
  registry.reconcile(scanned.filter(w => w.enabled))
  return scanned
}
