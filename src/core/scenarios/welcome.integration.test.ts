// Integration test: the bundled welcome scenario produces the same end-state
// as the prior hardcoded seed-example.ts (one Cafe room, one AI agent, one
// Human agent, one welcome system message). Locks in the migration so the
// data-driven seed can't silently regress.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSystemRegistry, type SystemRegistry } from '../instances/system-registry.ts'
import { createSharedRuntime } from '../shared-runtime.ts'
import { generateInstanceId } from '../../api/instance-cookie.ts'

describe('welcome scenario (first-run seed)', () => {
  let originalHome: string | undefined
  let originalSeedFlag: string | undefined
  let homeDir: string
  let registry: SystemRegistry

  beforeEach(async () => {
    originalHome = process.env.SAMSINN_HOME
    originalSeedFlag = process.env.SAMSINN_SEED_EXAMPLE
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-welcome-'))
    process.env.SAMSINN_HOME = homeDir
    process.env.PROVIDER = 'ollama'
    delete process.env.SAMSINN_SEED_EXAMPLE   // ensure seeding runs (default = on)
    const shared = createSharedRuntime()
    registry = createSystemRegistry({ shared, idleMs: 1_000_000 })
  })

  afterEach(async () => {
    await registry.shutdown()
    if (originalHome === undefined) delete process.env.SAMSINN_HOME
    else process.env.SAMSINN_HOME = originalHome
    if (originalSeedFlag === undefined) delete process.env.SAMSINN_SEED_EXAMPLE
    else process.env.SAMSINN_SEED_EXAMPLE = originalSeedFlag
    delete process.env.PROVIDER
    await rm(homeDir, { recursive: true, force: true })
  })

  it('a fresh instance gets one Cafe room with AI + Human agents and a welcome message', async () => {
    const id = generateInstanceId()
    const system = await registry.getOrLoad(id)

    const rooms = system.house.listAllRooms()
    expect(rooms).toHaveLength(1)
    expect(rooms[0]!.name).toBe('Cafe')

    const aiAgent = system.team.getAgent('AI')
    const humanAgent = system.team.getAgent('Human')
    expect(aiAgent?.kind).toBe('ai')
    expect(humanAgent?.kind).toBe('human')

    const cafe = system.house.getRoom('Cafe')!
    expect(cafe.hasMember(aiAgent!.id)).toBe(true)
    expect(cafe.hasMember(humanAgent!.id)).toBe(true)

    // Welcome message present.
    const messages = cafe.getRecent(50)
    expect(messages.length).toBeGreaterThanOrEqual(1)
    const welcome = messages.find(m => m.content.includes('Welcome to the Cafe'))
    expect(welcome).toBeDefined()
    expect(welcome!.type).toBe('system')
  })

  it('SAMSINN_SEED_EXAMPLE=0 leaves the instance empty', async () => {
    process.env.SAMSINN_SEED_EXAMPLE = '0'
    const id = generateInstanceId()
    const system = await registry.getOrLoad(id)
    expect(system.house.listAllRooms()).toHaveLength(0)
    expect(system.team.listAgents()).toHaveLength(0)
  })

  it('the welcome scenario is idempotent — re-running produces no duplicates', async () => {
    const id = generateInstanceId()
    const system = await registry.getOrLoad(id)

    const baselineRooms = system.house.listAllRooms().length
    const baselineAgents = system.team.listAgents().length
    const baselineMessages = system.house.getRoom('Cafe')!.getRecent(100).length

    // Re-run the same scenario.
    const scenario = system.scenarioStore.get('welcome/getting-started')!
    expect(scenario).toBeDefined()
    const result = await system.scenarioRunner.run(scenario)
    expect(result.ok).toBe(true)
    // Wait for the run to finish.
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const r = system.scenarioRunner.getRun(result.runId!)
      if (!r || r.status === 'completed' || r.status === 'failed') break
      await new Promise(res => setTimeout(res, 10))
    }

    expect(system.house.listAllRooms().length).toBe(baselineRooms)
    expect(system.team.listAgents().length).toBe(baselineAgents)
    // System-typed posts dedupe by content match — re-running must NOT
    // restack the welcome card.
    expect(system.house.getRoom('Cafe')!.getRecent(100).length).toBe(baselineMessages)
  })
})
