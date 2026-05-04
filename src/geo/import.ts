// ============================================================================
// Paste-import pipeline — validates the paste object, applies it.
//
// Categories are derived from features (no separate registry). The paste
// shape mirrors that:
//
//   {
//     "categoryId": "<id>",                 // required, kebab-case
//     "categoryDisplay": "<display>",       // optional, attached to first feature
//     "categoryIcon": "<marker-icon>",      // optional, attached to first feature
//     "categoryOsmQuery": "<...{name}...>", // optional, attached to first feature
//     "features": [<feature>, ...]
//   }
//
// Rules:
//   - categoryId must match /^[a-z][a-z0-9-]{0,62}$/.
//   - The category's metadata fields (categoryDisplay/Icon/OsmQuery) are
//     written onto the FIRST feature in the import. Existing features in
//     the same category that already declare metadata are not modified —
//     the projection picks the first metadata-bearing feature it finds.
//   - Per-feature minimum: id, name, lat, lng (numeric, in range).
//   - Duplicate id within the features array → fatal error.
//   - If ZERO features survive validation, abort.
//   - All paste features default to verified:true, source:'local',
//     added_by:'user' — explicit import is a curation event.
// ============================================================================

import { upsertFeature } from './store.ts'
import { validateEmbeddedCategoryMeta } from './projection.ts'
import { isMarkerIcon, type GeoFeature, type MarkerIcon } from './types.ts'

export interface ImportError { readonly index: number; readonly field?: string; readonly message: string }

export interface ImportResult {
  readonly ok: boolean
  readonly categoryId: string | null
  readonly featuresAdded: number
  readonly featuresReplaced: number
  readonly errors: ReadonlyArray<ImportError>
}

interface ParsedFeature {
  readonly id: string
  readonly name: string
  readonly lat: number
  readonly lng: number
  readonly aliases?: ReadonlyArray<string>
  readonly country?: string
  readonly operator?: string
  readonly iata?: string
  readonly icao?: string
  readonly tags?: ReadonlyArray<string>
  readonly subcategory?: string
}

const FEATURE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,126}$/i

const validateFeatureRow = (raw: unknown, index: number): { ok: true; feature: ParsedFeature } | { ok: false; error: ImportError } => {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: { index, message: 'feature must be an object' } }
  }
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !FEATURE_ID_PATTERN.test(r.id)) {
    return { ok: false, error: { index, field: 'id', message: 'id must be a string of letters/digits/dashes (1–127 chars)' } }
  }
  if (typeof r.name !== 'string' || r.name.trim().length === 0) {
    return { ok: false, error: { index, field: 'name', message: 'name must be a non-empty string' } }
  }
  if (typeof r.lat !== 'number' || r.lat < -90 || r.lat > 90 || !Number.isFinite(r.lat)) {
    return { ok: false, error: { index, field: 'lat', message: 'lat must be a number in [-90, 90]' } }
  }
  if (typeof r.lng !== 'number' || r.lng < -180 || r.lng > 180 || !Number.isFinite(r.lng)) {
    return { ok: false, error: { index, field: 'lng', message: 'lng must be a number in [-180, 180]' } }
  }
  const aliases = Array.isArray(r.aliases) ? r.aliases.filter((a): a is string => typeof a === 'string') : undefined
  const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : undefined
  const out: ParsedFeature = {
    id: r.id,
    name: r.name.trim(),
    lat: r.lat,
    lng: r.lng,
    ...(aliases && aliases.length > 0 ? { aliases } : {}),
    ...(typeof r.country === 'string' ? { country: r.country } : {}),
    ...(typeof r.operator === 'string' ? { operator: r.operator } : {}),
    ...(typeof r.iata === 'string' ? { iata: r.iata } : {}),
    ...(typeof r.icao === 'string' ? { icao: r.icao } : {}),
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(typeof r.subcategory === 'string' ? { subcategory: r.subcategory } : {}),
  }
  return { ok: true, feature: out }
}

