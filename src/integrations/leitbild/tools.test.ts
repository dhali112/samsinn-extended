import { describe, expect, test } from 'bun:test'
import { createLeitbildTools, __clearLeitbildToolCache } from './tools.ts'
import type { LeitbildAgentBinding } from '../../core/types/agent.ts'

describe('leitbild tools', () => {
  test('returns four read tools with stable names', () => {
    const tools = createLeitbildTools({ getBinding: () => undefined })
    expect(tools.map(t => t.name)).toEqual(['lb_state', 'lb_object', 'lb_query', 'lb_scenario'])
  })

  test('each tool fails with a helpful error when no binding is configured', async () => {
    __clearLeitbildToolCache()
    const tools = createLeitbildTools({ getBinding: () => undefined })
    const ctx = { callerId: 'agent-1', callerName: 'TestAgent' }
    for (const tool of tools) {
      const result = await tool.execute(tool.name === 'lb_object' ? { id: 'amb-1' } : tool.name === 'lb_query' ? { packId: 'ambulance', kind: 'ambulance.objects' } : {}, ctx)
      expect(result.success).toBe(false)
      expect(String(result.error)).toContain('No leitbildBinding')
    }
  })

  test('binding resolver receives the caller id', async () => {
    const seen: string[] = []
    const binding: LeitbildAgentBinding = { baseUrl: 'https://example.test', instanceId: 'x:y', role: 'observer' }
    const tools = createLeitbildTools({
      getBinding: (id: string) => { seen.push(id); return binding },
    })
    // Pick lb_state; it'll attempt a fetch which will fail in test env, but
    // that's fine — we only care that getBinding was called with the caller.
    const tool = tools.find(t => t.name === 'lb_state')!
    await tool.execute({}, { callerId: 'agent-42', callerName: 'TestAgent' })
    expect(seen).toContain('agent-42')
  })
})
