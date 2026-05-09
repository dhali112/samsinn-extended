import { describe, expect, test, beforeEach } from 'bun:test'
import { parseScenarioId, computeTooltipPlacement } from './scenario-pure.ts'

describe('parseScenarioId', () => {
  test('valid pack/name', () => {
    expect(parseScenarioId('welcome/getting-started')).toEqual({
      ok: true, pack: 'welcome', name: 'getting-started',
    })
  })
  test('rejects empty', () => {
    expect(parseScenarioId('')).toMatchObject({ ok: false, reason: 'empty id' })
  })
  test('rejects missing pack prefix', () => {
    expect(parseScenarioId('/foo')).toMatchObject({ ok: false })
    expect(parseScenarioId('foo')).toMatchObject({ ok: false })
  })
  test('rejects missing name', () => {
    expect(parseScenarioId('foo/')).toMatchObject({ ok: false })
  })
  test('rejects multi-slash names with explanatory reason', () => {
    const r = parseScenarioId('foo/bar/baz')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/slashes/)
  })
})

describe('computeTooltipPlacement', () => {
  const viewport = { innerWidth: 1000, innerHeight: 800 }
  const dims = { width: 200, height: 100 }

  test('no anchor → centered with translate', () => {
    const p = computeTooltipPlacement(null, dims, viewport)
    expect(p).toEqual({ left: 500, top: 400, useTransform: true })
  })

  test('anchor in middle → pin to right, no transform', () => {
    const anchor = { left: 400, top: 300, right: 500, bottom: 350, width: 100, height: 50 }
    const p = computeTooltipPlacement(anchor, dims, viewport)
    expect(p.useTransform).toBe(false)
    expect(p.left).toBe(508)   // 500 + 8 margin
    expect(p.top).toBe(300)    // anchor.top
  })

  test('anchor near right edge → flip to the left', () => {
    const anchor = { left: 800, top: 300, right: 900, bottom: 350, width: 100, height: 50 }
    const p = computeTooltipPlacement(anchor, dims, viewport)
    // 900 + 8 + 200 = 1108 > 992 (1000 - 8 pad) → flip
    expect(p.left).toBe(800 - 200 - 8)   // anchor.left - tooltip.width - margin
  })

  test('anchor near bottom edge → shift up', () => {
    const anchor = { left: 400, top: 750, right: 500, bottom: 790, width: 100, height: 40 }
    const p = computeTooltipPlacement(anchor, dims, viewport)
    // 750 + 100 = 850 > 792 → shift up
    expect(p.top).toBe(800 - 100 - 8)   // viewport.h - tooltip.h - pad
  })

  test('anchor with no horizontal room either side → clamp to EDGE_PAD', () => {
    // Tooltip width 990 in a 1000-wide viewport, anchor on the left edge.
    const anchor = { left: 0, top: 100, right: 50, bottom: 150, width: 50, height: 50 }
    const p = computeTooltipPlacement(anchor, { width: 990, height: 100 }, viewport)
    // Right side: 50 + 8 + 990 = 1048 > 992 → flip left.
    // Left side: 0 - 990 - 8 = -998, max(8, -998) = 8.
    expect(p.left).toBe(8)
  })
})

// `claimRunOwnership` lives in scenario-overlay.ts which is DOM-bound, but
// its persistence layer is pure sessionStorage. We test the public API
// using a stub sessionStorage on globalThis — same pattern used by the
// scenario-overlay module itself when sessionStorage is unavailable.
describe('claimRunOwnership (bounded sessionStorage)', () => {
  beforeEach(() => {
    const store = new Map<string, string>()
    ;(globalThis as { sessionStorage?: Storage }).sessionStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
      removeItem: (k: string) => { store.delete(k) },
      clear: () => { store.clear() },
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() { return store.size },
    } as Storage
  })

  test('caps at 8 entries, oldest evicted', async () => {
    const { claimRunOwnership } = await import('./scenario-overlay.ts')
    for (let i = 1; i <= 10; i++) claimRunOwnership(`run-${i}`)
    const stored = sessionStorage.getItem('samsinn:owned-scenario-runs') ?? ''
    const ids = stored.split(',').filter(Boolean)
    expect(ids.length).toBe(8)
    expect(ids).toEqual(['run-3', 'run-4', 'run-5', 'run-6', 'run-7', 'run-8', 'run-9', 'run-10'])
  })

  test('idempotent: claiming the same id twice is a no-op', async () => {
    const { claimRunOwnership } = await import('./scenario-overlay.ts')
    claimRunOwnership('a')
    claimRunOwnership('a')
    claimRunOwnership('a')
    const stored = sessionStorage.getItem('samsinn:owned-scenario-runs') ?? ''
    expect(stored.split(',').filter(Boolean)).toEqual(['a'])
  })
})
