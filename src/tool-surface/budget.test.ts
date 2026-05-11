// Budget cap tests — fitProjection's exemption rules + the rate-limited
// WARN log dedup. Pure functions over real ToolDefinition data; no mocks.

import { describe, expect, test, beforeEach } from 'bun:test'
import type { ToolDefinition } from '../core/types/tool.ts'
import {
  fitProjection,
  estimateTokens,
  __resetBudgetWarnState,
  DEFAULT_TOOL_TOKEN_BUDGET,
} from './budget.ts'

const def = (name: string, descSize = 100): ToolDefinition => ({
  type: 'function',
  function: {
    name,
    description: 'x'.repeat(descSize),
    parameters: { type: 'object', properties: {} },
  },
})

describe('estimateTokens', () => {
  test('grows with description size', () => {
    const small = estimateTokens(def('a', 50))
    const big = estimateTokens(def('a', 1000))
    expect(big).toBeGreaterThan(small)
  })

  test('produces sensible magnitude for a typical tool definition', () => {
    const t = def('tool_x', 200)
    const tokens = estimateTokens(t)
    expect(tokens).toBeGreaterThan(40)
    expect(tokens).toBeLessThan(200)
  })
})

describe('fitProjection', () => {
  beforeEach(() => { __resetBudgetWarnState() })

  test('always keeps core conversational tools regardless of budget', () => {
    const tools = [
      def('pass', 50),
      def('post_to_room', 100),
      def('get_my_context', 80),
      def('some_other_tool', 1500),
    ]
    const result = fitProjection(tools, 100)
    const keptNames = result.kept.map(t => t.function.name)
    expect(keptNames).toContain('pass')
    expect(keptNames).toContain('post_to_room')
    expect(keptNames).toContain('get_my_context')
    expect(keptNames).not.toContain('some_other_tool')
    expect(result.dropped).toEqual(['some_other_tool'])
  })

  test('always keeps family dispatchers regardless of budget', () => {
    const tools = [
      def('fs', 200),                  // dispatcher — exempt
      def('geo_tools', 200),           // dispatcher — exempt
      def('verbose_tool', 5000),       // would-exceed
    ]
    const result = fitProjection(tools, 100)
    expect(result.kept.map(t => t.function.name)).toEqual(['fs', 'geo_tools'])
    expect(result.dropped).toEqual(['verbose_tool'])
  })

  test('default budget is comfortable for a normal tool set', () => {
    const tools = [
      def('pass', 50),
      def('web_search', 200),
      def('web_fetch', 200),
      def('recall', 200),
      def('note', 150),
      def('my_notes', 100),
    ]
    const result = fitProjection(tools, DEFAULT_TOOL_TOKEN_BUDGET)
    expect(result.dropped).toEqual([])
    expect(result.totalTokens).toBeLessThan(DEFAULT_TOOL_TOKEN_BUDGET)
  })

  test('drops in registration order when budget exceeded', () => {
    // 30 tools at ~50 tokens each = 1500 tokens. Cap at 250 → keep first
    // few only.
    const tools = Array.from({ length: 30 }, (_, i) => def(`t${i}`, 100))
    const result = fitProjection(tools, 250)
    expect(result.kept.length).toBeGreaterThan(0)
    expect(result.dropped.length).toBeGreaterThan(0)
    // First-included tools should be the earliest registered.
    expect(result.kept[0]!.function.name).toBe('t0')
  })

  test('totalTokens reflects kept set, not original', () => {
    const tools = [def('pass', 50), def('big', 5000), def('other', 100)]
    const result = fitProjection(tools, 200)
    // pass is always kept; big is dropped (exceeds); other fits
    expect(result.kept.map(t => t.function.name).sort()).toEqual(['other', 'pass'])
    expect(result.dropped).toEqual(['big'])
    expect(result.totalTokens).toBe(
      estimateTokens(def('pass', 50)) + estimateTokens(def('other', 100)),
    )
  })

  test('reports zero dropped when everything fits', () => {
    const tools = [def('a', 50), def('b', 50)]
    const result = fitProjection(tools, 10_000)
    expect(result.dropped).toEqual([])
    expect(result.kept.length).toBe(2)
  })
})
