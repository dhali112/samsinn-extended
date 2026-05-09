// ============================================================================
// Scenario store — discovers scenarios from installed packs + bundled
// synthetic packs (welcome). Mirrors the script-store pattern.
//
// Layout per pack:
//   <packDir>/scenarios/<name>/scenario.md   ← preferred
//   <packDir>/scenarios/<name>.md            ← flat
//
// Bundled synthetic scenarios are registered at construction via
// `extraSources` — used by the welcome pack which lives in the source tree
// rather than under SAMSINN_HOME/packs.
// ============================================================================

import type { Scenario } from './types.ts'
import { parseScenario, VALID_NAME } from './parser.ts'
import { scanMarkdownDir } from '../markdown-fs.ts'

export const MAX_SCENARIO_SOURCE_BYTES = 256 * 1024

export interface ExtraSource {
  readonly pack: string
  readonly scenarios: ReadonlyArray<{ readonly name: string; readonly source: string }>
}

export interface ScenarioStore {
  readonly get: (id: string) => Scenario | undefined
  readonly list: () => ReadonlyArray<Scenario>
  readonly listForPack: (pack: string) => ReadonlyArray<Scenario>
  readonly reload: () => Promise<ReadonlyArray<string>>
  readonly onChange: (fn: () => void) => () => void
}

export interface ScenarioStoreInit {
  // Per-pack `scenarios/` directories. Resolved per reload so pack
  // install/uninstall picks up changes.
  readonly resolvePackDirs?: () => Promise<ReadonlyArray<{ readonly pack: string; readonly dir: string }>>
  // Bundled synthetic scenarios — welcome pack lives here. A function so
  // bundled sources that depend on per-System state (e.g. the welcome pack
  // resolves the default model from live provider state) can be lazily
  // computed after System construction completes.
  readonly extraSources?: () => ReadonlyArray<ExtraSource>
}

export const createScenarioStore = (init: ScenarioStoreInit): ScenarioStore => {
  const { resolvePackDirs, extraSources } = init
  const scenarios = new Map<string, Scenario>()
  const listeners = new Set<() => void>()

  const fireChange = (): void => {
    for (const fn of listeners) {
      try { fn() } catch { /* listener errors must not break the store */ }
    }
  }

  const reload = async (): Promise<ReadonlyArray<string>> => {
    const merged = new Map<string, Scenario>()

    // Bundled synthetic scenarios first — same id-collision rule as packs.
    const bundled = extraSources ? extraSources() : []
    for (const src of bundled) {
      for (const { name, source } of src.scenarios) {
        try {
          const parsed = parseScenario(src.pack, name, source)
          if (merged.has(parsed.id)) {
            console.warn(`[scenarios] duplicate id "${parsed.id}" — second occurrence wins`)
          }
          merged.set(parsed.id, parsed)
        } catch (err) {
          console.warn(
            `[scenarios] bundled "${src.pack}/${name}" invalid — ${err instanceof Error ? err.message : err}`,
          )
        }
      }
    }

    if (resolvePackDirs) {
      const packDirs = await resolvePackDirs()
      for (const { pack, dir } of packDirs) {
        const loaded = await scanPackScenarios(pack, dir)
        for (const s of loaded) {
          if (merged.has(s.id)) {
            console.warn(`[scenarios] id collision for "${s.id}" — first wins`)
            continue
          }
          merged.set(s.id, s)
        }
      }
    }

    scenarios.clear()
    for (const [id, s] of merged) scenarios.set(id, s)
    fireChange()
    return [...scenarios.keys()]
  }

  const onChange = (fn: () => void): (() => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  return {
    get: (id) => scenarios.get(id),
    list: () => [...scenarios.values()],
    listForPack: (pack) => [...scenarios.values()].filter(s => s.pack === pack),
    reload,
    onChange,
  }
}

// === Filesystem scan ===
//
// Delegates to the shared scanMarkdownDir helper. Differs from the script
// store only in the `pack` namespace tag baked into each parsed Scenario.

const scanPackScenarios = async (pack: string, dir: string): Promise<ReadonlyArray<Scenario>> => {
  const results = await scanMarkdownDir<Scenario>({
    dir,
    innerFilename: 'scenario.md',
    validNameRe: VALID_NAME,
    logPrefix: 'scenarios',
    maxBytes: MAX_SCENARIO_SOURCE_BYTES,
    parse: (name, raw) => parseScenario(pack, name, raw),
  })
  return results.map(r => r.value)
}
