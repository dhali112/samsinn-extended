// One-shot migrations for geodata layout changes. Idempotent — re-running is
// always a no-op once the target layout is detected.
//
// Layouts:
//   v0 (pre-2d97306): bundled jsdelivr cache + ad-hoc *.geojson at the root.
//   v1 (2d97306):      categories.json registry + <id>.geojson per category.
//   v2 (this file):    single geodata.geojson FeatureCollection. Categories
//                      derived from feature properties (category_display /
//                      category_icon / category_osm_query). No registry file.
//
// Migration policy:
//   v0 → v2: just clear the bundled cache + any orphan files (no data to
//            preserve; the user already accepted the wipe at v0→v1).
//   v1 → v2: read categories.json + every <id>.geojson; concatenate features
//            into one array; attach category_display/icon/osm_query as
//            properties on the FIRST feature for each category; atomically
//            write geodata.geojson; delete the now-stale per-category files
//            and categories.json (clean break — no backward compat).
//
// Atomicity: we write to geodata.geojson.tmp + rename. If anything fails
// before the rename, the old files stay intact and the next boot retries.

import { existsSync } from 'node:fs'
import { readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sharedPaths } from '../core/paths.ts'
import type { GeoFeature, GeoFeatureCollection } from './types.ts'

const TARGET_FILE = 'geodata.geojson'
const REGISTRY_FILE = 'categories.json'

export interface MigrationResult {
  readonly migrated: boolean
  readonly version: 'v0->v2' | 'v1->v2' | 'none'
  readonly featuresWritten: number
  readonly filesRemoved: number
}

const NONE: MigrationResult = { migrated: false, version: 'none', featuresWritten: 0, filesRemoved: 0 }

interface OldCategoryMeta {
  readonly id: string
  readonly displayName?: string
  readonly icon?: string
  readonly osmQuery?: string
}

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    const raw = await readFile(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export const runGeodataMigrationOnce = async (): Promise<MigrationResult> => {
  const root = sharedPaths.geodata()
  if (!existsSync(root)) return NONE
  if (existsSync(join(root, TARGET_FILE))) return NONE  // already on v2

  // === v1 → v2: categories.json + per-cat .geojson present ===
  if (existsSync(join(root, REGISTRY_FILE))) {
    const registry = await readJson<{ version?: number; categories?: OldCategoryMeta[] }>(
      join(root, REGISTRY_FILE),
    )
    const categoriesById = new Map<string, OldCategoryMeta>()
    for (const c of registry?.categories ?? []) {
      if (typeof c.id === 'string') categoriesById.set(c.id, c)
    }

    let entries: string[]
    try { entries = await readdir(root) } catch { return NONE }

    const allFeatures: GeoFeature[] = []
    const filesToRemove: string[] = []
    const seenCategoryMeta = new Set<string>()

    for (const e of entries) {
      if (e === REGISTRY_FILE || e === TARGET_FILE) continue
      if (!e.endsWith('.geojson')) continue
      const path = join(root, e)
      const fc = await readJson<GeoFeatureCollection>(path)
      if (!fc || fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) continue
      filesToRemove.push(path)

      for (const f of fc.features) {
        if (!f || typeof f !== 'object') continue
        const props = f.properties as Record<string, unknown> | undefined
        if (!props || typeof props.category !== 'string') continue
        const catId = props.category as string
        const meta = categoriesById.get(catId)

        // First feature for this category gets the meta embedded (if any).
        const carryMeta = !seenCategoryMeta.has(catId) && meta
          ? {
              ...(typeof meta.displayName === 'string' ? { category_display: meta.displayName } : {}),
              ...(typeof meta.icon === 'string' ? { category_icon: meta.icon } : {}),
              ...(typeof meta.osmQuery === 'string' ? { category_osm_query: meta.osmQuery } : {}),
            }
          : {}
        if (Object.keys(carryMeta).length > 0) seenCategoryMeta.add(catId)

        allFeatures.push({
          type: 'Feature',
          geometry: f.geometry,
          properties: { ...props, ...carryMeta } as GeoFeature['properties'],
        })
      }
    }

    // Atomic write: tmp + rename. If anything below throws, old files stay.
    const target = join(root, TARGET_FILE)
    const tmp = `${target}.tmp`
    const fc: GeoFeatureCollection = { type: 'FeatureCollection', features: allFeatures }
    await writeFile(tmp, `${JSON.stringify(fc, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, target)

    // Now safe to delete the old layout.
    let filesRemoved = 0
    for (const p of filesToRemove) {
      try { await unlink(p); filesRemoved++ } catch { /* harmless */ }
    }
    try { await unlink(join(root, REGISTRY_FILE)); filesRemoved++ } catch { /* harmless */ }

    console.log(`[geo/migrate] v1→v2: wrote ${allFeatures.length} features to ${TARGET_FILE}; removed ${filesRemoved} old file(s)`)
    return { migrated: true, version: 'v1->v2', featuresWritten: allFeatures.length, filesRemoved }
  }

  // === v0 → v2: no registry, but maybe orphan .geojson + .bundled cache ===
  let entries: string[]
  try { entries = await readdir(root) } catch { return NONE }
  let filesRemoved = 0
  let bundledRemoved = false
  for (const e of entries) {
    if (e === TARGET_FILE) continue
    const path = join(root, e)
    if (e === '.bundled') {
      try { await rm(path, { recursive: true, force: true }); bundledRemoved = true } catch { /* harmless */ }
      continue
    }
    if (!e.endsWith('.geojson')) continue
    try { await unlink(path); filesRemoved++ } catch { /* harmless */ }
  }
  const acted = filesRemoved > 0 || bundledRemoved
  if (acted) {
    console.log(`[geo/migrate] v0→v2: cleared pre-registry layout: ${filesRemoved} .geojson file(s)${bundledRemoved ? ' + .bundled cache' : ''}`)
  }
  return acted
    ? { migrated: true, version: 'v0->v2', featuresWritten: 0, filesRemoved }
    : NONE
}
