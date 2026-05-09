// ============================================================================
// Synthetic 'welcome' pack — bundled with the binary, hosts the default
// first-run scenario that replaces the old hardcoded seed-example.ts.
//
// Scenarios live in this directory as .md files (readable + diffable). The
// bundled-scenario-loader helper reads them at extraSources() time, applies
// model-resolution token substitution, and returns the ExtraSource the
// scenario store consumes.
//
// The pack is "synthetic" in the same sense as 'core' and 'local' — it
// doesn't appear under SAMSINN_HOME/packs and isn't installable.
// ============================================================================

import type { System } from '../../main.ts'
import type { ExtraSource } from '../../core/scenarios/store.ts'
import { CURATED_MODELS } from '../../llm/models/catalog.ts'
import { resolveDefaultModel, type ProviderSnapshot } from '../../llm/models/default-resolver.ts'
import { buildBundledExtraSource } from '../bundled-scenario-loader.ts'

export const WELCOME_PACK_NAMESPACE = 'welcome'
export const WELCOME_DEFAULT_SCENARIO = 'getting-started'
export const WELCOME_DEFAULT_SCENARIO_ID = `${WELCOME_PACK_NAMESPACE}/${WELCOME_DEFAULT_SCENARIO}`

// Same pickSeedModel logic the old seed-example.ts used. Picks a model the
// live System actually has provider credentials for; falls back to a
// permissive default when nothing is configured.
const pickWelcomeModel = (system: System): string => {
  const override = process.env.SAMSINN_SEED_MODEL
  if (override && override.trim()) return override.trim()
  const names = new Set<string>([...Object.keys(CURATED_MODELS), 'ollama'])
  const providers: ProviderSnapshot[] = [...names].map(name => {
    const enabled = name === 'ollama' ? !!system.ollama : system.providerKeys.isEnabled(name)
    return {
      name,
      status: enabled ? 'ok' : 'no_key',
      models: (CURATED_MODELS[name] ?? []).map(m => ({ id: m.id })),
    }
  })
  return resolveDefaultModel(providers) || 'gemini-2.5-pro'
}

// Build the ExtraSource for the scenario store. Called per scenario-store
// reload (the store's extraSources is a lazy getter) so the model is
// re-resolved against current provider state.
export const buildWelcomeExtraSource = (system: System): ExtraSource =>
  buildBundledExtraSource({
    pack: WELCOME_PACK_NAMESPACE,
    scenarios: [
      {
        name: WELCOME_DEFAULT_SCENARIO,
        file: './getting-started.scenario.md',
        importMetaUrl: import.meta.url,
      },
    ],
    tokens: {
      // Double-underscore on both sides so it's not a valid bare identifier
      // in any natural-language prose / persona / model name.
      '__WELCOME_DEFAULT_MODEL__': pickWelcomeModel(system),
    },
  })
