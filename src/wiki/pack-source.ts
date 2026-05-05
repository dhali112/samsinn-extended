// ============================================================================
// Pack-bundled wikis loader.
//
// Each installed pack may ship `<pack>/wikis/<slug>/` directories. Each
// such directory becomes a MergedWikiEntry with dirPath set, which the
// registry's default factory routes to the filesystem adapter.
//
// Sole wiki source post-prune (commit M). The samsinn-wikis GitHub
// discovery and operator-stored wikis.json adapter were removed; packs
// are the only distribution mechanism for wiki content.
//
// Convention: <pack>/wikis/<slug>/index.md is required for the slug to be
// treated as a wiki. A slug without index.md is silently skipped (logged
// once at scan time so the pack author sees it). This matches the
// GitHub adapter's contract — index.md is the entrypoint.
// ============================================================================

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { scanPackSubdirs } from '../packs/scanner.ts'
import type { MergedWikiEntry } from './types.ts'

const VALID_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

// id namespace for pack-bundled wikis: `<pack>:<slug>` keeps them
// distinct from GitHub-discovered ids (which are user-chosen, typically
// short like 'nuclear'). The colon is also a wiki-id reserved char (the
// stored config validator rejects it for user-entered ids), so collisions
// with the operator's own configured wikis are impossible by construction.
const buildId = (pack: string, slug: string): string => `${pack}:${slug}`

// Scanned entry IS a MergedWikiEntry — no separate shape post-prune.
export type ScannedPackWiki = MergedWikiEntry

export const scanPackWikis = async (
  packsDir: string,
): Promise<ReadonlyArray<ScannedPackWiki>> => {
  const wikiDirs = await scanPackSubdirs(packsDir, 'wikis')
  const out: ScannedPackWiki[] = []

  for (const { pack, dir: packWikisDir } of wikiDirs) {
    const fs = await import('node:fs/promises')
    let entries: string[] = []
    try { entries = await fs.readdir(packWikisDir) } catch { continue }

    for (const slug of entries) {
      if (!VALID_SLUG.test(slug)) {
        console.warn(`[wiki/pack] ${pack}/wikis/${slug}: slug must match /^[a-z0-9][a-z0-9-]{0,62}$/ — skipping`)
        continue
      }
      const slugDir = join(packWikisDir, slug)
      let s
      try { s = await stat(slugDir) } catch { continue }
      if (!s.isDirectory()) continue

      // Require index.md as the entrypoint, mirroring github-adapter's
      // contract. Skip silently otherwise — a slug folder with no
      // index.md isn't a usable wiki.
      try {
        const indexStat = await stat(join(slugDir, 'index.md'))
        if (!indexStat.isFile()) continue
      } catch {
        console.warn(`[wiki/pack] ${pack}/wikis/${slug}: missing index.md — skipping`)
        continue
      }

      out.push({
        id: buildId(pack, slug),
        displayName: `${pack}/${slug}`,
        enabled: true,
        pack,
        dirPath: slugDir,
      })
    }
  }

  return out
}
