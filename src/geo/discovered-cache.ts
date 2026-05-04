// ============================================================================
// Discovered geo cache — fetches categories.json + *.geojson from each
// discovered source's repo, validates, and serves the result merged into
// loadCategory / loadRegistry via mergeWithDiscovered helpers in store.ts /
// categories.ts.
//
// Layout assumed in each source repo (raw.githubusercontent.com):
//   /categories.json                              ← CategoryRegistryFile shape
//   /<category-id>.geojson                        ← per-category FeatureCollection
//   /README.md (etc — ignored by discovery)
//
// Validation:
//   - categories.json: validateCategoryMeta on each entry; bad entries
//     dropped with a logged warning.
//   - *.geojson: must be FeatureCollection. Per-feature validation:
//     properties.id MUST exist (stable id requirement) — features without
//     it are dropped + logged. properties.source/verified are coerced to
//     'discovered'/true.
//
// Caching:
//   - 5-min TTL aligned with discovery's TTL.
//   - ETag per file. On refetch, send If-None-Match. 304 = keep last value.
//
// Per-file 5 MB cap. Anything larger is rejected with a warning.
// ============================================================================

import { validateCategoryMeta } from './categories.ts'
import type { CategoryMeta, GeoFeature, GeoFeatureCollection } from './types.ts'
import { getAvailableGeoSources, type DiscoveredGeoSource } from './discovery.ts'

const CACHE_TTL_MS = 5 * 60_000
const MAX_FILE_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

