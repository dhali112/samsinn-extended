// ============================================================================
// Geo discovery — finds available geodata repositories on GitHub so prod
// (and any new instance) can pick up curated categories + features without
// per-machine geodata edits.
//
// Mirrors src/wiki/discovery.ts. Sources via SAMSINN_GEO_SOURCES (csv of
// `<owner>` or `<owner>/<repo>`, default `samsinn-geodata`).
//
// Convention:
//   - Owner ending in `-geodata` (e.g. `samsinn-geodata`) → every
//     non-archived / non-fork repo is treated as a geo source.
//   - Other owners → repo basename must start with `samsinn-geo-`.
//
// Token: SAMSINN_GEO_REGISTRY_TOKEN (separate from packs/wiki tokens — same
// rationale as those: org listings need broad public read; the
// fine-grained bug-report PAT 403s on every endpoint outside its scope).
//
// The result is ephemeral: discovered sources are merged with the on-disk
// store at runtime via store.ts:loadCategory + categories.ts:loadRegistry.
// Discovery NEVER writes to local files. Discovered features always carry
// `source: 'discovered'` and `verified: true`. On a (category, canonical-
// name) collision discovered wins; on a category-id collision the local
// registry entry wins (operator preference for displayName/icon).
// ============================================================================

const PREFIX = 'samsinn-geo-'
const CACHE_TTL_MS = 5 * 60_000

export interface DiscoveredGeoSource {
  readonly owner: string
  readonly repo: string         // unstripped GitHub repo name
  readonly displayName: string  // repo description if present, else "{owner}/{repo}"
  readonly description: string
  readonly repoUrl: string
  readonly source: string       // "owner/repo" — dedupe key
  readonly defaultBranch: string
}

interface CacheEntry {
  readonly fetchedAt: number
  readonly sources: ReadonlyArray<DiscoveredGeoSource>
}

let cache: CacheEntry | null = null

// Exported for tests.
export const parseSources = (raw: string | undefined): ReadonlyArray<string> => {
  const fallback = ['samsinn-geodata']
  if (!raw) return fallback
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts : fallback
}

const ghHeaders = (): Record<string, string> => {
  const h: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'samsinn-geo-registry',
  }
  const token = process.env.SAMSINN_GEO_REGISTRY_TOKEN
  if (token) h['Authorization'] = `Bearer ${token}`
  return h
}

interface GHRepo {
  name: string
  full_name: string
  description: string | null
  html_url: string
  default_branch?: string
  archived?: boolean
  fork?: boolean
}

// Owners whose repos are ALL treated as geo sources (no prefix filter).
// Anything matching `<x>-geodata` is assumed to be a dedicated geo-hosting
// org by convention. Operators putting a personal account in
// SAMSINN_GEO_SOURCES still get the prefix filter so unrelated repos
// don't pollute the registry.
// Exported for tests.
export const isGeoOnlyOwner = (owner: string): boolean =>
  /-geodata$/.test(owner) || owner === 'samsinn-geodata'

const repoToSource = (r: GHRepo): DiscoveredGeoSource => {
  const description = r.description ?? ''
  return {
    owner: r.full_name.split('/')[0] ?? '',
    repo: r.name,
    displayName: description.trim() || r.full_name,
    description,
    repoUrl: r.html_url,
    source: r.full_name,
    defaultBranch: r.default_branch ?? 'main',
  }
}

const fetchOwnerRepos = async (owner: string): Promise<ReadonlyArray<GHRepo>> => {
  const res = await fetch(
    `https://api.github.com/users/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated`,
    { headers: ghHeaders() },
  )
  if (!res.ok) {
    console.warn(`[geo/discovery] fetch ${owner} failed: HTTP ${res.status}`)
    return []
  }
  const repos = await res.json() as ReadonlyArray<GHRepo>
  return repos.filter((r) => !r.archived && !r.fork && (isGeoOnlyOwner(owner) || r.name.startsWith(PREFIX)))
}

const fetchOneRepo = async (ownerRepo: string): Promise<GHRepo | null> => {
  const res = await fetch(`https://api.github.com/repos/${ownerRepo}`, { headers: ghHeaders() })
  if (!res.ok) {
    console.warn(`[geo/discovery] fetch ${ownerRepo} failed: HTTP ${res.status}`)
    return null
  }
  return await res.json() as GHRepo
}

export const getAvailableGeoSources = async (): Promise<ReadonlyArray<DiscoveredGeoSource>> => {
  const now = Date.now()
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.sources

  const sources = parseSources(process.env.SAMSINN_GEO_SOURCES)
  const repos: GHRepo[] = []
  const seenSource = new Set<string>()
  for (const src of sources) {
    if (src.includes('/')) {
      const one = await fetchOneRepo(src)
      if (one && !seenSource.has(one.full_name)) {
        seenSource.add(one.full_name)
        repos.push(one)
      }
    } else {
      for (const r of await fetchOwnerRepos(src)) {
        if (seenSource.has(r.full_name)) continue
        seenSource.add(r.full_name)
        repos.push(r)
      }
    }
  }
  const discovered = repos.map(repoToSource)
  cache = { fetchedAt: now, sources: discovered }
  return discovered
}

// Test/debug helper — clears the in-memory cache so the next call refetches.
export const invalidateDiscoveryCache = (): void => { cache = null }
