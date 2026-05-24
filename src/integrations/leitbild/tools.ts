// ============================================================================
// Leitbild agent tools (V2.A — read-only).
//
// Four tools become callable by an AI agent that has BOTH:
//   - a leitbildBinding in its AIAgentConfig (sets baseUrl + instanceId)
//   - the tool name in its tools[] allowlist
//
// All tools resolve the binding at execution time via the caller's agent
// config, then walk the deployment's discovery manifest via the shared
// LeitbildClient pool. No hardcoded paths.
//
// Per-agent snapshot cache (TTL ~5s) so multiple lb_state / lb_object /
// lb_scenario calls in a single agent turn don't all roundtrip.
//
// Commands (lb_command) live in command-tools.ts (V2.B). This file is
// strictly the read surface.
// ============================================================================

import type { Tool, ToolContext, ToolResult } from '../../core/types/tool.ts'
import type { LeitbildAgentBinding } from '../../core/types/agent.ts'
import type { ControlInstanceSnapshot } from './types.ts'
import { createLeitbildClient } from './client.ts'

// === Deps wiring (allows tests to inject without spinning up the System) ===

export interface LeitbildToolDeps {
  // Look up an agent's Leitbild binding by callerId. Returns undefined
  // when the caller has no binding (tool returns a helpful error then).
  readonly getBinding: (agentId: string) => LeitbildAgentBinding | undefined
}

// === Per-agent snapshot cache ===

interface CachedSnapshot {
  readonly snapshot: ControlInstanceSnapshot
  readonly fetchedAt: number
}

const SNAPSHOT_TTL_MS = 5_000

const snapshotCache = new Map<string, CachedSnapshot>() // key: `${agentId}:${baseUrl}:${instanceId}`

const cacheKey = (agentId: string, binding: LeitbildAgentBinding): string =>
  `${agentId}:${binding.baseUrl}:${binding.instanceId}`

const getCachedSnapshot = async (
  agentId: string,
  binding: LeitbildAgentBinding,
): Promise<ControlInstanceSnapshot> => {
  const key = cacheKey(agentId, binding)
  const now = Date.now()
  const cached = snapshotCache.get(key)
  if (cached && now - cached.fetchedAt < SNAPSHOT_TTL_MS) return cached.snapshot
  const client = createLeitbildClient(binding.baseUrl)
  const snapshot = await client.getSnapshot(binding.instanceId)
  snapshotCache.set(key, { snapshot, fetchedAt: now })
  return snapshot
}

export const __clearLeitbildToolCache = (): void => { snapshotCache.clear() }

// === Common helpers ===

const requireBinding = (
  deps: LeitbildToolDeps,
  ctx: ToolContext,
): LeitbildAgentBinding | { error: string } => {
  const binding = deps.getBinding(ctx.callerId)
  if (!binding) {
    return {
      error: 'No leitbildBinding configured for this agent. Add { baseUrl, instanceId, role } to the agent config to use lb_* tools.',
    }
  }
  return binding
}

const fail = (error: string): ToolResult => ({ success: false, error })
const ok = (data: unknown): ToolResult => ({ success: true, data })

// === Tools ===

const createLbState = (deps: LeitbildToolDeps): Tool => ({
  name: 'lb_state',
  description: 'Read the current Leitbild Control Instance snapshot for the bound deployment. Returns clock, object count, scenario id, and a summarized object inventory by domain. Use when you need fresh authoritative state before reasoning or acting.',
  returns: 'JSON: { scenarioId, clock, objectCount, objectsByDomain }',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async (_params, ctx) => {
    const binding = requireBinding(deps, ctx)
    if ('error' in binding) return fail(binding.error)
    try {
      const snap = await getCachedSnapshot(ctx.callerId, binding)
      const objects = (snap.objects as ReadonlyArray<{ domain?: string }> | undefined) ?? []
      const objectsByDomain: Record<string, number> = {}
      for (const o of objects) {
        const d = o?.domain ?? 'unknown'
        objectsByDomain[d] = (objectsByDomain[d] ?? 0) + 1
      }
      return ok({
        scenarioId: snap.scenarioId,
        clock: snap.clock,
        objectCount: objects.length,
        objectsByDomain,
        seq: snap.seq,
      })
    } catch (err) {
      return fail(`lb_state failed: ${(err as Error).message}`)
    }
  },
})

