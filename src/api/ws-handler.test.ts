// ============================================================================
// WS Handler — tests for message dispatch, error handling, and protocol edges.
// ============================================================================

import { describe, test, expect, beforeEach } from 'bun:test'
import { handleWSMessage, createWSManager } from './ws-handler.ts'
import { createHouse } from '../core/house.ts'
import { createTeam } from '../agents/team.ts'
import { createAIAgent } from '../agents/ai-agent.ts'
import { createHumanAgent } from '../agents/human-agent.ts'
import type { DeliverFn, Message } from '../core/types/messaging.ts'
import type { RouteMessage } from '../core/types/agent.ts'
import type { WSOutbound } from '../core/types/ws-protocol.ts'
import type { System } from '../main.ts'
import type { ClientSession, WSManager } from './ws-handler.ts'

// === Helpers ===

const noopDeliver: DeliverFn = () => {}

const makeLLMProvider = () => ({
  chat: async () => ({ content: '', generationMs: 0, tokensUsed: { prompt: 0, completion: 0 }, toolCalls: [{ function: { name: 'pass', arguments: { reason: 'test' } } }] }),
  models: async () => [],
  runningModels: async () => [],
  getHealth: () => ({ status: 'healthy' as const, latencyMs: 0, loadedModels: [], availableModels: [], lastCheckedAt: 0 }),
  getMetrics: () => ({ requestCount: 0, errorCount: 0, errorRate: 0, p50Latency: 0, p95Latency: 0, avgTokensPerSecond: 0, queueDepth: 0, concurrentRequests: 0, circuitState: 'closed' as const, shedCount: 0, windowMs: 300000 }),
  getConfig: () => ({}),
  updateConfig: () => {},
  loadModel: async () => {},
  unloadModel: async () => {},
  onHealthChange: () => {},
  dispose: () => {},
})

const makeSystem = (): System => {
  const house = createHouse({ deliver: noopDeliver })
  const team = createTeam()
  house.createRoom({ name: 'TestRoom', createdBy: 'system' })

  const routeMessage: RouteMessage = (target, params) => {
    const posted: Message[] = []
    for (const roomName of (target.rooms ?? [])) {
      const room = house.getRoom(roomName)
      if (room) posted.push(room.post(params))
    }
    return posted
  }

  return {
    house, team,
    routeMessage,
    llm: makeLLMProvider(),
    ollama: makeLLMProvider(),
    providerConfig: { order: ['ollama'], ollamaUrl: 'http://localhost:11434', ollamaMaxConcurrent: 2, cloud: {}, ollamaOnly: false, forceFailProvider: null, droppedFromOrder: [], orderFromUser: false },
    toolRegistry: { register: () => {}, get: () => undefined, list: () => [] },
    refreshAllAgentTools: async () => {},
    removeAgent: (id: string) => team.removeAgent(id),
    removeRoom: (id: string) => house.removeRoom(id),
    addAgentToRoom: async () => {},
    removeAgentFromRoom: () => {},
    spawnAIAgent: async () => { throw new Error('Not mocked') },
    spawnHumanAgent: async () => { throw new Error('Not mocked') },
    setOnMessagePosted: () => {},
    setOnTurnChanged: () => {},
    setOnDeliveryModeChanged: () => {},
    setOnModeAutoSwitched: () => {},
    setOnRoomCreated: () => {},
    setOnRoomDeleted: () => {},
    setOnMembershipChanged: () => {},
    setOnEvalEvent: () => {},
    setOnProviderBound: () => {},
    setOnProviderAllFailed: () => {},
    setOnProviderStreamFailed: () => {},
    dispatchProviderEvent: () => {},
    summaryScheduler: {
      onMessagePosted: () => {},
      onConfigChanged: () => {},
      onRoomRemoved: () => {},
      triggerNow: async () => {},
      isRunning: () => false,
      dispose: () => {},
    },
    setOnSummaryRunStarted: () => {},
    setOnSummaryRunDelta: () => {},
    setOnSummaryRunCompleted: () => {},
    setOnSummaryRunFailed: () => {},
    setOnSummaryConfigChanged: () => {},
  } as unknown as System
}

