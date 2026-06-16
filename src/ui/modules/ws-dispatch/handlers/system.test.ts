import { describe, expect, test } from 'bun:test'
import { systemHandlers } from './system.ts'

describe('systemHandlers.reset_committed', () => {
  test('fans reset completion out as a CustomEvent', () => {
    const events: Array<{ readonly type: string; readonly detail: unknown }> = []
    const globalScope = globalThis as typeof globalThis & { window?: Pick<Window, 'dispatchEvent'> }
    const hadWindow = Object.prototype.hasOwnProperty.call(globalScope, 'window')
    const originalWindow = globalScope.window

    Object.defineProperty(globalScope, 'window', {
      configurable: true,
      value: {
        dispatchEvent: (event: Event): boolean => {
          events.push({
            type: event.type,
            detail: event instanceof CustomEvent ? event.detail : undefined,
          })
          return true
        },
      },
    })

    try {
      systemHandlers.reset_committed!({
        type: 'reset_committed',
        oldId: 'old-instance',
        newId: 'new-instance',
      })
    } finally {
      if (hadWindow) {
        Object.defineProperty(globalScope, 'window', {
          configurable: true,
          value: originalWindow,
        })
      } else {
        delete globalScope.window
      }
    }

    expect(events).toEqual([{
      type: 'reset-committed',
      detail: { oldId: 'old-instance', newId: 'new-instance' },
    }])
  })
})
