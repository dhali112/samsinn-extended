// Tests for the one-shot drop-in → packs/local/ migration.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLocalPack } from './migrate-local-pack.ts'

const writeFiles = async (root: string, files: Record<string, string>): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, content)
  }
}

const listAll = async (root: string): Promise<string[]> => {
  if (!existsSync(root)) return []
  return [...await readdir(root)].sort()
}

describe('migrateLocalPack', () => {
  let home: string
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'samsinn-migrate-')) })
  afterEach(async () => { await rm(home, { recursive: true, force: true }) })

  test('skips when no drop-in dirs exist (fresh install)', async () => {
    const result = await migrateLocalPack(home)
    expect(result.status).toBe('skipped')
    expect(existsSync(join(home, '.local-pack-migrated'))).toBe(true)
  })

  test('skips when sentinel already exists (idempotent)', async () => {
    await writeFile(join(home, '.local-pack-migrated'), 'already done')
    // Even if drop-in files exist, sentinel short-circuits.
    await writeFiles(home, { 'tools/foo.ts': 'export default {}' })
    const result = await migrateLocalPack(home)
    expect(result.status).toBe('skipped')
    expect(result.reason).toBe('sentinel present')
    // Files NOT moved.
    expect(await listAll(join(home, 'tools'))).toEqual(['foo.ts'])
    expect(existsSync(join(home, 'packs', 'local', 'tools'))).toBe(false)
  })

  test('migrates all four drop-in dirs into packs/local/', async () => {
    await writeFiles(home, {
      'tools/my-tool.ts':              'export default { name: "my-tool" }',
      'skills/scratch/SKILL.md':       '---\nname: scratch\n---\nbody',
      'scripts/my-script.md':          '# SCRIPT: My Script\n## Cast\n### A\n### B',
      'geodata/cafes.geojson':         '{"type":"FeatureCollection","features":[]}',
    })

    const result = await migrateLocalPack(home)
    expect(result.status).toBe('migrated')
    expect(result.moved).toEqual([
      { dir: 'tools',   count: 1 },
      { dir: 'skills',  count: 1 },
      { dir: 'scripts', count: 1 },
      { dir: 'geodata', count: 1 },
    ])

    // Files in new location.
    expect(await readFile(join(home, 'packs/local/tools/my-tool.ts'),   'utf-8')).toContain('my-tool')
    expect(await readFile(join(home, 'packs/local/skills/scratch/SKILL.md'), 'utf-8')).toContain('scratch')
    expect(await readFile(join(home, 'packs/local/scripts/my-script.md'), 'utf-8')).toContain('My Script')
    expect(await readFile(join(home, 'packs/local/geodata/cafes.geojson'), 'utf-8')).toContain('FeatureCollection')

    // Old dirs empty (still exist as empty dirs since we move CONTENTS).
    expect(await listAll(join(home, 'tools'))).toEqual([])
    expect(await listAll(join(home, 'skills'))).toEqual([])
    expect(await listAll(join(home, 'scripts'))).toEqual([])
    expect(await listAll(join(home, 'geodata'))).toEqual([])

    // Backup tarball exists.
    expect(result.backupPath).toBeDefined()
    expect(existsSync(result.backupPath!)).toBe(true)

    // Sentinel written.
    expect(existsSync(join(home, '.local-pack-migrated'))).toBe(true)
  })

  test('preserves geodata/.bundled cache subdir at the OLD path', async () => {
    await writeFiles(home, {
      'geodata/airports.geojson':            '{"type":"FeatureCollection","features":[]}',
      'geodata/.bundled/v1/some-cache.json': '{"cached":"data"}',
    })

    const result = await migrateLocalPack(home)
    expect(result.status).toBe('migrated')

    // User data moved.
    expect(existsSync(join(home, 'packs/local/geodata/airports.geojson'))).toBe(true)
    // Cache subdir stays at the old location.
    expect(existsSync(join(home, 'geodata/.bundled/v1/some-cache.json'))).toBe(true)
    // No .bundled in the new location.
    expect(existsSync(join(home, 'packs/local/geodata/.bundled'))).toBe(false)
  })

  test('refuses to migrate when both old and new dirs have content (conflict)', async () => {
    await writeFiles(home, {
      'tools/old.ts':                    'old',
      'packs/local/tools/already-here.ts': 'pre-existing',
    })

    const result = await migrateLocalPack(home)
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('already has content')
    // No sentinel, no backup, nothing moved.
    expect(existsSync(join(home, '.local-pack-migrated'))).toBe(false)
    expect(await listAll(join(home, 'tools'))).toEqual(['old.ts'])
    expect(await listAll(join(home, 'packs/local/tools'))).toEqual(['already-here.ts'])
  })

  test('partial coverage: migrates only the dirs that have content', async () => {
    await writeFiles(home, {
      'tools/foo.ts':         'export default {}',
      // skills/, scripts/, geodata/ all absent.
    })

    const result = await migrateLocalPack(home)
    expect(result.status).toBe('migrated')
    expect(result.moved).toEqual([{ dir: 'tools', count: 1 }])
    expect(existsSync(join(home, 'packs/local/tools/foo.ts'))).toBe(true)
    expect(existsSync(join(home, 'packs/local/skills'))).toBe(false)
    expect(existsSync(join(home, 'packs/local/scripts'))).toBe(false)
    expect(existsSync(join(home, 'packs/local/geodata'))).toBe(false)
  })

  test('writes sentinel even on no-op so subsequent boots short-circuit', async () => {
    // Empty home, but skip path SHOULD still drop the sentinel.
    const result1 = await migrateLocalPack(home)
    expect(result1.status).toBe('skipped')
    expect(existsSync(join(home, '.local-pack-migrated'))).toBe(true)

    // Second call observes the sentinel.
    const result2 = await migrateLocalPack(home)
    expect(result2.status).toBe('skipped')
    expect(result2.reason).toBe('sentinel present')
  })

  test('handles nested skill directories (multi-file)', async () => {
    await writeFiles(home, {
      'skills/scratch/SKILL.md':       '---\nname: scratch\n---\nbody',
      'skills/scratch/tools/helper.ts': 'export default {}',
      'skills/scratch/notes.md':       'extra notes',
    })

    const result = await migrateLocalPack(home)
    expect(result.status).toBe('migrated')
    expect(existsSync(join(home, 'packs/local/skills/scratch/SKILL.md'))).toBe(true)
    expect(existsSync(join(home, 'packs/local/skills/scratch/tools/helper.ts'))).toBe(true)
    expect(existsSync(join(home, 'packs/local/skills/scratch/notes.md'))).toBe(true)
  })
})
