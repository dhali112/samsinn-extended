// Phase 3 retry-loop integration tests — drive evaluate() through a stub
// LLMProvider that returns a scripted sequence of responses, and assert the
// retry behavior. We don't run a real provider; the stub records its calls
// so we can verify (a) how many times the LLM was invoked, (b) what context
// was sent on each call, (c) the final committed content.

import { describe, expect, test } from 'bun:test'
import { evaluate } from './evaluation.ts'
import type { ContextResult } from './context-builder.ts'
import type { LLMProvider, ChatRequest, ChatResponse } from '../core/types/llm.ts'
import type { AIAgentConfig } from '../core/types/agent.ts'

// === Stub helpers ===

const mkResponse = (content: string): ChatResponse => ({
  content,
  generationMs: 1,
  tokensUsed: { prompt: 1, completion: 1 },
})

const mkProvider = (responses: ReadonlyArray<string>): {
  provider: LLMProvider
  callLog: { request: ChatRequest }[]
} => {
  const callLog: { request: ChatRequest }[] = []
  let i = 0
  const provider: LLMProvider = {
    chat: async (request: ChatRequest) => {
      callLog.push({ request })
      const r = responses[i] ?? responses[responses.length - 1] ?? ''
      i++
      return mkResponse(r)
    },
    models: async () => [],
  }
  return { provider, callLog }
}

const mkContext = (): ContextResult => ({
  messages: [
    { role: 'system', content: 'You are a test agent.' },
    { role: 'user', content: 'Make a map.' },
  ],
  flushInfo: { ids: new Set(), triggerRoomId: 'room-1' },
  warnings: [],
})

const mkConfig = (): AIAgentConfig => ({
  name: 'TestAgent',
  model: 'stub-model',
  persona: 'test',
})

// === Tests ===

describe('evaluation map-fence retry loop', () => {
  test('valid fence on first try → no retry, posts as-is', async () => {
    const valid = '```map\n{"features":[{"type":"marker","lat":60,"lng":5}]}\n```'
    const reply = `Here you go:\n\n${valid}`
    const { provider, callLog } = mkProvider([reply])
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    expect(callLog.length).toBe(1)
    expect(result.decision.response.action).toBe('respond')
    if (result.decision.response.action === 'respond') {
      expect(result.decision.response.content).toBe(reply)
    }
  })

  test('invalid fence → one retry → corrected response posts', async () => {
    // First attempt: agent uses old `position: [lat, lng]` form. Validator
    // tolerates `position` so we need a TRUE invalid case — out-of-range lat.
    const broken = '```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```'
    const fixed = '```map\n{"features":[{"type":"marker","lat":60,"lng":5}]}\n```'
    const { provider, callLog } = mkProvider([broken, fixed])
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    expect(callLog.length).toBe(2)   // initial + 1 retry
    if (result.decision.response.action === 'respond') {
      expect(result.decision.response.content).toBe(fixed)
    }
    // Second call's context must include the synthetic correction prompt.
    const retryRequest = callLog[1]!.request
    const lastUser = [...retryRequest.messages].reverse().find(m => m.role === 'user')
    expect(lastUser?.content).toMatch(/invalid map fences/)
    expect(lastUser?.content).toMatch(/marker\.lat/)
  })

  test('two failed retries → broken fence posts (UI banner takes over)', async () => {
    const broken1 = '```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```'
    const broken2 = '```map\n{"features":[{"type":"marker","lat":888,"lng":5}]}\n```'
    const broken3 = '```map\n{"features":[{"type":"marker","lat":777,"lng":5}]}\n```'
    const { provider, callLog } = mkProvider([broken1, broken2, broken3])
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    // 1 initial + MAX_FENCE_RETRIES=2 → 3 total LLM calls.
    expect(callLog.length).toBe(3)
    if (result.decision.response.action === 'respond') {
      // Last attempt is what gets posted (broken3, the third call's content).
      expect(result.decision.response.content).toBe(broken3)
    }
  })

  test('mermaid fences are NOT validated server-side (pass through unchecked)', async () => {
    // Even garbage mermaid never triggers a retry — server-side mermaid
    // validation is impractical, so the loop ignores ```mermaid fences.
    const garbageMermaid = '```mermaid\nthis is not valid mermaid syntax at all\n```'
    const reply = `Here:\n\n${garbageMermaid}`
    const { provider, callLog } = mkProvider([reply])
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    expect(callLog.length).toBe(1)   // no retry attempted
    if (result.decision.response.action === 'respond') {
      expect(result.decision.response.content).toBe(reply)
    }
  })

  test('response with no fences at all → no retry, no validation overhead', async () => {
    const reply = 'Just some plain prose, no fences here.'
    const { provider, callLog } = mkProvider([reply])
    await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1')
    expect(callLog.length).toBe(1)
  })

  test('retry budget is independent of maxToolIterations', async () => {
    // maxToolIterations=1: in pure tool terms only one round allowed. Retry
    // happens AFTER the tool loop completes (no tool calls in any of these
    // responses, so the for-loop runs once and terminates). The retry path
    // is its own loop, doesn't consume tool budget.
    const broken = '```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```'
    const fixed = '```map\n{"features":[{"type":"marker","lat":60,"lng":5}]}\n```'
    const { provider, callLog } = mkProvider([broken, fixed])
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 1, 'room-1')
    expect(callLog.length).toBe(2)
    if (result.decision.response.action === 'respond') {
      expect(result.decision.response.content).toBe(fixed)
    }
  })

  test('eval_completed event fires exactly once, with the final outcome', async () => {
    const broken = '```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```'
    const fixed = '```map\n{"features":[{"type":"marker","lat":60,"lng":5}]}\n```'
    const { provider } = mkProvider([broken, fixed])
    const completedEvents: Array<{ outcome: string }> = []
    await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1', {
      onEvent: (e) => {
        if (e.kind === 'eval_completed') completedEvents.push({ outcome: e.outcome })
      },
    })
    expect(completedEvents).toEqual([{ outcome: 'respond' }])
  })

  test('signal abort during retry stops cleanly', async () => {
    const broken = '```map\n{"features":[{"type":"marker","lat":999,"lng":5}]}\n```'
    const fixed = '```map\n{"features":[{"type":"marker","lat":60,"lng":5}]}\n```'
    const { provider } = mkProvider([broken, fixed])
    const ctrl = new AbortController()
    ctrl.abort()
    const result = await evaluate(mkContext(), mkConfig(), provider, undefined, 5, 'room-1', {
      signal: ctrl.signal,
    })
    // Aborted before retry could happen — the broken response is what we get.
    if (result.decision.response.action === 'respond') {
      expect(result.decision.response.content).toBe(broken)
    }
  })
})
