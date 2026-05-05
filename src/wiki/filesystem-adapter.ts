// ============================================================================
// Filesystem adapter — load wiki pages from a pack's on-disk wiki dir.
//
// Layout under <pack>/wikis/<slug>/:
//
//   index.md                 ← required, top-level overview
//   scope.md                 ← optional, agent-facing scope hints
//   <slug>.md                ← any number of pages (may be in subdirs)
//   subdir/<slug>.md         ← nested ok; listWikiTree walks recursively
//
// Note this is the LOCAL parallel of github-adapter's wiki/ subdir
// convention, but flatter: there's no top-level wiki/ folder because the
// pack's wikis/<slug>/ already scopes the content. (GitHub adapters add
// the wiki/ prefix because the repo also has README.md, LICENSE, etc.)
//
// Errors map onto the same WikiError taxonomy as github-adapter so the
// registry doesn't need to special-case the source of failure:
//   ENOENT      → 'not_found'
//   EACCES      → 'unavailable'
//   anything else → 'parse_error' / 'unavailable'
// ============================================================================

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { MergedWikiEntry } from './types.ts'
import type { WikiAdapter } from './github-adapter.ts'
import { createWikiError, isWikiError } from './errors.ts'

// Walks the wiki dir recursively, returning slug-relative .md paths.
// Mirrors github-adapter's listWikiTree shape — same return type so the
// registry treats both the same way.
const walkMarkdown = async (root: string, rel = ''): Promise<string[]> => {
  let entries: string[]
  try { entries = await readdir(join(root, rel)) }
  catch { return [] }

  const out: string[] = []
  for (const e of entries) {
    if (e.startsWith('.')) continue
    const relPath = rel ? `${rel}/${e}` : e
    const full = join(root, relPath)
    let s
    try { s = await stat(full) } catch { continue }
    if (s.isDirectory()) {
      out.push(...await walkMarkdown(root, relPath))
    } else if (s.isFile() && e.endsWith('.md')) {
      out.push(relPath)
    }
  }
  return out
}

const readMarkdown = async (path: string, wikiId: string): Promise<string> => {
  try {
    return await readFile(path, 'utf-8')
  } catch (err) {
    const cause = err as NodeJS.ErrnoException
    if (cause.code === 'ENOENT') {
      throw createWikiError('not_found', `${path} not found`, { wikiId, cause })
    }
    if (cause.code === 'EACCES') {
      throw createWikiError('unavailable', `${path} not readable: ${cause.message}`, { wikiId, cause })
    }
    throw createWikiError('parse_error', `${path} read failed: ${cause.message}`, { wikiId, cause })
  }
}

export const createFilesystemAdapter = (wiki: MergedWikiEntry): WikiAdapter => {
  if (!wiki.dirPath) {
    // Defensive — caller should never reach here without dirPath (the
    // factory dispatch in registry.ts is what gates this). Throw rather
    // than silently degrade.
    throw new Error(`createFilesystemAdapter: wiki "${wiki.id}" has no dirPath`)
  }
  const root = wiki.dirPath
  const id = wiki.id

  const fetchIndex = async (): Promise<string> =>
    readMarkdown(join(root, 'index.md'), id)

  const fetchScope = async (): Promise<string | undefined> => {
    try { return await readMarkdown(join(root, 'scope.md'), id) }
    catch (err) {
      if (isWikiError(err) && err.kind === 'not_found') return undefined
      throw err
    }
  }

  const fetchPage = async (slug: string): Promise<{ path: string; body: string }> => {
    // Try flat path first (matches github-adapter's order: most slugs
    // resolve at the top level of the wiki dir).
    const flat = `${slug}.md`
    try {
      const body = await readMarkdown(join(root, flat), id)
      return { path: flat, body }
    } catch (err) {
      if (!isWikiError(err) || err.kind !== 'not_found') throw err
      // Subdirectory case — walk and find a path that ends in /<slug>.md.
      const tree = await listWikiTree()
      const target = tree.find(p => p === flat || p.endsWith(`/${slug}.md`))
      if (!target) throw err
      const body = await readMarkdown(join(root, target), id)
      return { path: target, body }
    }
  }

  let cachedTree: ReadonlyArray<string> | undefined

  const listWikiTree = async (): Promise<ReadonlyArray<string>> => {
    if (cachedTree) return cachedTree
    const found = await walkMarkdown(root)
    cachedTree = found
    return found
  }

  return { fetchIndex, fetchScope, fetchPage, listWikiTree }
}
