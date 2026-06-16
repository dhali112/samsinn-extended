// ============================================================================
// Routes for the Leitbild mirror binding on a Samsinn room.
//
// V1: read-only mirror — bind a room to a Leitbild Control Instance.
// Three endpoints:
//   PUT    /api/rooms/:name/leitbild-mirror   set/replace config + attach
//   DELETE /api/rooms/:name/leitbild-mirror   clear + detach
//   GET    /api/rooms/:name/leitbild-mirror   introspect current state
// ============================================================================

import { errorResponse, json, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import type { LeitbildMirrorConfig } from '../../core/types/room.ts'
import { createLeitbildClient } from '../../integrations/leitbild/client.ts'
import type { ControlInstanceSummary } from '../../integrations/leitbild/types.ts'

const parseMirrorConfig = (body: Record<string, unknown>): LeitbildMirrorConfig | { error: string } => {
  if (typeof body.baseUrl !== 'string' || body.baseUrl.trim() === '') return { error: 'baseUrl is required' }
  if (typeof body.instanceId !== 'string' || body.instanceId.trim() === '') return { error: 'instanceId is required' }
  const format = body.format ?? 'summary'
  if (format !== 'summary' && format !== 'full') return { error: 'format must be "summary" or "full"' }
  try { new URL(body.baseUrl) } catch { return { error: 'baseUrl must be a valid URL' } }
  return { baseUrl: body.baseUrl, instanceId: body.instanceId, format }
}

// Server-side proxy for creating Leitbild Control Instances from the
// Samsinn UI without hitting CORS. The Leitbild deployment doesn't
// publish CORS headers (manifest declares browserDirectAccess: false),
// so browser-origin fetches against leitbild.samsinn.app fail. The demo
// modal needs to spin up a fresh CI on demand; this route does it
// server-to-server (no CORS) and returns the new instance id.
//
// SSRF guard: the route is auth-gated (cookie required via http-routes.ts
// F5), but the baseUrl is user-controlled — without further restriction an
// authenticated client could probe arbitrary hosts including internal
// networks. We enforce TWO checks:
//   1. Host must appear in the allowlist (default: leitbild.samsinn.app;
//      override via SAMSINN_LEITBILD_HOSTS=host1.example.com,host2.example.com)
//   2. Host must NOT resolve to a private/loopback/link-local range
//      (denied unconditionally — separate from the host check because an
//      attacker could host a public DNS record pointing at 127.0.0.1)
const DEFAULT_LEITBILD_HOSTS = ['leitbild.samsinn.app']

const getAllowedLeitbildHosts = (): ReadonlySet<string> => {
  const raw = process.env.SAMSINN_LEITBILD_HOSTS
  if (!raw || raw.trim() === '') return new Set(DEFAULT_LEITBILD_HOSTS)
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
}

const isPrivateOrLoopbackHost = (host: string): boolean => {
  // Hostname-shaped tests first (don't fail on names).
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  // IPv4 dotted-quad: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
  // 169.254.0.0/16 (link-local), 100.64.0.0/10 (CGNAT).
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1]); const b = Number(ipv4[2])
    if (a === 127 || a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 0) return true
  }
  // IPv6 loopback / link-local / unique-local. Coarse.
  if (host === '::1' || host === '[::1]') return true
  if (host.startsWith('fe80:') || host.startsWith('[fe80:')) return true
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('[fc') || host.startsWith('[fd')) return true
  return false
}

const validateProxyBaseUrl = (raw: string): { ok: true; url: URL } | { ok: false; error: string } => {
  let url: URL
  try { url = new URL(raw) } catch { return { ok: false, error: 'baseUrl must be a valid URL' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'baseUrl protocol must be http or https' }
  }
  const allowed = getAllowedLeitbildHosts()
  if (!allowed.has(url.hostname)) {
    return { ok: false, error: `baseUrl host "${url.hostname}" is not in the Leitbild allowlist (configure via SAMSINN_LEITBILD_HOSTS)` }
  }
  if (isPrivateOrLoopbackHost(url.hostname)) {
    return { ok: false, error: 'baseUrl resolves to a private/loopback address' }
  }
  return { ok: true, url }
}

const parseStringArray = (raw: unknown): ReadonlyArray<string> =>
  Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map(v => v.trim()) : []

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const controlInstanceRecency = (instance: ControlInstanceSummary): number => {
  if (typeof instance.snapshotSeq === 'number') return instance.snapshotSeq
  if (typeof instance.seq === 'number') return instance.seq
  const updated = typeof instance.updatedAt === 'string' ? Date.parse(instance.updatedAt) : Number.NaN
  if (Number.isFinite(updated)) return updated
  const created = typeof instance.createdAt === 'string' ? Date.parse(instance.createdAt) : Number.NaN
  return Number.isFinite(created) ? created : 0
}

