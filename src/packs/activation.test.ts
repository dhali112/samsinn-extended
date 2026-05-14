import { describe, expect, test } from 'bun:test'
import { effectiveActivePacks, effectiveActivePackSet, isPackActiveInRoom } from './activation.ts'

// v24: room.activePacks IS the truth. The resolver is a passthrough — there
// is no implicit augmentation. System packs are seeded into a room's
// activePacks at construction (see src/core/rooms/room.ts) and the
// activation route refuses to drop them.

const room = (packs: string[]) => ({ getActivePacks: () => packs })

describe('effectiveActivePacks', () => {
  test('empty room → empty list (no implicit augmentation)', () => {
    expect(effectiveActivePacks(room([]))).toEqual([])
  })

  test('returns exactly what the room reports', () => {
    expect(effectiveActivePacks(room(['core', 'local', 'demos', 'pwr-ops', 'aviation'])))
      .toEqual(['core', 'local', 'demos', 'pwr-ops', 'aviation'])
  })

  test('preserves order verbatim', () => {
    expect(effectiveActivePacks(room(['z', 'a', 'm']))).toEqual(['z', 'a', 'm'])
  })
})

describe('effectiveActivePackSet', () => {
  test('mirrors room.activePacks as a Set', () => {
    const s = effectiveActivePackSet(room(['core', 'local', 'aviation']))
    expect(s.has('core')).toBe(true)
    expect(s.has('local')).toBe(true)
    expect(s.has('aviation')).toBe(true)
    expect(s.has('cafes')).toBe(false)
  })

  test('empty room → empty set', () => {
    expect(effectiveActivePackSet(room([])).size).toBe(0)
  })
})

describe('isPackActiveInRoom', () => {
  test('present in activePacks → true', () => {
    expect(isPackActiveInRoom(room(['core', 'local']), 'core')).toBe(true)
    expect(isPackActiveInRoom(room(['core', 'local']), 'local')).toBe(true)
  })

  test('absent → false (even for system packs — v24 does not implicitly add)', () => {
    expect(isPackActiveInRoom(room([]), 'core')).toBe(false)
    expect(isPackActiveInRoom(room(['aviation']), 'cafes')).toBe(false)
  })
})