const ghHeaders = (): Record<string, string> => {
  const h: Record<string, string> = {
    'User-Agent': 'samsinn-geo-registry',
    'Accept': 'application/vnd.github.raw',
  }
  const token = process.env.SAMSINN_GEO_REGISTRY_TOKEN
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

interface FileCache {
  etag?: string
  body: string
  fetchedAt: number
}

// Per-(source, file) cache for ETag-aware refetches.
const fileCache = new Map<string, FileCache>()

interface CategoryEntry {
  readonly meta: CategoryMeta
  readonly source: string  // owner/repo
}

interface CacheState {
  readonly fetchedAt: number
  readonly categories: ReadonlyArray<CategoryEntry>
  readonly featuresByCategory: ReadonlyMap<string, ReadonlyArray<GeoFeature>>
  readonly perSourceFeatureCounts: ReadonlyMap<string, number>  // source → total features
  readonly errors: ReadonlyArray<{ source: string; reason: string }>
}

const EMPTY_STATE: CacheState = {
  fetchedAt: 0,
  categories: [],
  featuresByCategory: new Map(),
  perSourceFeatureCounts: new Map(),
  errors: [],
}

let state: CacheState = EMPTY_STATE
let inFlight: Promise<CacheState> | null = null

const fetchWithTimeout = async (url: string, headers: Record<string, string>): Promise<Response> => {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { headers, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

// Fetch a file from a repo with ETag awareness. Returns null on 404 or
// permanent error. On 304 returns the cached body. On 200 records ETag.
const fetchFile = async (src: DiscoveredGeoSource, path: string): Promise<string | null> => {
  const key = `${src.source}::${path}`
  const cached = fileCache.get(key)
  const headers = ghHeaders()
  if (cached?.etag) headers['If-None-Match'] = cached.etag

  const url = `https://raw.githubusercontent.com/${src.source}/${src.defaultBranch}/${path}`
  let res: Response
  try {
    res = await fetchWithTimeout(url, headers)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn(`[geo/discovered] ${src.source} ${path} fetch failed: ${reason}`)
    return cached?.body ?? null  // last-known-good if any, else null
  }

  if (res.status === 304) return cached?.body ?? null
  if (res.status === 404) return null
  if (!res.ok) {
    console.warn(`[geo/discovered] ${src.source} ${path} HTTP ${res.status}`)
    return cached?.body ?? null
  }

  // Bound the body. Read with a size check; we don't trust Content-Length.
  const cl = res.headers.get('content-length')
  if (cl && Number(cl) > MAX_FILE_BYTES) {
    console.warn(`[geo/discovered] ${src.source} ${path} too large (${cl} bytes, cap ${MAX_FILE_BYTES})`)
    return null
  }

  const body = await res.text()
  if (body.length > MAX_FILE_BYTES) {
    console.warn(`[geo/discovered] ${src.source} ${path} body exceeded ${MAX_FILE_BYTES} bytes after read`)
    return null
  }

  const etag = res.headers.get('etag') ?? undefined
  fileCache.set(key, { etag, body, fetchedAt: Date.now() })
  return body
}

const parseCategoriesFile = (raw: string, sourceLabel: string): ReadonlyArray<CategoryMeta> => {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (err) {
    console.warn(`[geo/discovered] ${sourceLabel} categories.json parse failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const obj = parsed as { categories?: unknown }
  if (!Array.isArray(obj.categories)) return []
  const out: CategoryMeta[] = []
  for (const entry of obj.categories) {
    const v = validateCategoryMeta(entry)
    if (v.ok) {
      out.push(v.meta)
    } else {
      const errs = v.errors.map(e => `${e.field}: ${e.message}`).join('; ')
      console.warn(`[geo/discovered] ${sourceLabel} category invalid (skipped): ${errs}`)
    }
  }
  return out
}

const isValidGeoFeature = (raw: unknown): raw is GeoFeature => {
  if (!raw || typeof raw !== 'object') return false
  const f = raw as Record<string, unknown>
  if (f.type !== 'Feature') return false
  const g = f.geometry as Record<string, unknown> | undefined
  if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length !== 2) return false
  const [lng, lat] = g.coordinates as ReadonlyArray<unknown>
  if (typeof lng !== 'number' || typeof lat !== 'number') return false
  const p = f.properties as Record<string, unknown> | undefined
  if (!p) return false
  if (typeof p.id !== 'string' || !p.id) return false   // STABLE ID required
  if (typeof p.name !== 'string' || !p.name) return false
  if (typeof p.category !== 'string' || !p.category) return false
  return true
}

const parseGeojsonFile = (raw: string, sourceLabel: string, categoryId: string): ReadonlyArray<GeoFeature> => {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (err) {
    console.warn(`[geo/discovered] ${sourceLabel} ${categoryId}.geojson parse failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const fc = parsed as Partial<GeoFeatureCollection>
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    console.warn(`[geo/discovered] ${sourceLabel} ${categoryId}.geojson not a FeatureCollection`)
    return []
  }
  const out: GeoFeature[] = []
  let skippedNoId = 0
  for (const raw of fc.features) {
    if (!isValidGeoFeature(raw)) {
      // Distinguish missing id vs other shape failure for better logs.
      const p = (raw as { properties?: { id?: unknown } } | undefined)?.properties
      if (p && typeof p.id !== 'string') skippedNoId++
      continue
    }
    // Coerce source + verified — discovered features are curated.
    const coerced: GeoFeature = {
      ...raw,
      properties: {
        ...raw.properties,
        category: categoryId,    // override file-declared category with filename-derived id
        source: 'discovered',
        verified: true,
      },
    }
    out.push(coerced)
  }
  if (skippedNoId > 0) {
    console.warn(`[geo/discovered] ${sourceLabel} ${categoryId}.geojson skipped ${skippedNoId} feature(s) without stable properties.id`)
  }
  return out
}

// Refresh state. Single-flight guard prevents thundering herd.
const refresh = async (): Promise<CacheState> => {
  const sources = await getAvailableGeoSources()
  const allCategories: CategoryEntry[] = []
  const allFeatures = new Map<string, GeoFeature[]>()
  const perSourceCounts = new Map<string, number>()
  const errors: { source: string; reason: string }[] = []

  for (const src of sources) {
    let srcFeatureCount = 0
    try {
      const catsRaw = await fetchFile(src, 'categories.json')
      if (!catsRaw) {
        // No categories.json — source is empty or removed. Skip silently.
        perSourceCounts.set(src.source, 0)
        continue
      }
      const cats = parseCategoriesFile(catsRaw, src.source)
      for (const meta of cats) {
        allCategories.push({ meta, source: src.source })
        const geojsonRaw = await fetchFile(src, `${meta.id}.geojson`)
        if (!geojsonRaw) continue
        const features = parseGeojsonFile(geojsonRaw, src.source, meta.id)
        const existing = allFeatures.get(meta.id) ?? []
        allFeatures.set(meta.id, [...existing, ...features])
        srcFeatureCount += features.length
      }
      perSourceCounts.set(src.source, srcFeatureCount)
      console.log(`[geo/discovered] ${src.source} fetched ${cats.length} categories, ${srcFeatureCount} features`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      errors.push({ source: src.source, reason })
      console.warn(`[geo/discovered] ${src.source} failed: ${reason}`)
    }
  }

  return {
    fetchedAt: Date.now(),
    categories: allCategories,
    featuresByCategory: allFeatures,
    perSourceFeatureCounts: perSourceCounts,
    errors,
  }
}

const ensureFresh = async (): Promise<CacheState> => {
  const now = Date.now()
  if (state !== EMPTY_STATE && now - state.fetchedAt < CACHE_TTL_MS) return state
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      state = await refresh()
      return state
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

// === Public API ===

// All discovered category metas (deduped by id — first source wins).
export const getDiscoveredCategories = async (): Promise<ReadonlyArray<CategoryMeta>> => {
  const s = await ensureFresh()
  const seen = new Set<string>()
  const out: CategoryMeta[] = []
  for (const { meta } of s.categories) {
    if (seen.has(meta.id)) continue
    seen.add(meta.id)
    out.push(meta)
  }
  return out
}

// All discovered features for a category. Empty array if unknown.
export const getDiscoveredFeatures = async (categoryId: string): Promise<ReadonlyArray<GeoFeature>> => {
  const s = await ensureFresh()
  return s.featuresByCategory.get(categoryId) ?? []
}

// Diagnostic snapshot for the Settings panel + /api/geodata/sources endpoint.
// Cheap; reads cache, doesn't trigger refetch.
export interface DiscoveryStatus {
  readonly fetchedAt: number          // 0 if never fetched
  readonly sources: ReadonlyArray<{
    readonly source: string           // owner/repo
    readonly featureCount: number
    readonly error: string | null
  }>
}

export const getDiscoveryStatus = (): DiscoveryStatus => {
  const sources: Array<{ source: string; featureCount: number; error: string | null }> = []
  const seen = new Set<string>()
  for (const [source, featureCount] of state.perSourceFeatureCounts) {
    sources.push({ source, featureCount, error: null })
    seen.add(source)
  }
  for (const { source, reason } of state.errors) {
    if (seen.has(source)) continue
    sources.push({ source, featureCount: 0, error: reason })
  }
  return { fetchedAt: state.fetchedAt, sources }
}

// Trigger a refresh in the background. Used by bootstrap warm-up.
// Returns immediately; refresh logs progress.
export const warmDiscoveredCache = (): void => {
  void ensureFresh().catch((err) => {
    console.warn(`[geo/discovered] warm-up failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}

// Test helper.
export const __resetDiscoveredCacheState = (): void => {
  state = EMPTY_STATE
  inFlight = null
  fileCache.clear()
}
