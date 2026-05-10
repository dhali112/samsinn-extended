// ============================================================================
// write_scenario — Lets agents author a scenario as markdown.
//
// Mirrors write_script (pure data, not executable code; same threat model).
// Validation happens server-side in scenarioStore.upsert (markdown parsed
// strictly; bad input rejected with line context).
// ============================================================================

import type { Tool } from '../../core/types/tool.ts'
import { type ScenarioStore, MAX_SCENARIO_SOURCE_BYTES } from '../../core/scenarios/store.ts'

export interface CatalogChangedEmitter {
  (): void
}

export const createWriteScenarioTool = (
  store: ScenarioStore,
  emitCatalogChanged: CatalogChangedEmitter,
): Tool => ({
  name: 'write_scenario',
  description: 'Creates or overwrites a scenario (markdown). Scenarios sequence imperative setup ops (install pack, create room, spawn agents, start scripts, wait for events) for onboarding flows or multi-step demos. See docs in src/core/scenarios/ for the op DSL.',
  usage: 'Provide `name` (lowercase + dash/underscore) and full markdown `source`. Pure data — no code execution. Malformed input is rejected with a line number.',
  returns: 'On success: { name, title }. On failure: { error }.',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Filesystem-safe scenario name (lowercase alphanumerics, dashes, underscores).',
      },
      source: {
        type: 'string',
        description: 'Full markdown source. Must include frontmatter with `title` plus one or more ```scenario YAML op blocks.',
      },
    },
    required: ['name', 'source'],
  },
  execute: async (params) => {
    const name = typeof params.name === 'string' ? params.name : ''
    const source = typeof params.source === 'string' ? params.source : ''
    if (!name || !source) {
      return { success: false, error: 'name and source are required strings' }
    }
    if (source.length > MAX_SCENARIO_SOURCE_BYTES) {
      return { success: false, error: `source too large: ${source.length} bytes (max ${MAX_SCENARIO_SOURCE_BYTES})` }
    }
    try {
      const scenario = await store.upsert(name, source)
      emitCatalogChanged()
      return { success: true, data: { name: scenario.name, title: scenario.title } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
})
