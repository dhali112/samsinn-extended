// ============================================================================
// Discovered geo cache — fetches `geodata.geojson` from each discovered
// source repo and serves the result merged into store.ts at read time.
//
// Layout assumed in each source repo (raw.githubusercontent.com):
//   /geodata.geojson   ← single FeatureCollection covering all categories
//   /README.md         ← optional, ignored
//
// Categories are derived from feature properties (no separate registry).
// See projection.ts:extractCategoryMetaFromFeatures.
//
// Validation:
//   - Top-level must be FeatureCollection.
//   - Each feature must satisfy isValidGeoFeature: Point geometry, valid
//     numeric coords, properties.{id, name, category} all present.
//     properties.id MUST be stable across re-fetches (the contributor's
//     responsibility); features without it are dropped + logged.
//   - Embedded category metadata fields (category_display, category_icon,
//     category_osm_query) are validated by validateEmbeddedCategoryMeta;
//     malformed metadata gets logged but the feature itself is kept (just
//     without the bad field).
//   - properties.source/verified are coerced to 'discovered'/true.
//
// Caching:
//   - 5-min TTL aligned with discovery's TTL.
//   - ETag per file. On refetch, send If-None-Match. 304 = keep last value.
//   - Per-file 5 MB cap. Anything larger is rejected with a warning.
// ============================================================================

import { extractCategoryMetaFromFeatures, validateEmbeddedCategoryMeta } from './projection.ts'
import type { CategoryMeta, GeoFeature } from './types.ts'
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

const fileCache = new Map<string, FileCache>()

interface CacheState {
  readonly fetchedAt: number
  readonly featuresByCategory: ReadonlyMap<string, ReadonlyArray<GeoFeature>>
  readonly categoriesById: ReadonlyMap<string, CategoryMeta>
  readonly perSourceFeatureCounts: ReadonlyMap<string, number>
  readonly errors: ReadonlyArray<{ source: string; reason: string }>
}

const EMPTY_STATE: CacheState = {
  fetchedAt: 0,
  featuresByCategory: new Map(),
  categoriesById: new Map(),
  perSourceFeatureCounts: new Map(),
  errors: [],
}

let state: CacheState = EMPTY_STATE
let inFlight: Promise<CacheState> | null = null

// ============================================================================
// Fetch
// ============================================================================

const fetchWithTimeout = async (url: string, headers: Record<string, string>): Promise<Response> => {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    return await fetch(url, { headers, signal: ctrl.signal })
  } finally {
    clearTimeout(t)
  }
}

// Fetch a file from a repo with ETag awareness. Returns null on 404. On 304
// returns the cached body. On 200 records ETag.
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
    return cached?.body ?? null
  }

  if (res.status === 304) return cached?.body ?? null
  if (res.status === 404) return null
  if (!res.ok) {
    console.warn(`[geo/discovered] ${src.source} ${path} HTTP ${res.status}`)
    return cached?.body ?? null
  }

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

// ============================================================================
// Parse
// ============================================================================

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

const parseGeojsonFile = (raw: string, sourceLabel: string): ReadonlyArray<GeoFeature> => {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (err) {
    console.warn(`[geo/discovered] ${sourceLabel} geodata.geojson parse failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const fc = parsed as { type?: unknown; features?: unknown }
  if (fc.type !== 'FeatureCollection' || !Array.isArray(fc.features)) {
    console.warn(`[geo/discovered] ${sourceLabel} geodata.geojson is not a FeatureCollection`)
    return []
  }
  const out: GeoFeature[] = []
  let skippedNoId = 0
  for (const r of fc.features) {
    if (!isValidGeoFeature(r)) {
      const p = (r as { properties?: { id?: unknown } } | undefined)?.properties
      if (p && typeof p.id !== 'string') skippedNoId++
      continue
    }
    // Strip out any malformed embedded category metadata, but keep the
    // feature. Bad metadata shouldn't drop the feature itself.
    const metaErr = validateEmbeddedCategoryMeta({
      category: r.properties.category,
      category_display: r.properties.category_display,
      category_icon: r.properties.category_icon,
      category_osm_query: r.properties.category_osm_query,
    })
    if (metaErr) {
      console.warn(`[geo/discovered] ${sourceLabel} feature ${r.properties.id} category metadata invalid (kept, metadata stripped): ${metaErr}`)
    }
    const properties = {
      ...r.properties,
      source: 'discovered' as const,
      verified: true,
      ...(metaErr
        ? { category_display: undefined, category_icon: undefined, category_osm_query: undefined }
        : {}),
    }
    out.push({ ...r, properties })
  }
  if (skippedNoId > 0) {
    console.warn(`[geo/discovered] ${sourceLabel} geodata.geojson skipped ${skippedNoId} feature(s) without stable properties.id`)
  }
  return out
}

// ============================================================================
// Refresh
// ============================================================================

const refresh = async (): Promise<CacheState> => {
  const sources = await getAvailableGeoSources()
  const allFeatures: GeoFeature[] = []
  const perSourceCounts = new Map<string, number>()
  const errors: { source: string; reason: string }[] = []

  for (const src of sources) {
    try {
      const raw = await fetchFile(src, 'geodata.geojson')
      if (!raw) {
        perSourceCounts.set(src.source, 0)
        continue
      }
      const features = parseGeojsonFile(raw, src.source)
      allFeatures.push(...features)
      perSourceCounts.set(src.source, features.length)
      console.log(`[geo/discovered] ${src.source} fetched ${features.length} features`)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      errors.push({ source: src.source, reason })
      console.warn(`[geo/discovered] ${src.source} failed: ${reason}`)
    }
  }

  const featuresByCategory = new Map<string, GeoFeature[]>()
  for (const f of allFeatures) {
    const slot = featuresByCategory.get(f.properties.category) ?? []
    slot.push(f)
    featuresByCategory.set(f.properties.category, slot)
  }
  const categoriesById = extractCategoryMetaFromFeatures(allFeatures)

  return {
    fetchedAt: Date.now(),
    featuresByCategory,
    categoriesById,
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

// ============================================================================
// Public API
// ============================================================================

export const getDiscoveredCategories = async (): Promise<ReadonlyArray<CategoryMeta>> => {
  const s = await ensureFresh()
  return [...s.categoriesById.values()]
}

export const getDiscoveredFeatures = async (categoryId: string): Promise<ReadonlyArray<GeoFeature>> => {
  const s = await ensureFresh()
  return s.featuresByCategory.get(categoryId) ?? []
}

// All discovered features across all categories. Used by store.ts when
// projecting categories from the merged feature space.
export const getAllDiscoveredFeatures = async (): Promise<ReadonlyArray<GeoFeature>> => {
  const s = await ensureFresh()
  const out: GeoFeature[] = []
  for (const arr of s.featuresByCategory.values()) out.push(...arr)
  return out
}

export interface DiscoveryStatus {
  readonly fetchedAt: number
  readonly sources: ReadonlyArray<{
    readonly source: string
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

export const warmDiscoveredCache = (): void => {
  void ensureFresh().catch((err) => {
    console.warn(`[geo/discovered] warm-up failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}

export const __resetDiscoveredCacheState = (): void => {
  state = EMPTY_STATE
  inFlight = null
  fileCache.clear()
}
