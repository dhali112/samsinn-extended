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

// 5s = max time we expect between a sequence of lb_* calls in one agent turn
// (lb_state → lb_object → lb_query). Cache returns the same snapshot to all
// of them; next turn re-fetches. Tune up if turns get longer; tune down if
// scenarios show event-volume issues where snapshot freshness matters.
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

// Evict all cached snapshots for one agent. Called when the agent is
// removed from the system so per-(agent,instance) entries don't leak
// forever in a long-running process. Cheap O(n) walk; n is bounded by
// distinct (agent × leitbild-instance) pairs ever queried.
export const clearLeitbildToolCacheForAgent = (agentId: string): void => {
  const prefix = `${agentId}:`
  for (const key of snapshotCache.keys()) {
    if (key.startsWith(prefix)) snapshotCache.delete(key)
  }
}

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

// === lb_dispatch_context (V2.A composite) ===
//
// One-shot read tool that bundles everything an agent typically needs to
// reason about a dispatch decision: scenario meta, current snapshot, and
// every pack-query advertised in the per-CI capabilities manifest, called
// in parallel with empty payloads. Queries that require a non-empty payload
// surface as { ok: false, reason } in their slot — agents see the gap and
// can follow up with a targeted lb_query call.

interface CapabilitiesResponse {
  readonly scenarioId?: string
  readonly activePackIds?: ReadonlyArray<string>
  readonly queryKinds?: Readonly<Record<string, ReadonlyArray<string>>>
  readonly wikiRefs?: ReadonlyArray<{ readonly name: string; readonly url: string }>
}

const createLbDispatchContext = (deps: LeitbildToolDeps): Tool => ({
  name: 'lb_dispatch_context',
  description: 'Single composite read that bundles current snapshot summary, scenario metadata, capabilities (active packs + accepted command kinds + wikiRefs), and every pack-query advertised by the per-CI capabilities manifest (called in parallel with empty payload). Use this as the first call when you need a broad picture before reasoning. Queries that require payloads will show as failed slots — call lb_query directly with the right payload to fill them.',
  returns: 'JSON: { state, scenario, capabilities, queries: { <packId>: { <kind>: { ok, result|reason } } } }',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async (_params, ctx) => {
    const binding = requireBinding(deps, ctx)
    if ('error' in binding) return fail(binding.error)
    try {
      const client = createLeitbildClient(binding.baseUrl)
      // Fetch state, scenario, and capabilities in parallel.
      const manifest = await client.getManifest()
      const capsLinkTemplate = manifest.links['controlInstanceCapabilities']?.hrefTemplate
      if (!capsLinkTemplate) return fail('Manifest missing controlInstanceCapabilities link rel (older Leitbild deployment?).')
      const queriesLinkTemplate = manifest.links['controlInstancePackQueries']?.hrefTemplate
      if (!queriesLinkTemplate) return fail('Manifest missing controlInstancePackQueries link rel.')

      const capsUrl = capsLinkTemplate.replace('{id}', encodeURIComponent(binding.instanceId))
      const [snapshot, scenarioFetched, capsRes] = await Promise.all([
        getCachedSnapshot(ctx.callerId, binding),
        (async () => {
          const snap = await getCachedSnapshot(ctx.callerId, binding)
          if (!snap.scenarioId) return undefined
          return client.getScenario(snap.scenarioId)
        })(),
        fetch(capsUrl, { headers: { Accept: 'application/json', 'Leitbild-Client': 'samsinn; version="0.1.0"' } }),
      ])
      if (!capsRes.ok) return fail(`Capabilities fetch failed: HTTP ${capsRes.status}`)
      const capabilities = await capsRes.json() as CapabilitiesResponse

      // Walk queryKinds, call each in parallel with empty payload.
      const queriesUrl = queriesLinkTemplate.replace('{id}', encodeURIComponent(binding.instanceId))
      const queryKindsMap = capabilities.queryKinds ?? {}
      const allKinds: Array<{ packId: string; kind: string }> = []
      for (const [packId, kinds] of Object.entries(queryKindsMap)) {
        for (const kind of kinds) allKinds.push({ packId, kind })
      }
      // Soft cap to keep tool output bounded even if a deployment publishes many kinds.
      const CAP = 50
      const truncated = allKinds.length > CAP
      const kindsToCall = truncated ? allKinds.slice(0, CAP) : allKinds

      const queryResults = await Promise.all(
        kindsToCall.map(async ({ packId, kind }) => {
          try {
            const res = await fetch(queriesUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Leitbild-Client': 'samsinn; version="0.1.0"' },
              body: JSON.stringify({ packId, kind, payload: {} }),
            })
            if (!res.ok) return { packId, kind, ok: false as const, reason: `HTTP ${res.status}` }
            const body = await res.json() as { response?: { ok?: boolean; result?: unknown; error?: { message?: string } } }
            if (body.response?.ok === false) return { packId, kind, ok: false as const, reason: body.response.error?.message ?? 'pack rejected' }
            return { packId, kind, ok: true as const, result: body.response?.result ?? body }
          } catch (err) {
            return { packId, kind, ok: false as const, reason: (err as Error).message }
          }
        }),
      )

      // Group by packId for readability.
      const queriesByPack: Record<string, Record<string, unknown>> = {}
      for (const r of queryResults) {
        queriesByPack[r.packId] = queriesByPack[r.packId] ?? {}
        queriesByPack[r.packId]![r.kind] = r.ok ? { ok: true, result: r.result } : { ok: false, reason: r.reason }
      }

      const objects = (snapshot.objects as ReadonlyArray<{ domain?: string }> | undefined) ?? []
      const objectsByDomain: Record<string, number> = {}
      for (const o of objects) {
        const d = o?.domain ?? 'unknown'
        objectsByDomain[d] = (objectsByDomain[d] ?? 0) + 1
      }

      return ok({
        state: {
          scenarioId: snapshot.scenarioId,
          clock: snapshot.clock,
          objectCount: objects.length,
          objectsByDomain,
          seq: snapshot.seq,
        },
        scenario: scenarioFetched ?? null,
        capabilities: {
          activePackIds: capabilities.activePackIds ?? [],
          wikiRefs: capabilities.wikiRefs ?? [],
        },
        queries: queriesByPack,
        ...(truncated ? { truncated: true, capacity: CAP, totalAdvertised: allKinds.length } : {}),
      })
    } catch (err) {
      return fail(`lb_dispatch_context failed: ${(err as Error).message}`)
    }
  },
})

// === Factory ===

export const createLeitbildTools = (deps: LeitbildToolDeps): ReadonlyArray<Tool> => [
  createLbState(deps),
  createLbObject(deps),
  createLbQuery(deps),
  createLbScenario(deps),
  createLbDispatchContext(deps),
]
