import { afterEach, describe, expect, test } from 'bun:test'
import { leitbildMirrorRoutes } from './leitbild-mirror.ts'
import { __injectClient, __resetClientPool, type LeitbildClient } from '../../integrations/leitbild/client.ts'
import type { ControlInstanceSummary, LeitbildEventHandler, SubscriptionHandle } from '../../integrations/leitbild/types.ts'

const BASE_URL = 'https://leitbild.samsinn.app'
const SCOPE = 'tenant-test'

interface FakeClientOptions {
  readonly instances: ReadonlyArray<ControlInstanceSummary>
  readonly capabilitiesByInstance: Readonly<Record<string, Record<string, unknown>>>
  readonly queryByInstance: Readonly<Record<string, unknown>>
  readonly createdId?: string
}

interface FakeClientState {
  readonly client: LeitbildClient
  readonly createdScenarioIds: string[]
}

const mkClient = (options: FakeClientOptions): FakeClientState => {
  const createdScenarioIds: string[] = []
  const createdId = options.createdId ?? 'created-pwr'
  const missing = (kind: string, id: string): never => {
    throw new Error(`no ${kind} for ${id}`)
  }
  const client: LeitbildClient = {
    baseUrl: BASE_URL,
    getManifest: async () => ({
      manifestSchemaVersion: '1.0.0',
      identity: { implementation: 'test', implementationVersion: '1', title: 'Test', operator: 'Test', deploymentId: 'test' },
      links: {},
      realtime: { model: 'test' },
    }),
    listControlInstances: async () => options.instances,
    createControlInstance: async (scenarioId: string) => {
      createdScenarioIds.push(scenarioId)
      return { id: createdId }
    },
    getSnapshot: async () => ({ seq: 0 }),
    getScenario: async () => undefined,
    getEvents: async () => [],
    callPackQuery: async (instanceId: string) =>
      options.queryByInstance[instanceId] ?? missing('query result', instanceId),
    callCommand: async () => ({}),
    getCapabilities: async (instanceId: string) =>
      options.capabilitiesByInstance[instanceId] ?? missing('capabilities', instanceId),
    subscribe: (_instanceId: string, _handler: LeitbildEventHandler, _startSeq: number): SubscriptionHandle => ({
      close: () => {},
      lastSeq: () => 0,
    }),
  }
  return { client, createdScenarioIds }
}

const invokeSelect = async (body: Record<string, unknown>, client: LeitbildClient): Promise<Response> => {
  __injectClient(BASE_URL, client, SCOPE)
  const path = '/api/leitbild-proxy/control-instances/select'
  const route = leitbildMirrorRoutes.find(r => r.method === 'POST' && r.pattern.test(path))
  if (!route) throw new Error('select route not found')
  const match = path.match(route.pattern)
  if (!match) throw new Error('select route did not match')
  return route.handler(
    new Request(`http://samsinn.test${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    match,
    { instanceId: SCOPE } as never,
  ) as Promise<Response>
}

const processPlantCapabilities = (): Record<string, unknown> => ({
  activePackIds: ['process-plant'],
  queryKinds: { 'process-plant': ['process-plant.systems.list', 'process-plant.transient.diagnostics'] },
})

const selectBody = (): Record<string, unknown> => ({
  baseUrl: BASE_URL,
  preferredScenarioId: 'halden-process-plant-demo',
  candidateScenarioIds: ['halden-process-plant-demo', 'oslo-all-packs-demo'],
  requiredPackId: 'process-plant',
  requiredQueryKind: 'process-plant.systems.list',
  probePayload: {},
})

afterEach(() => { __resetClientPool() })

describe('Leitbild proxy control-instance selection', () => {
  test('reuses a readable process-plant instance', async () => {
    const fake = mkClient({
      instances: [
        { id: 'older', scenarioId: 'halden-process-plant-demo', loaded: true, snapshotSeq: 2 },
        { id: 'fresh', scenarioId: 'halden-process-plant-demo', loaded: true, snapshotSeq: 10 },
      ],
      capabilitiesByInstance: {
        older: processPlantCapabilities(),
        fresh: processPlantCapabilities(),
      },
      queryByInstance: {
        older: { systems: [{ id: 'old-plant' }] },
        fresh: { response: { ok: true, result: { systems: [{ id: 'fresh-plant' }] } } },
      },
    })

    const res = await invokeSelect(selectBody(), fake.client)
    const data = await res.json() as { instanceId?: string; created?: boolean; systemIds?: ReadonlyArray<string> }

    expect(res.status).toBe(200)
    expect(data.instanceId).toBe('fresh')
    expect(data.created).toBe(false)
    expect(data.systemIds).toEqual(['fresh-plant'])
    expect(fake.createdScenarioIds).toEqual([])
  })

  test('creates a preferred scenario when existing candidates fail the process-plant probe', async () => {
    const fake = mkClient({
      instances: [
        { id: 'bad', scenarioId: 'halden-process-plant-demo', loaded: true, snapshotSeq: 20 },
      ],
      capabilitiesByInstance: {
        bad: { activePackIds: ['weather'], queryKinds: { weather: ['weather.fieldStats'] } },
        'created-pwr': processPlantCapabilities(),
      },
      queryByInstance: {
        'created-pwr': { systems: [{ id: 'new-plant' }] },
      },
      createdId: 'created-pwr',
    })

    const res = await invokeSelect(selectBody(), fake.client)
    const data = await res.json() as { instanceId?: string; created?: boolean; systemIds?: ReadonlyArray<string>; skippedCandidates?: ReadonlyArray<string> }

    expect(res.status).toBe(200)
    expect(data.instanceId).toBe('created-pwr')
    expect(data.created).toBe(true)
    expect(data.systemIds).toEqual(['new-plant'])
    expect(data.skippedCandidates?.[0]).toContain('missing active pack')
    expect(fake.createdScenarioIds).toEqual(['halden-process-plant-demo'])
  })

  test('rejects base URLs outside the Leitbild allowlist', async () => {
    const fake = mkClient({
      instances: [],
      capabilitiesByInstance: {},
      queryByInstance: {},
    })

    const res = await invokeSelect({ ...selectBody(), baseUrl: 'https://example.com' }, fake.client)
    const data = await res.json() as { error?: string }

    expect(res.status).toBe(400)
    expect(data.error).toContain('not in the Leitbild allowlist')
  })
})
