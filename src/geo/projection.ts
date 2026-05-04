// ============================================================================
// Category projection — derive CategoryMeta entries from a feature array.
//
// Categories are not declared in a separate registry. They emerge from the
// `category` property on features. Metadata (displayName, icon, osmQuery)
// rides on individual features via category_display / category_icon /
// category_osm_query. The first feature carrying any given metadata field
// for a category id wins; subsequent features can carry their own values
// but won't overwrite. Missing fields fall back: display = title-case(id),
// icon = 'pin', osmQuery = undefined.
// ============================================================================

import { isMarkerIcon, type CategoryMeta, type GeoFeature, type MarkerIcon } from './types.ts'

const ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/

const titleCase = (id: string): string =>
  id.split('-').map((p) => p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)).join(' ')

// Validate the per-feature category metadata. Same rules as the old
// validateCategoryMeta but applied to the embedded fields. Used by the
// import + discovered-cache flows to reject features that carry malformed
// category metadata. Returns null on valid; an error message on invalid
// (caller logs + drops the feature or aborts the import).
export const validateEmbeddedCategoryMeta = (props: {
  category?: unknown
  category_display?: unknown
  category_icon?: unknown
  category_osm_query?: unknown
}): string | null => {
  if (typeof props.category !== 'string' || !ID_PATTERN.test(props.category)) {
    return `properties.category must match /${ID_PATTERN.source}/ (got ${JSON.stringify(props.category)})`
  }
  if (props.category_display !== undefined) {
    if (typeof props.category_display !== 'string' || props.category_display.trim().length === 0) {
      return 'properties.category_display must be a non-empty string when present'
    }
  }
  if (props.category_icon !== undefined && !isMarkerIcon(props.category_icon)) {
    return `properties.category_icon must be a marker-icon name (got ${JSON.stringify(props.category_icon)})`
  }
  if (props.category_osm_query !== undefined) {
    if (typeof props.category_osm_query !== 'string' || props.category_osm_query.trim().length === 0) {
      return 'properties.category_osm_query must be a non-empty string when present'
    }
    const matches = props.category_osm_query.match(/\{name\}/g)
    if (!matches || matches.length !== 1) {
      return 'properties.category_osm_query must contain `{name}` placeholder exactly once'
    }
  }
  return null
}

// Walk features; project a CategoryMeta entry per unique category id.
// Any feature carrying a metadata field wins for that field — first such
// feature seen for the category. Missing fields use fallbacks.
export const extractCategoryMetaFromFeatures = (
  features: ReadonlyArray<GeoFeature>,
): ReadonlyMap<string, CategoryMeta> => {
  const seen = new Map<string, {
    display?: string
    icon?: MarkerIcon
    osmQuery?: string
  }>()
  for (const f of features) {
    const id = f.properties.category
    if (!id) continue
    const slot = seen.get(id) ?? {}
    if (slot.display === undefined && typeof f.properties.category_display === 'string' && f.properties.category_display.trim().length > 0) {
      slot.display = f.properties.category_display.trim()
    }
    if (slot.icon === undefined && f.properties.category_icon !== undefined && isMarkerIcon(f.properties.category_icon)) {
      slot.icon = f.properties.category_icon
    }
    if (slot.osmQuery === undefined && typeof f.properties.category_osm_query === 'string' && f.properties.category_osm_query.trim().length > 0) {
      slot.osmQuery = f.properties.category_osm_query
    }
    seen.set(id, slot)
  }
  const out = new Map<string, CategoryMeta>()
  for (const [id, slot] of seen) {
    out.set(id, {
      id,
      displayName: slot.display ?? titleCase(id),
      icon: slot.icon ?? 'pin',
      ...(slot.osmQuery ? { osmQuery: slot.osmQuery } : {}),
    })
  }
  return out
}