const sortControlInstances = (
  instances: ReadonlyArray<ControlInstanceSummary>,
  scenarioIds: ReadonlyArray<string>,
): ReadonlyArray<ControlInstanceSummary> => {
  const scenarioRank = new Map(scenarioIds.map((id, idx) => [id, idx]))
  return [...instances].sort((a, b) => {
    const aScenario = typeof a.scenarioId === 'string' ? scenarioRank.get(a.scenarioId) ?? scenarioIds.length : scenarioIds.length
    const bScenario = typeof b.scenarioId === 'string' ? scenarioRank.get(b.scenarioId) ?? scenarioIds.length : scenarioIds.length
    if (aScenario !== bScenario) return aScenario - bScenario
    const aLoaded = a.loaded === true ? 1 : 0
    const bLoaded = b.loaded === true ? 1 : 0
    if (aLoaded !== bLoaded) return bLoaded - aLoaded
    return controlInstanceRecency(b) - controlInstanceRecency(a)
  })
}

const getQueryKinds = (capabilities: Record<string, unknown>, packId: string): ReadonlyArray<string> => {
  const queryKinds = capabilities.queryKinds
  if (!isRecord(queryKinds)) return []
  const kinds = queryKinds[packId]
  return Array.isArray(kinds) ? kinds.filter((v): v is string => typeof v === 'string') : []
}

const queryKindMatches = (actual: string, required: string): boolean =>
  actual === required || actual.endsWith(`.${required}`) || required.endsWith(`.${actual}`)

const unwrapPackQueryResult = (raw: unknown): unknown => {
  if (!isRecord(raw)) return raw
  if (isRecord(raw.response)) return unwrapPackQueryResult(raw.response)
  if (isRecord(raw.result)) return raw.result
  return raw
}

const extractSystemIds = (raw: unknown): ReadonlyArray<string> => {
  const body = unwrapPackQueryResult(raw)
  const systemsRaw = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.systems)
      ? body.systems
      : []
  return systemsRaw
    .map((system): string | undefined => {
      if (typeof system === 'string') return system
      if (!isRecord(system)) return undefined
      if (typeof system.id === 'string') return system.id
      if (typeof system.systemId === 'string') return system.systemId
      return undefined
    })
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

interface ProcessPlantProbe {
  readonly ok: true
  readonly systemIds: ReadonlyArray<string>
}

interface ProcessPlantProbeFail {
  readonly ok: false
  readonly reason: string
}

const probeProcessPlantInstance = async (
  client: ReturnType<typeof createLeitbildClient>,
  instanceId: string,
  packId: string,
  queryKind: string,
  payload: Record<string, unknown>,
): Promise<ProcessPlantProbe | ProcessPlantProbeFail> => {
  const capabilities = await client.getCapabilities(instanceId)
  const activePacks = Array.isArray(capabilities.activePackIds)
    ? capabilities.activePackIds.filter((v): v is string => typeof v === 'string')
    : []
  if (!activePacks.includes(packId)) return { ok: false, reason: `missing active pack "${packId}"` }
  const kinds = getQueryKinds(capabilities, packId)
  if (!kinds.some(k => queryKindMatches(k, queryKind))) return { ok: false, reason: `missing query kind "${queryKind}"` }
  const result = await client.callPackQuery(instanceId, packId, queryKind, payload)
  const systemIds = extractSystemIds(result)
  if (systemIds.length === 0) return { ok: false, reason: 'systems.list returned no process systems' }
  return { ok: true, systemIds }
}

const proxyCreateControlInstance: RouteEntry = {
  method: 'POST',
  pattern: /^\/api\/leitbild-proxy\/control-instances$/,
  handler: async (req, _match, { instanceId: scope }) => {
    const body = await parseBody(req)
    if (typeof body.baseUrl !== 'string') return errorResponse('baseUrl is required', 400)
    if (typeof body.scenarioId !== 'string') return errorResponse('scenarioId is required', 400)
    const guarded = validateProxyBaseUrl(body.baseUrl)
    if (!guarded.ok) return errorResponse(guarded.error, 400)
    try {
      const client = createLeitbildClient(guarded.url.toString(), { scope })
      const data = await client.createControlInstance(body.scenarioId)
      return json({ id: data.id })
    } catch (err) {
      return errorResponse(`Could not reach Leitbild: ${(err as Error).message}`, 502)
    }
  },
}

