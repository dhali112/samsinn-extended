// Runner unit tests that don't need a full SystemRegistry. The welcome-flow
// integration test (welcome.integration.test.ts) covers the end-to-end happy
// path against a real System; this file pins the runner's policy contracts.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSystemRegistry, type SystemRegistry } from '../instances/system-registry.ts'
import { createSharedRuntime } from '../shared-runtime.ts'
import { generateInstanceId } from '../../api/instance-cookie.ts'
import { parseScenario } from './parser.ts'

const wrap = (body: string): string =>
  `---\ntitle: Test\n---\n\n${body}\n`

describe('scenario runner', () => {
  let originalHome: string | undefined
  let homeDir: string
  let registry: SystemRegistry

  beforeEach(async () => {
    originalHome = process.env.SAMSINN_HOME
    homeDir = await mkdtemp(join(tmpdir(), 'samsinn-runner-'))
    process.env.SAMSINN_HOME = homeDir
    process.env.PROVIDER = 'ollama'
    process.env.SAMSINN_SEED_EXAMPLE = '0'   // skip welcome auto-seed; we run scenarios explicitly
    const shared = createSharedRuntime()
    registry = createSystemRegistry({ shared, idleMs: 1_000_000 })
  })

  afterEach(async () => {
    await registry.shutdown()
    if (originalHome === undefined) delete process.env.SAMSINN_HOME
    else process.env.SAMSINN_HOME = originalHome
    delete process.env.PROVIDER
    delete process.env.SAMSINN_SEED_EXAMPLE
    await rm(homeDir, { recursive: true, force: true })
  })

  test('install-pack op fails closed without explicit consent', async () => {
    const system = await registry.getOrLoad(generateInstanceId())
    const scenario = parseScenario('test', 'install-only', wrap([
      '```scenario',
      '- install-pack: samsinn-packs/aviation',
      '```',
    ].join('\n')))
    const result = await system.scenarioRunner.run(scenario)   // no allowInstall
    expect(result.ok).toBe(true)
    const runId = result.runId!
    // Wait for the run to fail.
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const r = system.scenarioRunner.getRun(runId)
      if (!r || r.status === 'failed' || r.status === 'completed') break
      await new Promise(res => setTimeout(res, 10))
    }
    const run = system.scenarioRunner.getRun(runId)
    expect(run?.status).toBe('failed')
    expect(run?.failureReason).toMatch(/allowInstall consent/)
  })

  test('refuses concurrent runs in the same instance', async () => {
    const system = await registry.getOrLoad(generateInstanceId())
    // A scenario with a click-wait that blocks indefinitely.
    const blocker = parseScenario('test', 'blocker', wrap([
      '```scenario',
      '- create-room: { name: R }',
      '- guide-tooltip: { selector: "body", body: hi, waitFor: { type: click } }',
      '```',
    ].join('\n')))
    const a = await system.scenarioRunner.run(blocker)
    expect(a.ok).toBe(true)
    // Give the loop a tick to advance into 'awaiting'.
    await new Promise(res => setTimeout(res, 50))
    const b = await system.scenarioRunner.run(blocker)
    expect(b.ok).toBe(false)
    expect(b.reason).toMatch(/another scenario is running/)
    // Cleanup.
    system.scenarioRunner.stop(a.runId!)
  })

  test('stop() during awaiting unblocks the loop and emits scenario_stopped', async () => {
    const system = await registry.getOrLoad(generateInstanceId())
    const scenario = parseScenario('test', 'wait-then-stop', wrap([
      '```scenario',
      '- create-room: { name: R }',
      '- guide-tooltip: { selector: "body", body: hi, waitFor: { type: click } }',
      '- post-message: { room: R, as: system, body: tail }',
      '```',
    ].join('\n')))
    const result = await system.scenarioRunner.run(scenario)
    expect(result.ok).toBe(true)
    await new Promise(res => setTimeout(res, 50))
    expect(system.scenarioRunner.getRun(result.runId!)?.status).toBe('awaiting')
    const stopped = system.scenarioRunner.stop(result.runId!)
    expect(stopped.ok).toBe(true)
    // Give the loop a tick to settle.
    await new Promise(res => setTimeout(res, 50))
    expect(system.scenarioRunner.getRun(result.runId!)?.status).toBe('stopped')
    // The trailing post-message must NOT have run.
    const room = system.house.getRoom('R')!
    const tailMsg = room.getRecent(20).find(m => m.content === 'tail')
    expect(tailMsg).toBeUndefined()
  })

  test('post-message dedupes by content for system-typed posts', async () => {
    const system = await registry.getOrLoad(generateInstanceId())
    const scenario = parseScenario('test', 'dedupe', wrap([
      '```scenario',
      '- create-room: { name: R }',
      '- post-message: { room: R, as: system, body: hi }',
      '```',
    ].join('\n')))
    const a = await system.scenarioRunner.run(scenario)
    expect(a.ok).toBe(true)
    let deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const r = system.scenarioRunner.getRun(a.runId!)
      if (!r || r.status === 'completed' || r.status === 'failed') break
      await new Promise(res => setTimeout(res, 10))
    }
    const b = await system.scenarioRunner.run(scenario)
    expect(b.ok).toBe(true)
    deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const r = system.scenarioRunner.getRun(b.runId!)
      if (!r || r.status === 'completed' || r.status === 'failed') break
      await new Promise(res => setTimeout(res, 10))
    }
    const messages = system.house.getRoom('R')!.getRecent(20).filter(m => m.content === 'hi')
    expect(messages.length).toBe(1)   // dedup, not 2
  })
})
