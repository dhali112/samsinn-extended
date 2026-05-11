// Tool Surface Manager — public API.
//
// One mechanism:
//
//   Family compression (families.ts)
//     Collapse tools sharing a prefix or family rule into a single synthetic
//     dispatcher. 14 filesystem__ tools → 1 fs dispatcher. ~85% token cut on
//     the family.
//
// Provider-aware: when the agent's resolved provider is in
// STRICT_TOOL_SCHEMA_PROVIDERS (currently: gemini), the surface returns the
// FLAT list — family dispatchers use an untyped `args: object` shape that
// strict providers refuse, so we trade compression for accuracy on those.
//
// No hard cap. Earlier versions of this module enforced a 2000-token budget
// cap that silently dropped pack-bundled tools when registration order put
// other tools first — a brittleness landmine that caused production bugs
// (the skill said "call biometrics_start" but the cap had stripped the tool
// from the surface, so models rationalised "not supported in this
// environment"). The cap was removed in favour of trusting user intent:
// pack activation is authoritative. If the user activates a pack, every
// tool that pack registered is in the surface. Period. Surface size
// pressure is a knob the user controls (pack activation toggles), not
// something the system silently mitigates by lying about capabilities.
//
// Stateless except for the registered synthetic dispatcher tools (one-time
// registration at boot). No per-agent state. No snapshot impact.

import type { Tool, ToolDefinition, ToolRegistry, ToolRegistryEntry } from '../core/types/tool.ts'
import { toolsToDefinitions } from '../llm/tool-capability.ts'
import { effectiveActivePackSet } from '../packs/activation.ts'
import { compressFamilies, BUILT_IN_FAMILIES, FAMILY_DISPATCHER_NAMES, type ToolFamily } from './families.ts'
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
  readonly families?: ReadonlyArray<ToolFamily>            // default BUILT_IN_FAMILIES (test seam)
}

export const createToolSurface = (deps: CreateToolSurfaceDeps): ToolSurface => {
  const families = deps.families ?? BUILT_IN_FAMILIES
  const requestedSet = new Set(deps.requestedTools)

  // Compute once per project() call; member resolution is lazy so MCP /
  // pack lifecycle changes are picked up automatically.
  //
  // Two contributions UNION into the candidate set:
  //
  //   1. The agent's requestedTools (config.tools or the implicit-active
  //      default from spawn) — intersected with the registry and then
  //      filtered by per-room pack activation. These are tools the agent
  //      was spawned with.
  //
  //   2. EVERY tool whose owning pack is active in this room. This is the
  //      "pack activation is authoritative" invariant: when a user
  //      activates a pack in a room, ALL of that pack's tools become
  //      visible to any agent in that room, regardless of whether the
  //      agent's requestedTools listed them. Without this, the narrowed
  //      spawn default would silently hide pack-bundled tools the user
  //      explicitly turned on.
  //
  // Family dispatcher names (geo_tools, fs, pack_admin, codegen_tools)
  // are universally excluded from the candidate set — the compressed
  // path re-synthesises them, the flat path wants the underlying tools,
  // and including a stored dispatcher caused Gemini "Duplicate function
  // declaration" failures (geo_tools synthesised + stored sharing a name).
  const buildCandidates = (roomId: string | undefined): ReadonlySet<string> => {
    const room = roomId && deps.getRoomActivation ? deps.getRoomActivation(roomId) : undefined
    const activeSet = room ? effectiveActivePackSet(room) : null

    const accept = (name: string, entry: ReturnType<typeof deps.registry.getEntry>): boolean => {
      if (!entry) return false
      if (FAMILY_DISPATCHER_NAMES.has(name)) return false
      if (!activeSet) return true                                    // no room → no filter
      return activeSet.has(packForToolEntry(entry))
    }

    const candidates = new Set<string>()
    // (1) agent's requestedTools that pass the activation gate
    for (const name of requestedSet) {
      const entry = deps.registry.getEntry(name)
      if (accept(name, entry)) candidates.add(name)
    }
    // (2) every tool from an active pack — adds pack tools regardless of
    //     whether the agent's spawn-time requestedTools listed them.
    if (activeSet) {
      for (const entry of deps.registry.listEntries()) {
        const name = entry.tool.name
        if (FAMILY_DISPATCHER_NAMES.has(name)) continue
        if (activeSet.has(packForToolEntry(entry))) candidates.add(name)
      }
    }
    return candidates
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
      return isStrictProvider(providerName)
        ? projectFlat(candidates)
        : projectCompressed(candidates)
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
export { STRICT_TOOL_SCHEMA_PROVIDERS, isStrictProvider, inferProviderFromModelRef } from './strict-providers.ts'