const proxySelectControlInstance: RouteEntry = {
  method: 'POST',
  pattern: /^\/api\/leitbild-proxy\/control-instances\/select$/,
  handler: async (req, _match, { instanceId: scope }) => {
    const body = await parseBody(req)
    if (typeof body.baseUrl !== 'string') return errorResponse('baseUrl is required', 400)
    const guarded = validateProxyBaseUrl(body.baseUrl)
    if (!guarded.ok) return errorResponse(guarded.error, 400)

    const preferredScenarioId = typeof body.preferredScenarioId === 'string' && body.preferredScenarioId.trim() !== ''
      ? body.preferredScenarioId.trim()
      : 'halden-process-plant-demo'
    const candidateScenarioIds = [
      preferredScenarioId,
      ...parseStringArray(body.candidateScenarioIds).filter(id => id !== preferredScenarioId),
    ]
    const requiredPackId = typeof body.requiredPackId === 'string' && body.requiredPackId.trim() !== ''
      ? body.requiredPackId.trim()
      : 'process-plant'
    const requiredQueryKind = typeof body.requiredQueryKind === 'string' && body.requiredQueryKind.trim() !== ''
      ? body.requiredQueryKind.trim()
      : 'process-plant.systems.list'
    const probePayload = isRecord(body.probePayload) ? body.probePayload : {}
    const client = createLeitbildClient(guarded.url.toString(), { scope })
    const failures: string[] = []

    try {
      const allInstances = await client.listControlInstances()
      const candidates = sortControlInstances(
        allInstances.filter(i => typeof i.id === 'string' && candidateScenarioIds.includes(i.scenarioId ?? '')),
        candidateScenarioIds,
      )
      for (const candidate of candidates) {
        try {
          const probe = await probeProcessPlantInstance(client, candidate.id, requiredPackId, requiredQueryKind, probePayload)
          if (probe.ok) {
            return json({
              id: candidate.id,
              instanceId: candidate.id,
              scenarioId: candidate.scenarioId,
              created: false,
              reused: true,
              systemIds: probe.systemIds,
            })
          }
          failures.push(`${candidate.id}: ${probe.reason}`)
        } catch (err) {
          failures.push(`${candidate.id}: ${(err as Error).message}`)
        }
      }

      const created = await client.createControlInstance(preferredScenarioId)
      const probe = await probeProcessPlantInstance(client, created.id, requiredPackId, requiredQueryKind, probePayload)
      if (!probe.ok) {
        failures.push(`${created.id}: ${probe.reason}`)
        return errorResponse(`Created Leitbild instance but it is not ${requiredPackId}-ready: ${probe.reason}`, 502)
      }
      return json({
        id: created.id,
        instanceId: created.id,
        scenarioId: preferredScenarioId,
        created: true,
        reused: false,
        systemIds: probe.systemIds,
        ...(failures.length > 0 ? { skippedCandidates: failures } : {}),
      })
    } catch (err) {
      const skipped = failures.length > 0 ? `; skipped candidates: ${failures.join('; ')}` : ''
      return errorResponse(`Could not select Leitbild control instance: ${(err as Error).message}${skipped}`, 502)
    }
  },
}

export const leitbildMirrorRoutes: RouteEntry[] = [
  proxyCreateControlInstance,
  proxySelectControlInstance,
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: async (_req, match, { system, leitbildMirror, instanceId }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      // Lazy self-heal: if room has persisted config but service has no
      // record (Samsinn was restarted), reattach silently. Idempotent —
      // attach() detaches any prior mirror first.
      const persisted = room.getLeitbildMirror()
      const status = leitbildMirror?.statusFor(room)
      if (persisted && leitbildMirror && (!status || !status.connected)) {
        try { await leitbildMirror.attach(room, persisted, instanceId) } catch {
          // attach() catches its own error and posts a formatMirrorError chat
          // message into the room — the user sees the failure inline. We
          // don't re-throw because this is a lazy self-heal; the GET still
          // returns the current status with connected:false. If attach()
          // ever throws BEFORE its own room.post (e.g. snapshot fetch throws
          // synchronously), the user gets no signal — flagged in audit
          // Finding 2.2.4 for a follow-up that surfaces lastAttachError.
        }
      }
      return json({ status: leitbildMirror?.statusFor(room) ?? null })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: async (req, match, { system, leitbildMirror, instanceId }) => {
      if (!leitbildMirror) return errorResponse('Leitbild integration not initialized', 503)
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const parsed = parseMirrorConfig(body)
      if ('error' in parsed) return errorResponse(parsed.error, 400)
      try {
        // Pass instanceId as scope so this tenant's LeitbildClient pool
        // is isolated from other tenants binding to the same baseUrl.
        await leitbildMirror.attach(room, parsed, instanceId)
        return json({ status: leitbildMirror.statusFor(room) ?? null }, 200)
      } catch (err) {
        return errorResponse(`attach failed: ${(err as Error).message}`, 502)
      }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: (_req, match, { system, leitbildMirror }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      leitbildMirror?.detach(room)
      return json({ status: null })
    },
  },
]
