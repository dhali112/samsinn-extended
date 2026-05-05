// ============================================================================
// Wiki types — pack-bundled only.
//
// Post-prune: a wiki is always a directory under <pack>/wikis/<slug>/. The
// filesystem adapter loads pages from disk; there is no GitHub-discovery or
// operator-stored variant. Wiki id is namespaced as `<pack>:<slug>`.
//
// On-disk layout under <pack>/wikis/<slug>/:
//   index.md         catalog (required)
//   scope.md         coverage hints (optional)
//   <slug>.md        pages with YAML frontmatter + [[wikilinks]]
//   subdir/<slug>.md nested ok; the adapter walks recursively
// ============================================================================

// === Wiki entry (in-memory; not persisted) ===

export interface MergedWikiEntry {
  readonly id: string                  // `<pack>:<slug>`
  readonly displayName: string         // resolved
  readonly enabled: boolean
  readonly pack: string                // owning pack namespace
  readonly dirPath: string             // absolute path to the on-disk wiki dir
}

// === Bindings (persisted in snapshot, not in wikis.json) ===

export type WikiBindingScope = 'room' | 'agent'

export interface WikiBinding {
  readonly scope: WikiBindingScope
  readonly subjectId: string           // roomId or agentId
  readonly wikiId: string
}

// === Parsed page shape (in-memory cache) ===

export interface WikiPageFrontmatter {
  readonly title: string
  readonly type?: string               // concept | entity | summary | comparison | scenario | ...
  readonly sources?: ReadonlyArray<string>
  readonly related?: ReadonlyArray<string>     // raw "[[slug]]" tokens
  readonly tags?: ReadonlyArray<string>
  readonly confidence?: 'high' | 'medium' | 'low'
  readonly created?: string
  readonly updated?: string
}

export interface WikiPage {
  readonly slug: string                // filename without .md
  readonly path: string                // wiki-relative path, e.g. "concepts/foo.md"
  readonly frontmatter: WikiPageFrontmatter
  readonly body: string                // markdown after frontmatter
  readonly wikilinks: ReadonlyArray<string>    // extracted [[slug]] targets
  readonly fetchedAt: number           // ms since epoch
}

// === Wiki state (per registered wiki, in-memory) ===

export interface WikiState {
  readonly id: string
  readonly displayName: string
  readonly indexMd?: string            // raw wiki/index.md
  readonly scopeMd?: string            // raw wiki/scope.md
  readonly pages: ReadonlyMap<string, WikiPage>  // slug → page
  readonly lastWarmAt?: number
  readonly lastError?: string
}