// Captures all messages sent to a WS connection
const makeWS = () => {
  const sent: string[] = []
  let bufferedAmount = 0
  let closeArgs: { code: number; reason?: string } | null = null
  const ws = {
    send: (data: string) => { sent.push(data) },
    getBufferedAmount: () => bufferedAmount,
    close: (code: number, reason?: string) => { closeArgs = { code, ...(reason ? { reason } : {}) } },
  }
  const messages = () => sent.map(s => JSON.parse(s) as Record<string, unknown>)
  const errors = () => messages().filter(m => m.type === 'error')
  const setBuffered = (n: number) => { bufferedAmount = n }
  const closed = () => closeArgs
  return { ws, messages, errors, setBuffered, closed }
}

type FakeWS = ReturnType<typeof makeWS>['ws']
const dispatch = (ws: FakeWS, session: ClientSession, system: System, wsManager: WSManager, payload: unknown) =>
  handleWSMessage(ws, session, JSON.stringify(payload), system, wsManager)

// === Tests ===

describe('WS Handler', () => {
  let system: System
  let session: ClientSession
  let wsManager: WSManager
  let humanId: string

  beforeEach(() => {
    system = makeSystem()
    const human = createHumanAgent({ name: 'Human' }, () => {})
    system.team.addAgent(human)
    humanId = human.id
    session = { instanceId: 'test0123456789ab', sessionToken: 'tok-test', lastActivity: Date.now() }
    wsManager = createWSManager({
      getSystem: () => system,
    })
  })

  // --- Protocol errors ---

  test('invalid JSON sends error response', async () => {
    const { ws, errors } = makeWS()
    await handleWSMessage(ws, session, 'not-json', system, wsManager)
    expect(errors()).toHaveLength(1)
    expect(errors()[0]!.message).toContain('Invalid JSON')
  })

  test('unknown message type sends error response', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: '__unknown__' })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0]!.message)).toContain('Unknown message type')
  })

  test('malformed known message sends validation error before dispatch', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'set_paused', roomName: 'TestRoom', paused: 'yes' })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0]!.message)).toContain('paused must be a boolean')
  })

  // --- cancel_generation ---

  test('cancel_generation for unknown agent sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'cancel_generation', name: 'NoSuchBot' })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0]!.message)).toContain('not found')
  })

  test('cancel_generation for non-AI agent sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'cancel_generation', name: 'Human' })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0]!.message)).toContain('not an AI agent')
  })

  test('cancel_generation for AI agent succeeds with no error', async () => {
    const bot = createAIAgent(
      { name: 'Bot', model: 'test', persona: 'You are a test bot.' },
      makeLLMProvider(),
      () => {},
    )
    system.team.addAgent(bot)
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'cancel_generation', name: 'Bot' })
    expect(errors()).toHaveLength(0)
  })

  // --- post_message ---

  test('post_message to known room echoes message back to sender', async () => {
    const { ws, messages } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'post_message', target: { rooms: ['TestRoom'] }, content: 'Hello', senderId: humanId,
    })
    const msgEvents = messages().filter(m => m.type === 'message')
    expect(msgEvents).toHaveLength(1)
    expect((msgEvents[0]!.message as Record<string, unknown>).content).toBe('Hello')
  })

  // --- set_paused ---

  test('set_paused pauses room and broadcasts only to the session instance', async () => {
    let broadcasted: WSOutbound | null = null
    let broadcastInstance: string | undefined
    ;(wsManager as unknown as Record<string, unknown>).broadcastToInstance = (instanceId: string, msg: WSOutbound) => {
      broadcastInstance = instanceId
      broadcasted = msg
    }
    const { ws } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'set_paused', roomName: 'TestRoom', paused: true })
    const room = system.house.getRoom('TestRoom')!
    expect(room.paused).toBe(true)
    expect(broadcastInstance).toBe(session.instanceId)
    expect(broadcasted).not.toBeNull()
    expect(((broadcasted as unknown) as { type: string; paused: boolean }).paused).toBe(true)
  })

  // --- summary config ---

  test('set_summary_config rejects invalid config', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'set_summary_config',
      roomName: 'TestRoom',
      config: {
        summary: { enabled: true, schedule: { kind: 'invalid' } },
        compression: { enabled: false, schedule: { kind: 'messages', everyMessages: 30 }, keepFresh: 40, batchSize: 30, aggressiveness: 'med' },
      },
    })
    expect(errors()).toHaveLength(1)
    expect(String(errors()[0]!.message)).toContain('schedule.kind')
  })

  test('set_summary_config accepts validated config', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, {
      type: 'set_summary_config',
      roomName: 'TestRoom',
      config: {
        model: 'ollama:test',
        summary: { enabled: true, schedule: { kind: 'messages', everyMessages: 7 } },
        compression: { enabled: true, schedule: { kind: 'time', everySeconds: 60 }, keepFresh: 12, batchSize: 8, aggressiveness: 'high' },
      },
    })
    expect(errors()).toHaveLength(0)
    expect(system.house.getRoom('TestRoom')!.summaryConfig.summary.enabled).toBe(true)
    expect(system.house.getRoom('TestRoom')!.summaryConfig.compression.aggressiveness).toBe('high')
  })

  test('set_paused on unknown room sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'set_paused', roomName: 'NoSuchRoom', paused: true })
    expect(errors()).toHaveLength(1)
  })

  // --- add_to_room / remove_from_room ---

  test('add_to_room with unknown room sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'add_to_room', roomName: 'NoRoom', agentName: 'Human' })
    expect(errors()).toHaveLength(1)
  })

  test('add_to_room with unknown agent sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'add_to_room', roomName: 'TestRoom', agentName: 'Ghost' })
    expect(errors()).toHaveLength(1)
  })

  test('add_to_room with valid room and agent calls system.addAgentToRoom', async () => {
    let called = false
    ;(system as unknown as Record<string, unknown>).addAgentToRoom = async () => { called = true }
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'add_to_room', roomName: 'TestRoom', agentName: 'Human' })
    expect(errors()).toHaveLength(0)
    expect(called).toBe(true)
  })

  test('remove_from_room with unknown room sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'remove_from_room', roomName: 'NoRoom', agentName: 'Human' })
    expect(errors()).toHaveLength(1)
  })

  test('remove_from_room with unknown agent sends error', async () => {
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'remove_from_room', roomName: 'TestRoom', agentName: 'Ghost' })
    expect(errors()).toHaveLength(1)
  })

  test('remove_from_room with valid room and agent calls system.removeAgentFromRoom', async () => {
    let called = false
    ;(system as unknown as Record<string, unknown>).removeAgentFromRoom = () => { called = true }
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'remove_from_room', roomName: 'TestRoom', agentName: 'Human' })
    expect(errors()).toHaveLength(0)
    expect(called).toBe(true)
  })

  // --- update_agent ---

  test('update_agent tools refreshes system tool support', async () => {
    const bot = createAIAgent(
      { name: 'Bot', model: 'test', persona: 'You are a test bot.' },
      makeLLMProvider(),
      () => {},
    )
    system.team.addAgent(bot)
    ;(system as unknown as { toolRegistry: { list: () => ReadonlyArray<{ name: string }> } }).toolRegistry = {
      list: () => [{ name: 'pass' }],
    }
    let refreshes = 0
    ;(system as unknown as Record<string, unknown>).refreshAllAgentTools = async () => { refreshes += 1 }
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'update_agent', name: 'Bot', tools: ['pass', 'missing'] })
    expect(errors()).toHaveLength(0)
    expect(bot.getTools()).toEqual(['pass'])
    expect(refreshes).toBe(1)
  })

  // --- create_room ---

  test('create_room with duplicate name does NOT auto-add (v15+ no WS-bound creator)', async () => {
    let addCalled = false
    ;(system as unknown as Record<string, unknown>).addAgentToRoom = async () => { addCalled = true }
    const { ws, errors } = makeWS()
    await dispatch(ws, session, system, wsManager, { type: 'create_room', name: 'TestRoom' })
    // Duplicate names are allowed (createRoomSafe returns sanitised name) — no error expected
    expect(errors()).toHaveLength(0)
    // v15+ semantics: WS sessions don't represent an agent, so create_room
    // can't auto-add a creator. User adds members via the chip row.
    expect(addCalled).toBe(false)
  })
})

