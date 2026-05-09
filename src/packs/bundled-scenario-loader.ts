// ============================================================================
// Shared helper for loading scenarios bundled in the binary (synthetic packs
// like `welcome` and `demos`).
//
// Both packs follow the same pattern: read a `.scenario.md` file from the
// source tree at module-init, optionally substitute model-resolution tokens
// against live System state, and return an ExtraSource the scenario store
// consumes via its lazy `extraSources()` getter.
//
// Putting this in src/packs/ (next to synthetic-welcome) instead of
// src/core/scenarios/ keeps the dependency direction clean — the scenarios
// subsystem doesn't need to know about pack-specific binary bundling.
// ============================================================================

import { readFileSync } from 'node:fs'
import type { ExtraSource } from '../core/scenarios/store.ts'

export interface BundledScenarioSpec {
  // Filename of the .md to read, relative to the caller's import.meta.url.
  readonly file: string
  // Scenario name (the `<name>` in `<pack>/<name>`).
  readonly name: string
  // The caller's import.meta.url — used to resolve `file` relative to the
  // calling module's location. Pass `import.meta.url` from the synthetic
  // pack's index.ts.
  readonly importMetaUrl: string
}

// Optional: substitute placeholder tokens in the .md source (e.g.
// `__WELCOME_DEFAULT_MODEL__` → the live default model). Token map is
// applied before parsing — a no-op if empty/undefined.
export type TokenMap = Readonly<Record<string, string>>

export interface BuildBundledExtraSourceArgs {
  readonly pack: string
  readonly scenarios: ReadonlyArray<BundledScenarioSpec>
  readonly tokens?: TokenMap
}

// Read each .md, apply token substitution, return the ExtraSource shape
// the scenario store wants. Pure function — call site decides when to
// invoke (synthetic-welcome calls it from a per-System extraSources getter
// because it needs live provider state for model resolution; demos pack
// can call it once at module load if its tokens are static).
export const buildBundledExtraSource = (args: BuildBundledExtraSourceArgs): ExtraSource => {
  const { pack, scenarios, tokens } = args
  return {
    pack,
    scenarios: scenarios.map(spec => {
      const raw = readFileSync(new URL(spec.file, spec.importMetaUrl), 'utf-8')
      const source = tokens ? applyTokens(raw, tokens) : raw
      return { name: spec.name, source }
    }),
  }
}

const applyTokens = (source: string, tokens: TokenMap): string => {
  let out = source
  for (const [key, value] of Object.entries(tokens)) {
    out = out.replaceAll(key, value)
  }
  return out
}
