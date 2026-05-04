import { describe, it, expect } from 'bun:test'
import { extractCategoryMetaFromFeatures, validateEmbeddedCategoryMeta } from './projection.ts'
import type { GeoFeature } from './types.ts'

const f = (overrides: Partial<GeoFeature['properties']>): GeoFeature => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [0, 0] },
  properties: {
    id: 'x',
    name: 'X',
    category: 'cat',
    verified: false,
    source: 'local',
    ...overrides,
  },
})

describe('extractCategoryMetaFromFeatures', () => {
  it('returns empty for empty input', () => {
    expect(extractCategoryMetaFromFeatures([]).size).toBe(0)
  })

  it('derives one entry per unique category', () => {
    const out = extractCategoryMetaFromFeatures([
      f({ category: 'oil-platforms' }),
      f({ category: 'oil-platforms' }),
      f({ category: 'wind-farms' }),
    ])
    expect(out.size).toBe(2)
    expect(out.has('oil-platforms')).toBe(true)
    expect(out.has('wind-farms')).toBe(true)
  })

  it('uses first feature carrying category_display for that field', () => {
    const out = extractCategoryMetaFromFeatures([
      f({ category: 'oil-platforms' }),  // no metadata
      f({ category: 'oil-platforms', category_display: 'Oil Platforms' }),
      f({ category: 'oil-platforms', category_display: 'Should Not Win' }),
    ])
    expect(out.get('oil-platforms')?.displayName).toBe('Oil Platforms')
  })

  it('falls back to title-case id when no feature carries display', () => {
    const out = extractCategoryMetaFromFeatures([
      f({ category: 'oil-platforms' }),
      f({ category: 'oil-platforms' }),
    ])
    expect(out.get('oil-platforms')?.displayName).toBe('Oil Platforms')
  })

  it('falls back to pin icon when no feature carries icon', () => {
    const out = extractCategoryMetaFromFeatures([f({ category: 'oil-platforms' })])
    expect(out.get('oil-platforms')?.icon).toBe('pin')
  })

  it('uses first feature carrying icon', () => {
    const out = extractCategoryMetaFromFeatures([
      f({ category: 'oil-platforms', category_icon: 'platform' }),
      f({ category: 'oil-platforms', category_icon: 'pin' }),
    ])
    expect(out.get('oil-platforms')?.icon).toBe('platform')
  })

  it('omits osmQuery when no feature carries one', () => {
    const out = extractCategoryMetaFromFeatures([f({ category: 'oil-platforms' })])
    expect(out.get('oil-platforms')?.osmQuery).toBeUndefined()
  })

  it('uses first feature carrying osm query', () => {
    const out = extractCategoryMetaFromFeatures([
      f({ category: 'wind-farms' }),
      f({ category: 'wind-farms', category_osm_query: 'node[power=plant][name~"{name}"]' }),
    ])
    expect(out.get('wind-farms')?.osmQuery).toBe('node[power=plant][name~"{name}"]')
  })

  it('different categories collect independent metadata', () => {
    const out = extractCategoryMetaFromFeatures([
      f({ category: 'a', category_display: 'Alpha', category_icon: 'platform' }),
      f({ category: 'b', category_display: 'Beta', category_icon: 'pin' }),
    ])
    expect(out.get('a')?.displayName).toBe('Alpha')
    expect(out.get('a')?.icon).toBe('platform')
    expect(out.get('b')?.displayName).toBe('Beta')
    expect(out.get('b')?.icon).toBe('pin')
  })
})

describe('validateEmbeddedCategoryMeta', () => {
  it('accepts a feature with only required category id', () => {
    expect(validateEmbeddedCategoryMeta({ category: 'oil-platforms' })).toBeNull()
  })

  it('rejects missing/empty category id', () => {
    expect(validateEmbeddedCategoryMeta({})).toMatch(/category must match/)
    expect(validateEmbeddedCategoryMeta({ category: '' })).toMatch(/category must match/)
  })

  it('rejects category id with bad format', () => {
    expect(validateEmbeddedCategoryMeta({ category: 'Bad Id' })).toMatch(/category must match/)
    expect(validateEmbeddedCategoryMeta({ category: '1leadingdigit' })).toMatch(/category must match/)
  })

  it('rejects empty display string when present', () => {
    expect(validateEmbeddedCategoryMeta({ category: 'a', category_display: '   ' })).toMatch(/display/)
  })

  it('rejects unknown icon', () => {
    expect(validateEmbeddedCategoryMeta({ category: 'a', category_icon: 'rocket' })).toMatch(/icon/)
  })

  it('rejects osm query without {name} placeholder', () => {
    expect(validateEmbeddedCategoryMeta({ category: 'a', category_osm_query: 'node[power=plant]' })).toMatch(/\{name\}/)
  })

  it('rejects osm query with multiple {name} placeholders', () => {
    expect(validateEmbeddedCategoryMeta({ category: 'a', category_osm_query: '{name} and {name}' })).toMatch(/\{name\}/)
  })

  it('accepts well-formed osm query', () => {
    expect(validateEmbeddedCategoryMeta({ category: 'a', category_osm_query: 'node[power=plant][name~"{name}"]' })).toBeNull()
  })
})
