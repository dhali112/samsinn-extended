// Pure function — easy to verify with real message fixtures.

import { describe, expect, test } from 'bun:test'
import type { Message } from '../types/messaging.ts'
import { redactBiometricMessages } from './snapshot-redact.ts'

const baseMessage = (overrides: Partial<Message>): Message => ({
  id: 'm1',
  senderId: 'sys',
  content: 'hello',
  timestamp: 1000,
  type: 'system',
  roomId: 'r1',
  ...overrides,
})

describe('redactBiometricMessages', () => {
  test('replaces content of biometric-caused messages', () => {
    const out = redactBiometricMessages([
      baseMessage({ id: 'a', cause: { kind: 'biometric', name: 'cap_1' } }),
    ])
    expect(out[0]!.content).toBe('[biometric capture — not persisted]')
  })

  test('preserves cause field and id continuity', () => {
    const m = baseMessage({ id: 'a', cause: { kind: 'biometric', name: 'cap_1' } })
    const out = redactBiometricMessages([m])
    expect(out[0]!.id).toBe('a')
    expect(out[0]!.cause).toEqual({ kind: 'biometric', name: 'cap_1' })
  })

  test('does not redact other cause kinds', () => {
    const out = redactBiometricMessages([
      baseMessage({ content: 'kept', cause: { kind: 'script', name: 's', step: 0 } }),
      baseMessage({ content: 'kept too', cause: { kind: 'scenario', name: 'demo' } }),
      baseMessage({ content: 'kept three', cause: { kind: 'trigger', name: 't' } }),
    ])
    expect(out[0]!.content).toBe('kept')
    expect(out[1]!.content).toBe('kept too')
    expect(out[2]!.content).toBe('kept three')
  })

  test('does not redact messages without cause', () => {
    const out = redactBiometricMessages([baseMessage({ content: 'plain' })])
    expect(out[0]!.content).toBe('plain')
  })

  test('preserves order and length', () => {
    const ms = [
      baseMessage({ id: 'a', content: 'one' }),
      baseMessage({ id: 'b', content: 'two', cause: { kind: 'biometric', name: 'c' } }),
      baseMessage({ id: 'c', content: 'three' }),
    ]
    const out = redactBiometricMessages(ms)
    expect(out).toHaveLength(3)
    expect(out.map(m => m.id)).toEqual(['a', 'b', 'c'])
    expect(out[0]!.content).toBe('one')
    expect(out[2]!.content).toBe('three')
  })
})
