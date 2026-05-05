// Pack-bundled wiki loader + filesystem adapter tests.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanPackWikis } from './pack-source.ts'
import { createFilesystemAdapter } from './filesystem-adapter.ts'
import { isWikiError } from './errors.ts'
import type { MergedWikiEntry } from './types.ts'

const buildPack = async (parent: string, pack: string, slug: string, files: Record<string, string>): Promise<string> => {
  const dir = join(parent, pack, 'wikis', slug)
  await mkdir(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const sub = name.includes('/') ? join(dir, name.split('/').slice(0, -1).join('/')) : dir
    await mkdir(sub, { recursive: true })
    await writeFile(join(dir, name), content, 'utf-8')
  }
  return dir
}

describe('scanPackWikis', () => {
  let parent: string
  beforeEach(async () => { parent = await mkdtemp(join(tmpdir(), 'samsinn-pack-wiki-')) })
  afterEach(async () => { await rm(parent, { recursive: true, force: true }) })

  test('discovers <pack>/wikis/<slug>/ with index.md, namespaces id', async () => {
    await buildPack(parent, 'aviation', 'icao', {
      'index.md': '# ICAO\n\nAirport codes.',
      'osl.md': '# OSL\n\nOslo airport.',
    })
    const found = await scanPackWikis(parent)
    expect(found).toHaveLength(1)
    expect(found[0]?.id).toBe('aviation:icao')
    expect(found[0]?.pack).toBe('aviation')
    expect(found[0]?.dirPath).toMatch(/aviation\/wikis\/icao$/)
  })

  test('skips slugs without index.md (logs but does not throw)', async () => {
    await buildPack(parent, 'aviation', 'no-index', { 'foo.md': '# Foo' })
    const found = await scanPackWikis(parent)
    expect(found).toHaveLength(0)
  })

  test('rejects invalid slug names', async () => {
    await buildPack(parent, 'aviation', 'BadName', { 'index.md': '# x' })
    const found = await scanPackWikis(parent)
    expect(found).toHaveLength(0)
  })

  test('multi-pack scan returns separate entries with stable ids', async () => {
    await buildPack(parent, 'aviation', 'icao', { 'index.md': '# ICAO' })
    await buildPack(parent, 'cafes',   'oslo', { 'index.md': '# Oslo Cafes' })
    const found = await scanPackWikis(parent)
    expect(found.map(w => w.id).sort()).toEqual(['aviation:icao', 'cafes:oslo'])
  })

  test('empty packsDir returns []', async () => {
    const found = await scanPackWikis(parent)
    expect(found).toEqual([])
  })
})

describe('createFilesystemAdapter', () => {
  let parent: string
  let dir: string
  let entry: MergedWikiEntry

  beforeEach(async () => {
    parent = await mkdtemp(join(tmpdir(), 'samsinn-fs-wiki-'))
    dir = await buildPack(parent, 'aviation', 'icao', {
      'index.md': '# ICAO',
      'scope.md': '# Scope',
      'osl.md': '# OSL\n\nbody',
      'subdir/lha.md': '# LHA',
    })
    entry = {
      id: 'aviation:icao',
      owner: 'pack', repo: 'aviation/icao', ref: 'main',
      displayName: 'aviation/icao', apiKey: '', maskedKey: '—',
      enabled: true, pack: 'aviation', dirPath: dir,
    }
  })
  afterEach(async () => { await rm(parent, { recursive: true, force: true }) })

  test('fetchIndex reads index.md', async () => {
    const adapter = createFilesystemAdapter(entry)
    expect(await adapter.fetchIndex()).toContain('# ICAO')
  })

  test('fetchScope returns undefined when scope.md is absent', async () => {
    await rm(join(dir, 'scope.md'))
    const adapter = createFilesystemAdapter(entry)
    expect(await adapter.fetchScope()).toBeUndefined()
  })

  test('fetchPage finds flat slugs and subdirectory slugs', async () => {
    const adapter = createFilesystemAdapter(entry)
    const flat = await adapter.fetchPage('osl')
    expect(flat.body).toContain('# OSL')
    expect(flat.path).toBe('osl.md')
    const nested = await adapter.fetchPage('lha')
    expect(nested.body).toContain('# LHA')
    expect(nested.path).toBe('subdir/lha.md')
  })

  test('fetchPage throws not_found WikiError for missing slug', async () => {
    const adapter = createFilesystemAdapter(entry)
    try {
      await adapter.fetchPage('does-not-exist')
      throw new Error('expected throw')
    } catch (err) {
      expect(isWikiError(err)).toBe(true)
      if (isWikiError(err)) expect(err.kind).toBe('not_found')
    }
  })

  test('listWikiTree walks recursively, returns slug-relative paths', async () => {
    const adapter = createFilesystemAdapter(entry)
    const tree = await adapter.listWikiTree()
    expect([...tree].sort()).toEqual(['index.md', 'osl.md', 'scope.md', 'subdir/lha.md'])
  })

  test('throws if dirPath is unset (defensive)', () => {
    const noDir: MergedWikiEntry = { ...entry, dirPath: undefined }
    expect(() => createFilesystemAdapter(noDir)).toThrow(/no dirPath/)
  })
})
