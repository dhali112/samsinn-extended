// Pack-source geodata loader tests. Exercises the on-disk scan + parse,
// pack tagging, and the room-aware filter in store.listCategoryForRoom.

import { describe, expect, test, afterEach, beforeEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshPackGeodata, getPackFeatures, getAllPackFeatures, __resetPackGeodataCache } from './pack-source.ts'
import { listCategoryForRoom } from './store.ts'

const fc = (features: ReadonlyArray<unknown>): string =>
  JSON.stringify({ type: 'FeatureCollection', features })

// Realistic pack-author shape: no `verified` or `source` set (the loader
// stamps pack=<ns>, source='pack', verified=true defaults). isValidGeoFeature
// requires id/name/category/Point — that's what tests exercise.
const feature = (id: string, name: string, category: string, lat: number, lng: number) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: { id, name, category },
})

describe('pack-source geodata loader', () => {
  let packsDir: string

  beforeEach(async () => {
    __resetPackGeodataCache()
    packsDir = await mkdtemp(join(tmpdir(), 'samsinn-pack-geo-'))
  })

  afterEach(async () => {
    await rm(packsDir, { recursive: true, force: true })
    __resetPackGeodataCache()
  })

  test('loads features from <pack>/geodata/*.geojson and tags them', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'airports.geojson'),
      fc([feature('osl', 'Oslo Airport', 'airports', 60.19, 11.10)]),
      'utf-8',
    )
    await writeFile(join(packsDir, 'aviation', 'pack.json'), JSON.stringify({ name: 'aviation' }))

    const state = await refreshPackGeodata(packsDir)
    expect(state.errors).toEqual([])
    expect(state.perPackFeatureCounts.get('aviation')).toBe(1)

    const airports = getPackFeatures('airports')
    expect(airports).toHaveLength(1)
    expect(airports[0]?.properties.source).toBe('pack')
    expect(airports[0]?.properties.pack).toBe('aviation')
    expect(airports[0]?.properties.verified).toBe(true)   // pack default
  })

  test('multiple files per pack merge into the category map', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'airports.geojson'),
      fc([feature('osl', 'Oslo', 'airports', 60.19, 11.10)]),
    )
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'navaids.geojson'),
      fc([feature('osd-vor', 'OSD VOR', 'navaids', 60.0, 11.0)]),
    )

    await refreshPackGeodata(packsDir)
    expect(getPackFeatures('airports')).toHaveLength(1)
    expect(getPackFeatures('navaids')).toHaveLength(1)
    expect(getAllPackFeatures()).toHaveLength(2)
  })

  test('two packs contribute to the same category, both visible', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await mkdir(join(packsDir, 'cafes', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'airports.geojson'),
      fc([feature('osl', 'Oslo', 'airports', 60.19, 11.10)]),
    )
    await writeFile(
      join(packsDir, 'cafes', 'geodata', 'cafes.geojson'),
      fc([feature('java', 'Java House', 'cafes', 59.91, 10.74)]),
    )

    const state = await refreshPackGeodata(packsDir)
    expect(state.perPackFeatureCounts.get('aviation')).toBe(1)
    expect(state.perPackFeatureCounts.get('cafes')).toBe(1)
  })

  test('malformed files are skipped with a structured error; siblings still load', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await writeFile(join(packsDir, 'aviation', 'geodata', 'broken.geojson'), '{ not json')
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'good.geojson'),
      fc([feature('osl', 'Oslo', 'airports', 60.19, 11.10)]),
    )

    const state = await refreshPackGeodata(packsDir)
    expect(state.errors.some(e => e.file === 'broken.geojson')).toBe(true)
    expect(getPackFeatures('airports')).toHaveLength(1)
  })

  test('non-Feature entries dropped silently, kept in error log when id missing', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'airports.geojson'),
      fc([
        feature('osl', 'Oslo', 'airports', 60.19, 11.10),
        // missing id — should be skipped + counted in errors
        { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { name: 'X', category: 'airports' } },
      ]),
    )
    const state = await refreshPackGeodata(packsDir)
    expect(state.errors.some(e => /missing properties.id/.test(e.reason))).toBe(true)
    expect(getPackFeatures('airports')).toHaveLength(1)
  })

  test('listCategoryForRoom filters pack features by activePacks', async () => {
    await mkdir(join(packsDir, 'aviation', 'geodata'), { recursive: true })
    await mkdir(join(packsDir, 'cafes', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'aviation', 'geodata', 'airports.geojson'),
      fc([feature('osl', 'Oslo Airport', 'airports', 60.19, 11.10)]),
    )
    // 'cafes' contributes to a DIFFERENT category — useful for asserting
    // that activation gates per-namespace, not per-category.
    await writeFile(
      join(packsDir, 'cafes', 'geodata', 'cafes.geojson'),
      fc([feature('java', 'Java House', 'cafes', 59.91, 10.74)]),
    )
    await refreshPackGeodata(packsDir)

    // Active set with 'aviation' only: cafes should be hidden.
    const aviationOnly = await listCategoryForRoom('cafes', new Set(['core', 'local', 'aviation']))
    expect(aviationOnly.filter(f => f.properties.source === 'pack')).toHaveLength(0)

    const aviationOnlyAirports = await listCategoryForRoom('airports', new Set(['core', 'local', 'aviation']))
    expect(aviationOnlyAirports.find(f => f.properties.pack === 'aviation')).toBeDefined()

    // Both active: both visible.
    const both = await listCategoryForRoom('cafes', new Set(['core', 'local', 'aviation', 'cafes']))
    expect(both.find(f => f.properties.pack === 'cafes')).toBeDefined()

    // Neither active: pack features hidden.
    const neither = await listCategoryForRoom('airports', new Set(['core', 'local']))
    expect(neither.filter(f => f.properties.source === 'pack')).toHaveLength(0)
  })

  test('concurrent refreshes serialise — final state matches the last filesystem snapshot', async () => {
    // Burst of 3 refreshes against an evolving disk. Each refresh awaits
    // the previous and re-scans, so the third call returns the state with
    // all three packs. Asserts no in-flight dedupe race drops a pack.
    await mkdir(join(packsDir, 'p1', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'p1', 'geodata', 'a.geojson'),
      fc([feature('p1-a', 'A', 'cat', 0, 0)]),
      'utf-8',
    )

    const r1 = refreshPackGeodata(packsDir)

    await mkdir(join(packsDir, 'p2', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'p2', 'geodata', 'a.geojson'),
      fc([feature('p2-a', 'A', 'cat', 0, 0)]),
      'utf-8',
    )
    const r2 = refreshPackGeodata(packsDir)

    await mkdir(join(packsDir, 'p3', 'geodata'), { recursive: true })
    await writeFile(
      join(packsDir, 'p3', 'geodata', 'a.geojson'),
      fc([feature('p3-a', 'A', 'cat', 0, 0)]),
      'utf-8',
    )
    const r3 = refreshPackGeodata(packsDir)

    const [s1, s2, s3] = await Promise.all([r1, r2, r3])
    // Per-call snapshot sizes are timing-dependent (a fast scan may see
    // packs that were written between the refreshPackGeodata call and the
    // chain dequeueing this scan). What we GUARANTEE is monotonic
    // non-decrease and that the LAST call captures every pack on disk.
    expect(s1.perPackFeatureCounts.size).toBeGreaterThanOrEqual(1)
    expect(s2.perPackFeatureCounts.size).toBeGreaterThanOrEqual(s1.perPackFeatureCounts.size)
    expect(s3.perPackFeatureCounts.size).toBeGreaterThanOrEqual(s2.perPackFeatureCounts.size)
    expect(s3.perPackFeatureCounts.get('p1')).toBe(1)
    expect(s3.perPackFeatureCounts.get('p2')).toBe(1)
    expect(s3.perPackFeatureCounts.get('p3')).toBe(1)
  })
})
