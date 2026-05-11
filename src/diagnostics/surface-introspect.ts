// Pure read-only introspection of an agent's effective tool surface in a
// given room. Used by GET /api/agents/:name/surface to answer "what does
// this agent actually see when invoked in this room, and why."
//
// No side effects, no caching, no LLM call. Computes the same surface
// the eval would compute, plus per-tool pack attribution and a per-pack
// rollup. Lives in src/diagnostics/ so the tool-surface module stays a
// leaf (no diagnostic-shaped state seeping in).

import type { ToolDefinition, ToolRegistry } from '../core/types/tool.ts'
import type { System } from '../main.ts'
import { asAIAgent } from '../agents/shared.ts'
import { createToolSurface, inferProviderFromModelRef, type GetRoomActivation } from '../tool-surface/index.ts'
import { effectiveActivePackSet } from '../packs/activation.ts'
import { estimateTokens } from '../agents/context-builder.ts'
import { CURATED_MODELS } from '../llm/models/catalog.ts'

export interface ToolSurfaceTool {
  readonly name: string
  readonly pack: string                        // owning pack (core/local/<ns>)
  readonly tokens: number                      // estimated definition tokens
}

export interface PackRollup {
  readonly pack: string
  readonly tools: number
  readonly tokens: number
}

export interface AgentSurface {
  readonly agent: string
  readonly agentId: string
  readonly model: string
  readonly provider: string | null
  readonly roomId: string
  readonly roomName: string
  readonly activePacks: ReadonlyArray<string>
  readonly registeredCount: number
  readonly requestedCount: number
  readonly afterActivationCount: number
  readonly tools: ReadonlyArray<ToolSurfaceTool>
  readonly packs: ReadonlyArray<PackRollup>
  readonly totalTokens: number
}

const packForEntry = (registry: ToolRegistry, name: string): string => {
  const entry = registry.getEntry(name)
  if (!entry) return 'unknown'
  switch (entry.source.kind) {
    case 'built-in': return 'core'
    case 'external': return 'local'
    case 'pack-bundled': return entry.source.pack ?? 'local'
    case 'skill-bundled': return entry.source.pack ?? 'local'
  }
}

export const introspectAgentSurface = (
  system: System,
  agentName: string,
  roomId: string,
): AgentSurface | { error: string } => {
  const agent = system.team.getAgent(agentName)
  if (!agent) return { error: `agent "${agentName}" not found` }
  const ai = asAIAgent(agent)
  if (!ai) return { error: `agent "${agentName}" is not an AI agent` }

  const room = system.house.getRoom(roomId)
  if (!room) return { error: `room "${roomId}" not found` }

  const config = ai.getConfig()
  const model = ai.getModel()
  const provider = inferProviderFromModelRef(model, CURATED_MODELS) ?? null
  const activePacks = effectiveActivePackSet(room)

  const registry = system.toolRegistry
  const requestedTools = config.tools ?? registry.list().map(t => t.name)

  // Reuse the production surface — guarantees we report what the eval
  // would actually compute.
  const getRoomActivation: GetRoomActivation = (id) => system.house.getRoom(id)
  const surface = createToolSurface({ registry, requestedTools, getRoomActivation })
  const defs: ReadonlyArray<ToolDefinition> = surface.project(roomId, provider ?? undefined)

  const tools: ToolSurfaceTool[] = defs.map(d => ({
    name: d.function.name,
    pack: packForEntry(registry, d.function.name),
    tokens: estimateTokens(JSON.stringify(d)),
  }))

  const packBuckets = new Map<string, { tools: number; tokens: number }>()
  for (const t of tools) {
    const b = packBuckets.get(t.pack) ?? { tools: 0, tokens: 0 }
    b.tools += 1
    b.tokens += t.tokens
    packBuckets.set(t.pack, b)
  }
  const packs: PackRollup[] = [...packBuckets].map(([pack, b]) => ({ pack, ...b }))
    .sort((a, b) => b.tokens - a.tokens)

  // Diagnostic counts: how many tools survived each stage. afterActivation
  // is the candidate set BEFORE family compression (so users see the raw
  // pack-filtered count vs the final dispatcher-compressed count).
  const requestedSet = new Set(requestedTools)
  let afterActivation = 0
  for (const entry of registry.listEntries()) {
    const name = entry.tool.name
    if (!activePacks.has(packForEntry(registry, name))) continue
    // UNION with requestedTools (matches buildCandidates).
    afterActivation += 1
  }
  // Add any requestedTools that are registered but not in active-pack set
  // (shouldn't happen with narrowed defaults, but include for completeness).
  for (const name of requestedSet) {
    const entry = registry.getEntry(name)
    if (entry && !activePacks.has(packForEntry(registry, name))) afterActivation += 1
  }

  return {
    agent: agent.name,
    agentId: agent.id,
    model,
    provider,
    roomId: room.profile.id,
    roomName: room.profile.name,
    activePacks: [...activePacks].sort(),
    registeredCount: registry.list().length,
    requestedCount: requestedTools.length,
    afterActivationCount: afterActivation,
    tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
    packs,
    totalTokens: tools.reduce((s, t) => s + t.tokens, 0),
  }
}