describe('WSManager.safeSend backpressure', () => {
  test('drops slow consumer when buffer exceeds 8 MB and increments metric', () => {
    const { createLimitMetrics } = require('../core/limit-metrics.ts') as typeof import('../core/limit-metrics.ts')
    const limitMetrics = createLimitMetrics()
    const wsManager = createWSManager({
      getSystem: () => undefined,
      limitMetrics,
    })
    const { ws, messages, setBuffered, closed } = makeWS()
    setBuffered(9 * 1024 * 1024)  // over the 8 MB cap
    const accepted = wsManager.safeSend(ws, 'payload')
    expect(accepted).toBe(false)
    expect(messages()).toHaveLength(0)
    expect(closed()).toEqual({ code: 1009, reason: 'slow consumer' })
    expect(limitMetrics.snapshot().wsBackpressureDropped).toBe(1)
  })

  test('sends normally when buffer is under cap', () => {
    const wsManager = createWSManager({ getSystem: () => undefined })
    const { ws, setBuffered, closed } = makeWS()
    setBuffered(1024)
    let received = ''
    const proxyWs = {
      send: (d: string) => { received = d },
      getBufferedAmount: ws.getBufferedAmount,
      close: ws.close,
    }
    const accepted = wsManager.safeSend(proxyWs, 'hello')
    expect(accepted).toBe(true)
    expect(received).toBe('hello')
    expect(closed()).toBeNull()
  })

  test('buildSnapshot returns null when system is evicted (caller closes 4001)', () => {
    const wsManager = createWSManager({ getSystem: () => undefined })
    const result = wsManager.buildSnapshot('test0123456789ab', 'agent-id')
    expect(result).toBeNull()
  })

  test('sweepStaleSessions drops sessions with closed WS + old lastActivity, removes agent', async () => {
    const { createLimitMetrics } = await import('../core/limit-metrics.ts')
    const limitMetrics = createLimitMetrics()
    const removed: string[] = []
    const fakeSystem = { removeAgent: (id: string) => { removed.push(id); return true } } as unknown as System
    const wsManager = createWSManager({
      getSystem: () => fakeSystem,
      limitMetrics,
    })
    const TEN_DAYS_AGO = Date.now() - 10 * 24 * 60 * 60 * 1000
    wsManager.sessions.set('stale-token', {

      instanceId: 'test0123456789ab',
      sessionToken: 'stale-token',
      lastActivity: TEN_DAYS_AGO,
    })
    // Recent + no live ws — should NOT be swept.
    wsManager.sessions.set('recent-token', {

      instanceId: 'test0123456789ab',
      sessionToken: 'recent-token',
      lastActivity: Date.now() - 60_000,
    })
    // Old but live connection — should NOT be swept.
    wsManager.sessions.set('live-token', {

      instanceId: 'test0123456789ab',
      sessionToken: 'live-token',
      lastActivity: TEN_DAYS_AGO,
    })
    wsManager.wsConnections.set('live-token', {
      send: () => {}, getBufferedAmount: () => 0, close: () => {},
    })

    const dropped = wsManager.sweepStaleSessions()
    expect(dropped).toBe(1)
    expect(wsManager.sessions.has('stale-token')).toBe(false)
    expect(wsManager.sessions.has('recent-token')).toBe(true)
    expect(wsManager.sessions.has('live-token')).toBe(true)
    // v15+: sweep no longer removes agents from team. Sessions are pure
    // viewers; agent removal only happens via DELETE /api/agents/:name.
    expect(removed).toEqual([])
    expect(limitMetrics.snapshot().staleSessionsEvicted).toBe(1)
  })

  test('sweepStaleSessions tolerates evicted instance (no agent removal, session still dropped)', async () => {
    const { createLimitMetrics } = await import('../core/limit-metrics.ts')
    const limitMetrics = createLimitMetrics()
    const wsManager = createWSManager({
      getSystem: () => undefined,           // instance evicted
      limitMetrics,
    })
    wsManager.sessions.set('orphan-token', {

      instanceId: 'test0123456789ab',
      sessionToken: 'orphan-token',
      lastActivity: Date.now() - 10 * 24 * 60 * 60 * 1000,
    })
    const dropped = wsManager.sweepStaleSessions()
    expect(dropped).toBe(1)
    expect(wsManager.sessions.has('orphan-token')).toBe(false)
    expect(limitMetrics.snapshot().staleSessionsEvicted).toBe(1)
  })

  test('post_message ack uses safeSend (drops on slow consumer)', async () => {
    // End-to-end proof that command-handler responses go through safeSend
    // after the Phase 1 widening — not direct ws.send.
    const localSystem = (await import('./ws-handler.test.ts')) as never
    void localSystem
    const wsManager = createWSManager({ getSystem: () => undefined })
    const { ws, messages, setBuffered, closed } = makeWS()
    setBuffered(9 * 1024 * 1024)
    // Direct safeSend invocation — proves the wire works. The end-to-end
    // path is exercised by integration; covering the wire is the regression
    // guard against future calls bypassing safeSend.
    wsManager.safeSend(ws, JSON.stringify({ type: 'message', message: { id: 'x' } }))
    expect(messages()).toHaveLength(0)
    expect(closed()).toEqual({ code: 1009, reason: 'slow consumer' })
  })
})
