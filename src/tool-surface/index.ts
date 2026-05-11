// Tool Surface Manager — public API.
//
// One subsystem, two mechanisms (Layers 1 + 4 of the original 4-layer plan;
// Layers 2 + 3 deferred):
//
//   Layer 1 — Family compression (families.ts)
//     Collapse tools sharing a prefix or family rule into a single synthetic
//     dispatcher. 14 filesystem__ tools → 1 fs dispatcher. ~85% token cut on
//     the family.
//
//   Layer 4 — Budget cap (budget.ts)
//     Cap total tool-definition tokens. Core conversational tools + family
//     dispatchers exempt. Pathological cases lose their tail.
//
// Provider-aware: when the agent's resolved provider is in
// STRICT_TOOL_SCHEMA_PROVIDERS (currently: gemini), the surface returns the
// FLAT list — family dispatchers use an untyped `args: object` shape that
// strict providers refuse, so we trade compression for accuracy on those.
//
// Stateless except for the registered synthetic dispatcher tools (one-time
// registration at boot). No per-agent state. No snapshot impact.

import type { Tool, ToolDefinition, ToolRegistry, ToolRegistryEntry } from '../core/types/tool.ts'
import { toolsToDefinitions } from '../llm/tool-capability.ts'
import { effectiveActivePackSet } from '../packs/activation.ts'
import { compressFamilies, BUILT_IN_FAMILIES, FAMILY_DISPATCHER_NAMES, type ToolFamily } from './families.ts'
import { fitProjection, logBudgetTriggerOnce, DEFAULT_TOOL_TOKEN_BUDGET } from './budget.ts'
import { isStrictProvider } from './strict-providers.ts'

// Same shape as GetRoomActivation in spawn.ts — duplicated here to avoid an
// import cycle with the agent module while keeping the surface as a leaf.
export interface RoomActivation {
  readonly getActivePacks: () => ReadonlyArray<string>
}
export type GetRoomActivation = (roomId: string) => RoomActivation | undefined

// Identical to packForToolEntry in spawn.ts — duplicated here for the same
// reason. Family dispatchers (kind: 'built-in') map to 'core' so they're
// always pack-active. The dispatcher's own visibility-when-empty check
// already excludes it when no member is in the active set.
const packForToolEntry = (entry: ToolRegistryEntry): string => {
  switch (entry.source.kind) {
    case 'built-in': return 'core'
    case 'external': return 'local'
    case 'pack-bundled': return entry.source.pack ?? 'local'
    case 'skill-bundled': return entry.source.pack ?? 'local'
  }
}

export interface ToolSurface {
  // Project the registered tools down to the LLM-facing definition list,
  // applying family compression (unless provider is strict), per-room pack
  // activation, and budget cap. Pass the resolved `providerName` if known;
  // pass undefined to conservatively skip compression.
  readonly project: (roomId: string | undefined, providerName: string | undefined) => ReadonlyArray<ToolDefinition>

  // Family dispatcher tools that need to be registered into the tool
  // registry so the executor can route subcommand calls. Idempotent — the
  // same dispatcher names are reused across surfaces.
  readonly getDispatchers: () => ReadonlyArray<Tool>
}

export interface CreateToolSurfaceDeps {
  readonly registry: ToolRegistry
  readonly requestedTools: ReadonlyArray<string>           // existing config.tools ?? all
  readonly getRoomActivation?: GetRoomActivation
  readonly tokenBudget?: number                            // default DEFAULT_TOOL_TOKEN_BUDGET
  readonly families?: ReadonlyArray<ToolFamily>            // default BUILT_IN_FAMILIES (test seam)
  readonly logKey?: string                                 // budget-warn dedup key (e.g. agentId)
}