const createLbObject = (deps: LeitbildToolDeps): Tool => ({
  name: 'lb_object',
  description: 'Read one specific operational object from the bound Leitbild Control Instance by id. Returns the full domain payload (label, status, position, domain-specific fields). Use after lb_state when you need details on a particular object.',
  returns: 'JSON: the operational object record, or { error } if not found',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Object id, e.g. "amb-3" or "incident-7"' },
    },
    required: ['id'],
    additionalProperties: false,
  },
  execute: async (params, ctx) => {
    const binding = requireBinding(deps, ctx)
    if ('error' in binding) return fail(binding.error)
    const id = String(params.id ?? '').trim()
    if (!id) return fail('lb_object requires non-empty id')
    try {
      const snap = await getCachedSnapshot(ctx.callerId, binding)
      const objects = (snap.objects as ReadonlyArray<{ id?: string }> | undefined) ?? []
      const found = objects.find(o => o?.id === id)
      if (!found) return fail(`Object "${id}" not found in current snapshot.`)
      return ok(found)
    } catch (err) {
      return fail(`lb_object failed: ${(err as Error).message}`)
    }
  },
})

const createLbQuery = (deps: LeitbildToolDeps): Tool => ({
  name: 'lb_query',
  description: 'Call a Leitbild pack-specific read query (e.g. ambulance.dispatchState, weather.summarizeArea). Use lb_capabilities-style discovery via the manifest to see what packs and query kinds are available. Returns the pack-defined result shape.',
  returns: 'JSON: the pack-defined query result',
  parameters: {
    type: 'object',
    properties: {
      packId: { type: 'string', description: 'Pack namespace, e.g. "ambulance"' },
      kind: { type: 'string', description: 'Query kind, e.g. "ambulance.dispatchState"' },
      payload: { type: 'object', description: 'Query payload (pack-specific; pass {} when none).' },
    },
    required: ['packId', 'kind'],
    additionalProperties: false,
  },
  execute: async (params, ctx) => {
    const binding = requireBinding(deps, ctx)
    if ('error' in binding) return fail(binding.error)
    const packId = String(params.packId ?? '').trim()
    const kind = String(params.kind ?? '').trim()
    const payload = (params.payload as Record<string, unknown> | undefined) ?? {}
    if (!packId || !kind) return fail('lb_query requires packId and kind')
    try {
      const client = createLeitbildClient(binding.baseUrl)
      const manifest = await client.getManifest()
      const linkTemplate = manifest.links['controlInstancePackQueries']?.hrefTemplate
      if (!linkTemplate) return fail('Manifest missing controlInstancePackQueries link rel.')
      const url = linkTemplate.replace('{id}', encodeURIComponent(binding.instanceId))
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Leitbild-Client': 'samsinn; version="0.1.0"' },
        body: JSON.stringify({ packId, kind, payload }),
      })
      if (!res.ok) return fail(`lb_query HTTP ${res.status}`)
      const body = await res.json()
      return ok(body)
    } catch (err) {
      return fail(`lb_query failed: ${(err as Error).message}`)
    }
  },
})

const createLbScenario = (deps: LeitbildToolDeps): Tool => ({
  name: 'lb_scenario',
  description: 'Read the active scenario metadata for the bound Leitbild Control Instance (title, description, scripted phases). Use once at start of reasoning to ground yourself in the scenario.',
  returns: 'JSON: { id, title, description, ... } or { error } if no scenario',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async (_params, ctx) => {
    const binding = requireBinding(deps, ctx)
    if ('error' in binding) return fail(binding.error)
    try {
      const client = createLeitbildClient(binding.baseUrl)
      const snap = await getCachedSnapshot(ctx.callerId, binding)
      if (!snap.scenarioId) return fail('Snapshot has no scenarioId.')
      const scenario = await client.getScenario(snap.scenarioId)
      if (!scenario) return fail(`Scenario "${snap.scenarioId}" not found in catalog.`)
      return ok(scenario)
    } catch (err) {
      return fail(`lb_scenario failed: ${(err as Error).message}`)
    }
  },
})

// === Factory ===

export const createLeitbildTools = (deps: LeitbildToolDeps): ReadonlyArray<Tool> => [
  createLbState(deps),
  createLbObject(deps),
  createLbQuery(deps),
  createLbScenario(deps),
]
