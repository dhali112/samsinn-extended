import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  getAvailableGeoSources,
  invalidateDiscoveryCache,
  parseSources,
  isGeoOnlyOwner,
} from './discovery.ts'

describe('parseSources', () => {
  it('returns default samsinn-geodata when env unset', () => {
    expect(parseSources(undefined)).toEqual(['samsinn-geodata'])
  })

  it('returns default when env is empty string', () => {
    expect(parseSources('')).toEqual(['samsinn-geodata'])
  })

  it('returns default when env is whitespace-only csv', () => {
    expect(parseSources(', , ,')).toEqual(['samsinn-geodata'])
  })

  it('parses csv', () => {
    expect(parseSources('a,b,c')).toEqual(['a', 'b', 'c'])
  })

  it('trims entries', () => {
    expect(parseSources(' a , b ,c')).toEqual(['a', 'b', 'c'])
  })

  it('keeps owner/repo style entries intact', () => {
    expect(parseSources('samsinn-geodata,me/my-geo-fork')).toEqual(['samsinn-geodata', 'me/my-geo-fork'])
  })
})

describe('isGeoOnlyOwner', () => {
  it('matches samsinn-geodata', () => {
    expect(isGeoOnlyOwner('samsinn-geodata')).toBe(true)
  })

  it('matches any owner ending in -geodata', () => {
    expect(isGeoOnlyOwner('acme-geodata')).toBe(true)
    expect(isGeoOnlyOwner('foo-bar-geodata')).toBe(true)
  })

  it('rejects unrelated owners', () => {
    expect(isGeoOnlyOwner('michaelhil')).toBe(false)
    expect(isGeoOnlyOwner('geodata')).toBe(false)  // not the suffix
    expect(isGeoOnlyOwner('samsinn-wiki')).toBe(false)
  })
})

describe('getAvailableGeoSources (live GitHub API — gated by env)', () => {
  beforeEach(() => { invalidateDiscoveryCache() })
  afterEach(() => { invalidateDiscoveryCache() })

  // Discovery hits real GitHub API. Smoke-test only the empty path: an
  // owner that doesn't exist returns an empty array, doesn't throw.
  it('returns empty array for unknown owner', async () => {
    const prev = process.env.SAMSINN_GEO_SOURCES
    process.env.SAMSINN_GEO_SOURCES = 'definitely-not-a-real-github-org-zxqwerty12345-geodata'
    try {
      const sources = await getAvailableGeoSources()
      expect(Array.isArray(sources)).toBe(true)
      expect(sources.length).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.SAMSINN_GEO_SOURCES
      else process.env.SAMSINN_GEO_SOURCES = prev
    }
  })

  it('caches result across calls within TTL', async () => {
    const prev = process.env.SAMSINN_GEO_SOURCES
    process.env.SAMSINN_GEO_SOURCES = 'definitely-not-a-real-github-org-zxqwerty12345-geodata'
    try {
      const a = await getAvailableGeoSources()
      const b = await getAvailableGeoSources()
      // Same reference (cached)
      expect(a).toBe(b)
    } finally {
      if (prev === undefined) delete process.env.SAMSINN_GEO_SOURCES
      else process.env.SAMSINN_GEO_SOURCES = prev
    }
  })
})
