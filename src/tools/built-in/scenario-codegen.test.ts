// Tests for the write_scenario built-in tool. Mirrors the script-codegen
// test pattern: real ScenarioStore against a tmpdir, no mocks.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScenarioStore } from '../../core/scenarios/store.ts'
import { createWriteScenarioTool } from './scenario-codegen.ts'

const validSource = `---
title: Demo Scenario
---

\`\`\`scenario
- create-room:
    name: TestRoom
\`\`\`
`

describe('write_scenario tool', () => {
  let baseDir: string

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), 'samsinn-scenario-codegen-'))
  })

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true })
  })

  test('writes a valid scenario and returns name+title', async () => {
    const store = createScenarioStore({ baseDir })
    let changed = 0
    const tool = createWriteScenarioTool(store, () => { changed++ })
    const result = await tool.execute({ name: 'demo', source: validSource })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ name: 'demo', title: 'Demo Scenario' })
    expect(changed).toBe(1)
    // Persisted: store.get returns it under id `local:demo`.
    const all = store.list()
    expect(all.length).toBe(1)
    expect(all[0]!.name).toBe('demo')
    expect(all[0]!.pack).toBe('local')
  })

  test('rejects malformed source with a parse error', async () => {
    const store = createScenarioStore({ baseDir })
    const tool = createWriteScenarioTool(store, () => {})
    const result = await tool.execute({
      name: 'broken',
      source: '---\ntitle: Bad\n---\n\n```scenario\n- not-a-real-op:\n    foo: bar\n```\n',
    })
    expect(result.success).toBe(false)
    expect(typeof result.error).toBe('string')
  })

  test('rejects missing name or source', async () => {
    const store = createScenarioStore({ baseDir })
    const tool = createWriteScenarioTool(store, () => {})
    expect((await tool.execute({ name: '', source: validSource })).success).toBe(false)
    expect((await tool.execute({ name: 'x', source: '' })).success).toBe(false)
  })

  test('rejects oversized source', async () => {
    const store = createScenarioStore({ baseDir })
    const tool = createWriteScenarioTool(store, () => {})
    const huge = 'X'.repeat(300_000)
    const result = await tool.execute({ name: 'huge', source: huge })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/too large/)
  })

  test('upsert overwrites prior version with same name', async () => {
    const store = createScenarioStore({ baseDir })
    const tool = createWriteScenarioTool(store, () => {})
    await tool.execute({ name: 'rev', source: validSource })
    const updatedSource = validSource.replace('Demo Scenario', 'Demo v2')
    const r2 = await tool.execute({ name: 'rev', source: updatedSource })
    expect(r2.success).toBe(true)
    expect(r2.data).toEqual({ name: 'rev', title: 'Demo v2' })
    expect(store.list().length).toBe(1)
  })
})
