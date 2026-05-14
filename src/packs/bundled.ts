// ============================================================================
// Bundled-pack registry — the single in-code table of packs compiled into
// the binary. Replaces the scattered IMPLICIT_ACTIVE list and the
// hand-rolled "synthetic bucket" logic in list_packs.
//
// Each entry carries:
//   - namespace    the pack's stable id (`core`, `local`, `demos`, `pwr-ops`)
//   - displayName  shown in the UI
//   - description  shown in the UI
//   - system       true ⇒ cannot be removed from a room's activePacks
//                  (enforced at the activation route + UI lock)
//   - defaultActive true ⇒ auto-added to room.activePacks on new-room
//                  creation. Once a room exists, the flag stops mattering —
//                  room.activePacks is authoritative.
//
// `core` and `local` are SYSTEM-pack synthetic entries — they have no
// directory on disk. Their tools register under kind:'built-in' and
// kind:'external' respectively; packNameFor maps those to 'core' / 'local'.
//
// `demos` and `pwr-ops` are BUNDLED real packs — compiled in today, with
// the intent to graduate to filesystem registry packs (samsinn-packs/...)
// later. Their tools register under kind:'pack-bundled' with the
// corresponding `pack` namespace so per-room activation actually gates them.
// They are NOT subject to the `<pack>_<tool>` prefix convention that
// filesystem packs use (loadToolDirectory applies the prefix; we don't go
// through it for bundled packs). When pwr-ops graduates, its tool names
// will need a rename at that migration point — flagged below.
// ============================================================================

export interface BundledPack {
  readonly namespace: string
  readonly displayName: string
  readonly description: string
  readonly system: boolean
  readonly defaultActive: boolean
}

export const BUNDLED_PACKS: ReadonlyArray<BundledPack> = [
  {
    namespace: 'core',
    displayName: 'core',
    description: 'Built-in tools (always active, cannot be uninstalled).',
    system: true,
    defaultActive: true,
  },
  {
    namespace: 'local',
    displayName: 'local',
    description: 'Drop-in tools and skills under ~/.samsinn/{tools,skills}/. Always active.',
    system: true,
    defaultActive: true,
  },
  {
    namespace: 'demos',
    displayName: 'demos',
    description: 'Capability-showcase tools (Aviation demo: norway_platforms, vatsim_arrivals).',
    system: false,
    defaultActive: true,
  },
  {
    namespace: 'pwr-ops',
    displayName: 'pwr-ops',
    description: 'Westinghouse PWR Emergency Operating Procedures — wiki-backed procedure_lookup, procedure_search, wiki_lookup, eal_classify.',
    system: false,
    defaultActive: true,
  },
]

// Lookup helpers — small enough to walk, no need to materialise a Map.

export const getBundledPack = (namespace: string): BundledPack | undefined =>
  BUNDLED_PACKS.find(p => p.namespace === namespace)

export const isSystemPack = (namespace: string): boolean =>
  BUNDLED_PACKS.some(p => p.namespace === namespace && p.system)

// Used by seed-instance.ts when creating a fresh room. Filesystem-installed
// packs do NOT contribute to default-active (operator opts in per pack at
// install time, then per-room via the UI) — only bundled defaultActive
// entries are auto-seeded.
export const defaultActiveNamespaces = (): ReadonlyArray<string> =>
  BUNDLED_PACKS.filter(p => p.defaultActive).map(p => p.namespace)