const buildGeoFeature = (
  categoryId: string,
  p: ParsedFeature,
  embeddedMeta?: {
    display?: string
    icon?: MarkerIcon
    osmQuery?: string
  },
): GeoFeature => {
  const now = new Date().toISOString()
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
    properties: {
      id: p.id,
      name: p.name,
      category: categoryId,
      verified: true,
      source: 'local',
      added_by: 'user',
      added_at: now,
      ...(p.aliases ? { aliases: p.aliases } : {}),
      ...(p.country ? { country: p.country } : {}),
      ...(p.operator ? { operator: p.operator } : {}),
      ...(p.iata ? { iata: p.iata } : {}),
      ...(p.icao ? { icao: p.icao } : {}),
      ...(p.tags ? { tags: p.tags } : {}),
      ...(p.subcategory ? { subcategory: p.subcategory } : {}),
      ...(embeddedMeta?.display ? { category_display: embeddedMeta.display } : {}),
      ...(embeddedMeta?.icon ? { category_icon: embeddedMeta.icon } : {}),
      ...(embeddedMeta?.osmQuery ? { category_osm_query: embeddedMeta.osmQuery } : {}),
    },
  }
}

const fail = (message: string): ImportResult => ({
  ok: false,
  categoryId: null,
  featuresAdded: 0,
  featuresReplaced: 0,
  errors: [{ index: -1, message }],
})

export const applyImport = async (body: unknown): Promise<ImportResult> => {
  if (!body || typeof body !== 'object') {
    return fail('paste body must be a JSON object')
  }
  const root = body as Record<string, unknown>
  if (root.error) return fail(`AI returned error: ${String(root.error)}`)

  // --- Validate category metadata fields ---
  if (typeof root.categoryId !== 'string') {
    return fail('`categoryId` must be a string')
  }
  const metaErr = validateEmbeddedCategoryMeta({
    category: root.categoryId,
    category_display: root.categoryDisplay,
    category_icon: root.categoryIcon,
    category_osm_query: root.categoryOsmQuery,
  })
  if (metaErr) return fail(metaErr)
  const categoryId = root.categoryId

  const embeddedMeta = {
    ...(typeof root.categoryDisplay === 'string' ? { display: root.categoryDisplay } : {}),
    ...(isMarkerIcon(root.categoryIcon) ? { icon: root.categoryIcon } : {}),
    ...(typeof root.categoryOsmQuery === 'string' ? { osmQuery: root.categoryOsmQuery } : {}),
  }

  // --- Validate features ---
  if (!Array.isArray(root.features)) return fail('`features` must be an array')
  if (root.features.length === 0) return fail('`features` must contain at least one entry')

  const errors: ImportError[] = []
  const valid: ParsedFeature[] = []
  for (let i = 0; i < root.features.length; i++) {
    const r = validateFeatureRow(root.features[i], i)
    if (r.ok) valid.push(r.feature)
    else errors.push(r.error)
  }

  // Duplicate-id-within-paste check (fatal).
  const seen = new Set<string>()
  for (const f of valid) {
    if (seen.has(f.id)) {
      return {
        ok: false,
        categoryId: null,
        featuresAdded: 0,
        featuresReplaced: 0,
        errors: [{ index: -1, field: 'features[].id', message: `duplicate id within paste: '${f.id}'` }, ...errors],
      }
    }
    seen.add(f.id)
  }

  if (valid.length === 0) {
    return { ok: false, categoryId: null, featuresAdded: 0, featuresReplaced: 0, errors }
  }

  // --- Apply: write features. Category metadata rides on the FIRST feature. ---
  let added = 0
  let replaced = 0
  for (let i = 0; i < valid.length; i++) {
    const p = valid[i]!
    const feat = buildGeoFeature(categoryId, p, i === 0 ? embeddedMeta : undefined)
    const r = await upsertFeature(feat)
    if (r.replaced) replaced++
    else added++
  }

  return {
    ok: true,
    categoryId,
    featuresAdded: added,
    featuresReplaced: replaced,
    errors,
  }
}
