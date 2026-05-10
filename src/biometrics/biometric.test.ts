// Pure unit tests for the biometric derivations. No DOM, no MediaPipe — the
// derivations are deterministic functions over blendshape vectors and head-
// pose euler angles. Inputs are real fixture vectors representative of
// what MediaPipe emits at runtime.

import { describe, expect, test } from 'bun:test'
import { computeAttention } from './derivations/attention.ts'
import { computeExpression } from './derivations/expression.ts'
import { computePresence } from './derivations/presence.ts'
import { createBlinkTracker } from './derivations/blink.ts'

const blendshapes = (entries: Record<string, number>): ReadonlyMap<string, number> =>
  new Map(Object.entries(entries))

describe('attention', () => {
  test('high attention when head faces camera and eyes are neutral', () => {
    const score = computeAttention(0, 0, blendshapes({}))
    expect(score).toBeGreaterThan(0.95)
  })

  test('zero attention when head turns past cutoff', () => {
    // 60° yaw — well past the 30° cutoff
    const score = computeAttention(Math.PI / 3, 0, blendshapes({}))
    expect(score).toBe(0)
  })

  test('reduced attention with strong sideways gaze', () => {
    // Two of the 8 eye-look directions saturated — average gaze magnitude
    // ~0.225 after dead-zone, scaled into a partial attention reduction.
    // Sustained per-eye look in any direction reduces attention; full gaze
    // commitment in all directions is not physiologically meaningful.
    const score = computeAttention(0, 0, blendshapes({
      eyeLookOutLeft: 0.9, eyeLookInRight: 0.9,
    }))
    const baseline = computeAttention(0, 0, blendshapes({}))
    expect(score).toBeLessThan(baseline)
    expect(score).toBeLessThan(0.85)
  })

  test('attention monotonically decreases with yaw magnitude', () => {
    const a = computeAttention(0, 0, blendshapes({}))
    const b = computeAttention(0.2, 0, blendshapes({}))
    const c = computeAttention(0.4, 0, blendshapes({}))
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
  })
})

describe('expression', () => {
  test('strong smile when both mouth-smile shapes high', () => {
    const e = computeExpression(blendshapes({
      mouthSmileLeft: 0.8, mouthSmileRight: 0.85,
    }))
    expect(e.smile).toBeGreaterThan(0.8)
    expect(e.frown).toBe(0)
    expect(e.surprise).toBe(0)
  })

  test('surprise needs jaw drop AND brow raise', () => {
    const browOnly = computeExpression(blendshapes({ browInnerUp: 1 }))
    expect(browOnly.surprise).toBe(0)
    const jawOnly = computeExpression(blendshapes({ jawOpen: 1 }))
    expect(jawOnly.surprise).toBe(0)
    const both = computeExpression(blendshapes({ jawOpen: 0.7, browInnerUp: 0.6 }))
    expect(both.surprise).toBeGreaterThan(0.5)
  })

  test('concentration suppressed by smile', () => {
    const concentratingSmiling = computeExpression(blendshapes({
      browDownLeft: 0.8, browDownRight: 0.8, eyeSquintLeft: 0.4, eyeSquintRight: 0.4,
      mouthSmileLeft: 0.8, mouthSmileRight: 0.8,
    }))
    const concentratingNeutral = computeExpression(blendshapes({
      browDownLeft: 0.8, browDownRight: 0.8, eyeSquintLeft: 0.4, eyeSquintRight: 0.4,
    }))
    expect(concentratingSmiling.concentration).toBeLessThan(concentratingNeutral.concentration)
  })

  test('all outputs clamped to 0..1', () => {
    const e = computeExpression(blendshapes({
      jawOpen: 1, browInnerUp: 1, mouthSmileLeft: 1, mouthSmileRight: 1,
      mouthFrownLeft: 1, mouthFrownRight: 1, browDownLeft: 1, browDownRight: 1,
      eyeSquintLeft: 1, eyeSquintRight: 1,
    }))
    expect(e.smile).toBeLessThanOrEqual(1)
    expect(e.surprise).toBeLessThanOrEqual(1)
    expect(e.frown).toBeLessThanOrEqual(1)
    expect(e.concentration).toBeGreaterThanOrEqual(0)
    expect(e.concentration).toBeLessThanOrEqual(1)
  })
})

describe('presence', () => {
  test('zero faces → presence false', () => {
    expect(computePresence(0)).toEqual({ presence: false, faceCount: 0 })
  })
  test('two faces → presence true with count', () => {
    expect(computePresence(2)).toEqual({ presence: true, faceCount: 2 })
  })
  test('negative coerces to 0', () => {
    expect(computePresence(-3).faceCount).toBe(0)
  })
})

describe('blink tracker', () => {
  test('rate zero before any blinks', () => {
    const t = createBlinkTracker()
    expect(t.rate(1000)).toBe(0)
  })

  test('counts a high→low transition as one blink', () => {
    const t = createBlinkTracker()
    t.update(0.6, 0.7, 0)        // entering blink
    t.update(0.1, 0.1, 100)      // exiting → 1 blink
    expect(t.rate(100)).toBeGreaterThan(0)
  })

  test('multiple blinks raise the rate', () => {
    const t = createBlinkTracker()
    for (let i = 0; i < 5; i++) {
      t.update(0.7, 0.7, i * 1000)
      t.update(0.1, 0.1, i * 1000 + 50)
    }
    const r = t.rate(5000)
    // 5 blinks over ~5 s → ~60 bpm. Allow generous tolerance.
    expect(r).toBeGreaterThan(40)
    expect(r).toBeLessThan(120)
  })

  test('evicts blinks outside 30 s window', () => {
    const t = createBlinkTracker()
    // Blink at t=0
    t.update(0.7, 0.7, 0)
    t.update(0.1, 0.1, 50)
    // Query at t=60_000 — should be 0 (well past 30 s window)
    expect(t.rate(60_000)).toBe(0)
  })

  test('hysteresis: low values without crossing high threshold do not count', () => {
    const t = createBlinkTracker()
    t.update(0.4, 0.4, 0)        // below high threshold
    t.update(0.1, 0.1, 100)
    expect(t.rate(100)).toBe(0)
  })

  test('reset clears state', () => {
    const t = createBlinkTracker()
    t.update(0.7, 0.7, 0)
    t.update(0.1, 0.1, 50)
    t.reset()
    expect(t.rate(50)).toBe(0)
  })
})
