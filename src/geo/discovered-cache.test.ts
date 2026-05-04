import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  getDiscoveredCategories,
  getDiscoveredFeatures,
  getDiscoveryStatus,
  __resetDiscoveredCacheState,
} from './discovered-cache.ts'
import { invalidateDiscoveryCache } from './discovery.ts'

// These tests exercise parsing/validation and the empty-source happy path
// against the live discovery layer (with a known-bad owner that yields zero
// sources). The real-network branch is covered by smoke at deploy time.

describe('discovered-cache empty-source path', () => {
  beforeEach(() => {
    __resetDiscoveredCacheState()
    invalidateDiscoveryCache()
  })
  afterEach(() => {
    __resetDiscoveredCacheState()
    invalidateDiscoveryCache()
  })

  it('returns empty arrays when no sources discovered', async () => {
    const prev = process.env.SAMSINN_GEO_SOURCES
    process.env.SAMSINN_GEO_SOURCES = 'definitely-not-a-real-org-zxqwerty12345-geodata'
    try {
      const cats = await getDiscoveredCategories()
      const feats = await getDiscoveredFeatures('whatever')
      expect(cats).toEqual([])
      expect(feats).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.SAMSINN_GEO_SOURCES
      else process.env.SAMSINN_GEO_SOURCES = prev
    }
  })

  it('getDiscoveryStatus returns fetchedAt=0 before first fetch', () => {
    const status = getDiscoveryStatus()
    expect(status.fetchedAt).toBe(0)
    expect(status.sources).toEqual([])
  })

  it('getDiscoveryStatus reflects fetched state after a refresh', async () => {
    const prev = process.env.SAMSINN_GEO_SOURCES
    process.env.SAMSINN_GEO_SOURCES = 'definitely-not-a-real-org-zxqwerty12345-geodata'
    try {
      await getDiscoveredCategories()
      const status = getDiscoveryStatus()
      // fetchedAt is set even when no sources resolved (refresh ran successfully).
      expect(status.fetchedAt).toBeGreaterThan(0)
      expect(status.sources).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.SAMSINN_GEO_SOURCES
      else process.env.SAMSINN_GEO_SOURCES = prev
    }
  })
})
