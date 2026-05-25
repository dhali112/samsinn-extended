import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import {
  computeContextBudget,
  AUTO_BUDGET_FRACTION,
  AUTO_BUDGET_FLOOR,
  AUTO_BUDGET_FALLBACK,
  DYNAMIC_OUTPUT_RESERVE,
  DYNAMIC_SAFETY_MARGIN,
  type EstimateTokensFn,
} from './budget.ts'

// Cheap stand-in: 1 token per 4 chars (matches the production estimator's
// rule of thumb in context-builder.estimateTokens). Tests don't need
// production fidelity — only consistent within the test.
const estimateTokens: EstimateTokensFn = (text) => Math.ceil(text.length / 4)

const mkTool = (name: string, description: string, paramsJsonSize = 200) => ({
  name, description,
  parameters: { type: 'object', properties: Object.fromEntries(
    Array.from({ length: Math.max(1, Math.floor(paramsJsonSize / 30)) },
      (_, i) => [`p${i}`, { type: 'string', description: 'placeholder' }]),
  ) },
})

describe('computeContextBudget — static (default, SAMSINN_AUTO_BUDGET_DYNAMIC unset)', () => {
  beforeEach(() => { delete process.env.SAMSINN_AUTO_BUDGET_DYNAMIC })

  test('returns floor(contextMax * FRACTION)', () => {
    const result = computeContextBudget({ contextMax: 200_000, toolDefinitions: [] }, estimateTokens)
    expect(result.mode).toBe('static')
    expect(result.budget).toBe(Math.floor(200_000 * AUTO_BUDGET_FRACTION))
  })

  test('returns FALLBACK when contextMax is 0 (unknown model)', () => {
    const result = computeContextBudget({ contextMax: 0, toolDefinitions: [] }, estimateTokens)
    expect(result.mode).toBe('static')
    expect(result.budget).toBe(AUTO_BUDGET_FALLBACK)
  })

  test('clamps at FLOOR for very small context windows', () => {
    const result = computeContextBudget({ contextMax: 100, toolDefinitions: [] }, estimateTokens)
    expect(result.budget).toBe(AUTO_BUDGET_FLOOR)
  })

  test('tool definitions do NOT affect static budget (regression guard)', () => {
    const noTools = computeContextBudget({ contextMax: 128_000, toolDefinitions: [] }, estimateTokens)
    const manyTools = computeContextBudget({
      contextMax: 128_000,
      toolDefinitions: Array.from({ length: 30 }, (_, i) => mkTool(`tool_${i}`, 'long description '.repeat(20))),
    }, estimateTokens)
    expect(noTools.budget).toBe(manyTools.budget)
  })
})

describe('computeContextBudget — dynamic (SAMSINN_AUTO_BUDGET_DYNAMIC=1)', () => {
  beforeEach(() => { process.env.SAMSINN_AUTO_BUDGET_DYNAMIC = '1' })
  afterEach(() => { delete process.env.SAMSINN_AUTO_BUDGET_DYNAMIC })

  test('dynamic mode for bare agent yields MORE budget than static (95%+)', () => {
    const dyn = computeContextBudget({ contextMax: 200_000, toolDefinitions: [] }, estimateTokens)
    const stat = { budget: Math.floor(200_000 * AUTO_BUDGET_FRACTION) }
    expect(dyn.mode).toBe('dynamic')
    expect(dyn.budget).toBeGreaterThan(stat.budget)
    expect(dyn.budget).toBe(200_000 - 0 - DYNAMIC_OUTPUT_RESERVE - DYNAMIC_SAFETY_MARGIN)
  })

  test('dynamic mode subtracts tool-def token cost', () => {
    const tools = Array.from({ length: 10 }, (_, i) => mkTool(`tool_${i}`, 'a tool that does things ', 500))
    const dyn = computeContextBudget({ contextMax: 128_000, toolDefinitions: tools }, estimateTokens)
    expect(dyn.mode).toBe('dynamic')
    expect(dyn.budget).toBeLessThan(128_000)
    // Reason string captures the breakdown so an operator can debug.
    expect(dyn.reason).toContain('dynamic:')
    expect(dyn.reason).toContain('tools=')
    expect(dyn.reason).toContain(`output=${DYNAMIC_OUTPUT_RESERVE}`)
  })

  test('dynamic mode clamps at FLOOR when tools eat the entire context', () => {
    // Pathological: 5000 tools fully consume even a 128K context.
    const tools = Array.from({ length: 5000 }, (_, i) => mkTool(`tool_${i}`, 'big descr '.repeat(50), 2000))
    const dyn = computeContextBudget({ contextMax: 128_000, toolDefinitions: tools }, estimateTokens)
    expect(dyn.budget).toBe(AUTO_BUDGET_FLOOR)
  })

  test('dynamic mode falls back to FALLBACK when contextMax unknown', () => {
    const dyn = computeContextBudget({ contextMax: 0, toolDefinitions: [] }, estimateTokens)
    expect(dyn.mode).toBe('dynamic')
    expect(dyn.budget).toBe(AUTO_BUDGET_FALLBACK)
  })

  test('SAMSINN_AUTO_BUDGET_DYNAMIC=anything-other-than-1 stays in static mode', () => {
    process.env.SAMSINN_AUTO_BUDGET_DYNAMIC = 'true'  // not "1"
    const result = computeContextBudget({ contextMax: 128_000, toolDefinitions: [] }, estimateTokens)
    expect(result.mode).toBe('static')
  })
})