export const createToolSurface = (deps: CreateToolSurfaceDeps): ToolSurface => {
  const families = deps.families ?? BUILT_IN_FAMILIES
  const budget = deps.tokenBudget ?? DEFAULT_TOOL_TOKEN_BUDGET
  const logKey = deps.logKey ?? 'unknown'
  const requestedSet = new Set(deps.requestedTools)

  // Compute once per project() call; member resolution is lazy so MCP /
  // pack lifecycle changes are picked up automatically.
  const buildCandidates = (roomId: string | undefined): ReadonlySet<string> => {
    // Start from the agent's requested tool set, intersected with what's
    // currently registered (a tool may have been unregistered after spawn).
    // CRITICAL: exclude previously-registered family dispatcher names. The
    // registry holds them so the executor can route tool calls by name, but
    // they must NOT appear in the projection — the compressed path
    // re-synthesises them fresh, and the flat path wants the underlying
    // tools (not the dispatcher). Including a stored dispatcher caused
    // Gemini to reject with "Duplicate function declaration found:
    // geo_tools" — the synthesised dispatcher plus the stored one share a
    // name. Filtering here makes both paths safe.
    const present = new Set<string>()
    for (const name of requestedSet) {
      if (FAMILY_DISPATCHER_NAMES.has(name)) continue
      if (deps.registry.has(name)) present.add(name)
    }
    // Per-room pack activation filter — pre-existing behavior, now living
    // here instead of in spawn.ts. Built-in / local / always-active packs
    // (core/local/welcome/demos) pass through; explicit room activations
    // gate pack-bundled tools.
    if (!roomId || !deps.getRoomActivation) return present
    const room = deps.getRoomActivation(roomId)
    if (!room) return present
    const activeSet = effectiveActivePackSet(room)
    const filtered = new Set<string>()
    for (const name of present) {
      const entry = deps.registry.getEntry(name)
      if (!entry) continue
      if (activeSet.has(packForToolEntry(entry))) filtered.add(name)
    }
    return filtered
  }

  const projectCompressed = (candidates: ReadonlySet<string>): ReadonlyArray<ToolDefinition> => {
    const { dispatchers, passthroughEntries } = compressFamilies(deps.registry, candidates, families)
    const passthroughTools = passthroughEntries.map(e => e.tool)
    return toolsToDefinitions([...dispatchers, ...passthroughTools])
  }

  const projectFlat = (candidates: ReadonlySet<string>): ReadonlyArray<ToolDefinition> => {
    const tools: Tool[] = []
    for (const name of candidates) {
      const t = deps.registry.get(name)
      if (t) tools.push(t)
    }
    return toolsToDefinitions(tools)
  }

  return {
    project: (roomId, providerName) => {
      const candidates = buildCandidates(roomId)
      const raw = isStrictProvider(providerName)
        ? projectFlat(candidates)
        : projectCompressed(candidates)
      const fit = fitProjection(raw, budget)
      if (fit.dropped.length > 0) logBudgetTriggerOnce(logKey, fit)
      return fit.kept
    },
    getDispatchers: () => {
      // For boot-time registration: produce dispatchers for every family
      // whose membership currently has ≥ minMembers, regardless of the
      // requested set. The executor needs to route any subcommand call,
      // even if a specific agent's projection wouldn't have shown the
      // dispatcher (e.g. the dispatcher was visible in another agent's
      // projection and that agent called a tool by family name).
      //
      // Resolved against the full registry, not the requested set.
      const allNames = new Set(deps.registry.list().map(t => t.name))
      const { dispatchers } = compressFamilies(deps.registry, allNames, families)
      return dispatchers
    },
  }
}

export { BUILT_IN_FAMILIES, FAMILY_DISPATCHER_NAMES, CORE_TOOL_NAMES } from './families.ts'
export { DEFAULT_TOOL_TOKEN_BUDGET, estimateTokens, __resetBudgetWarnState } from './budget.ts'
export { STRICT_TOOL_SCHEMA_PROVIDERS, isStrictProvider, inferProviderFromModelRef } from './strict-providers.ts'
