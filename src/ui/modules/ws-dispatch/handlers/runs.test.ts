import { beforeEach, describe, expect, test } from 'bun:test'
import { $activeScriptByRoom, $agents, $rooms, type ActiveScript } from '../../stores.ts'

const activeScript: ActiveScript = {
  scriptId: 'script-1',
  scriptName: 'demo',
  title: 'Demo',
  stepIndex: 0,
  totalSteps: 1,
  stepTitle: 'Opening',
  readiness: {},
  readyStreak: {},
  whisperFailures: 0,
  lastWhisper: {},
  stepLogs: {},
  cast: [
    { id: 'cast-1', name: 'Alex', model: 'test-model', persona: 'Alex persona', starts: true },
    { id: 'cast-2', name: 'Sam', model: 'test-model', persona: 'Sam persona', starts: false },
  ],
  steps: [{ title: 'Opening', roles: { Alex: 'start', Sam: 'respond' } }],
  ended: false,
}

describe('runHandlers.script_completed', () => {
  beforeEach(() => {
    const fakeElement = {
      classList: { add: () => {}, remove: () => {}, toggle: () => false },
      style: {},
      dataset: {},
      textContent: '',
      value: '',
      checked: false,
      innerHTML: '',
      addEventListener: () => {},
      removeEventListener: () => {},
      appendChild: () => {},
      setAttribute: () => {},
      querySelector: () => null,
      showModal: () => {},
      close: () => {},
    }
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        body: fakeElement,
        createElement: () => ({ ...fakeElement }),
        getElementById: () => fakeElement,
        querySelector: () => fakeElement,
      },
    })
    $rooms.set({})
    $agents.set({})
    $activeScriptByRoom.set({})
  })

  test('marks the script ended and removes temporary cast agents from the UI store', async () => {
    const { runHandlers } = await import('./runs.ts')
    $rooms.setKey('room-1', { id: 'room-1', name: 'Script Room', createdAt: 0, createdBy: 'test' })
    $agents.setKey('cast-1', { id: 'cast-1', name: 'Alex', kind: 'ai', model: 'test-model', state: 'idle' })
    $agents.setKey('cast-2', { id: 'cast-2', name: 'Sam', kind: 'ai', model: 'test-model', state: 'idle' })
    $agents.setKey('keeper', { id: 'keeper', name: 'Keeper', kind: 'human', state: 'idle' })
    $activeScriptByRoom.setKey('room-1', activeScript)

    runHandlers.script_completed!({
      type: 'script_completed',
      roomName: 'Script Room',
      scriptId: 'script-1',
    })

    expect($activeScriptByRoom.get()['room-1']?.ended).toBe(true)
    expect($agents.get()['cast-1']).toBeUndefined()
    expect($agents.get()['cast-2']).toBeUndefined()
    expect($agents.get()['keeper']).toBeDefined()
  })
})
