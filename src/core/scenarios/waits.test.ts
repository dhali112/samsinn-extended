// Unit tests for the external-wait arrangers. Each arranger is exercised in
// isolation against a stub System / state so we don't need a SystemRegistry
// boot per test.

import { describe, expect, test } from 'bun:test'
import { arrangeExternalWait, type ExternalWaitArgs, type ArrangerCtx } from './waits.ts'
import type { ScenarioRun } from './types.ts'
import type { OnEvalEvent, EvalEvent } from '../types/agent-eval.ts'

const mkState = (): ScenarioRun => ({
  runId: 'r1',
  scenarioId: 't/test',
  title: 'T',
  status: 'awaiting',
  currentOpIndex: 0,
  totalOps: 1,
  startedAt: 0,
  lastTouchedAt: 0,
})

interface StubSystemPartial {
  team: { getAgent: (name: string) => { id: string; name: string; kind: 'ai' | 'human' } | undefined }
  house: { getRoom: (name: string) => { profile: { id: string } } | undefined }
  addEvalEventListener: (cb: OnEvalEvent) => () => void
  addScriptEventListener: (cb: (roomId: string, event: string, detail: Record<string, unknown>) => void) => () => void
}

const mkCtx = (system: StubSystemPartial, resolve: () => void): ArrangerCtx => {
  const tracked: Array<ReturnType<typeof setTimeout>> = []
  return {
    state: mkState(),
    // Cast through unknown — we don't need the full System for these unit
    // tests; the arranger only touches the four properties we stub above.
    system: system as unknown as ArrangerCtx['system'],
    resolve,
    trackTimer: (h) => { tracked.push(h) },
  }
}

describe('arrangeExternalWait — timer', () => {
  test('resolves after seconds elapse', async () => {
    let resolved = false
    const stub: StubSystemPartial = {
      team: { getAgent: () => undefined },
      house: { getRoom: () => undefined },
      addEvalEventListener: () => () => { /* noop */ },
      addScriptEventListener: () => () => { /* noop */ },
    }
    const args: ExternalWaitArgs = { type: 'timer', seconds: 0.05 }   // 50ms
    arrangeExternalWait(args, mkCtx(stub, () => { resolved = true }))
    await new Promise(r => setTimeout(r, 100))
    expect(resolved).toBe(true)
  })

  test('unsubscribe cancels the timer', async () => {
    let resolved = false
    const stub: StubSystemPartial = {
      team: { getAgent: () => undefined },
      house: { getRoom: () => undefined },
      addEvalEventListener: () => () => { /* noop */ },
      addScriptEventListener: () => () => { /* noop */ },
    }
    const unsub = arrangeExternalWait(
      { type: 'timer', seconds: 0.05 },
      mkCtx(stub, () => { resolved = true }),
    )
    unsub()
    await new Promise(r => setTimeout(r, 100))
    expect(resolved).toBe(false)
  })
})

describe('arrangeExternalWait — llm-response', () => {
  test('resolves on eval_completed for the named agent', async () => {
    let emit: OnEvalEvent | null = null
    const stub: StubSystemPartial = {
      team: { getAgent: (name) => name === 'AI' ? { id: 'a1', name: 'AI', kind: 'ai' } : undefined },
      house: { getRoom: () => undefined },
      addEvalEventListener: (cb) => { emit = cb; return () => { emit = null } },
      addScriptEventListener: () => () => { /* noop */ },
    }
    let resolved = false
    arrangeExternalWait(
      { type: 'llm-response', agent: 'AI' },
      mkCtx(stub, () => { resolved = true }),
    )
    expect(emit).not.toBeNull()
    emit!('AI', { kind: 'eval_completed', outcome: 'respond', traceId: 'tr_test_1' } satisfies EvalEvent)
    expect(resolved).toBe(true)
  })

  test('ignores events from other agents', async () => {
    let emit: OnEvalEvent | null = null
    const stub: StubSystemPartial = {
      team: { getAgent: (name) => name === 'AI' ? { id: 'a1', name: 'AI', kind: 'ai' } : undefined },
      house: { getRoom: () => undefined },
      addEvalEventListener: (cb) => { emit = cb; return () => { emit = null } },
      addScriptEventListener: () => () => { /* noop */ },
    }
    let resolved = false
    arrangeExternalWait(
      { type: 'llm-response', agent: 'AI' },
      mkCtx(stub, () => { resolved = true }),
    )
    emit!('OtherAgent', { kind: 'eval_completed', outcome: 'respond', traceId: 'tr_test_2' } satisfies EvalEvent)
    expect(resolved).toBe(false)
  })

  test('ignores non-eval_completed events from the agent', async () => {
    let emit: OnEvalEvent | null = null
    const stub: StubSystemPartial = {
      team: { getAgent: (name) => name === 'AI' ? { id: 'a1', name: 'AI', kind: 'ai' } : undefined },
      house: { getRoom: () => undefined },
      addEvalEventListener: (cb) => { emit = cb; return () => { emit = null } },
      addScriptEventListener: () => () => { /* noop */ },
    }
    let resolved = false
    arrangeExternalWait(
      { type: 'llm-response', agent: 'AI' },
      mkCtx(stub, () => { resolved = true }),
    )
    emit!('AI', { kind: 'chunk', delta: 'hi', traceId: 'tr_test_3' } satisfies EvalEvent)
    expect(resolved).toBe(false)
  })

  test('resolves immediately when the named agent does not exist', () => {
    const stub: StubSystemPartial = {
      team: { getAgent: () => undefined },
      house: { getRoom: () => undefined },
      addEvalEventListener: () => () => { /* noop */ },
      addScriptEventListener: () => () => { /* noop */ },
    }
    let resolved = false
    arrangeExternalWait(
      { type: 'llm-response', agent: 'Ghost' },
      mkCtx(stub, () => { resolved = true }),
    )
    expect(resolved).toBe(true)
  })
})
