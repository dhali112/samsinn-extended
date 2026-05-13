import { describe, expect, test } from 'bun:test'
import { renderQueued, nextMermaidId } from './api.ts'
import type { MermaidApi } from './api.ts'

describe('renderQueued', () => {
  test('serializes concurrent renders — no re-entrant overlap', async () => {
    let active = 0
    let maxActive = 0
    const mockApi: MermaidApi = {
      initialize: () => {},
      render: async (id, _src) => {
        active += 1
        if (active > maxActive) maxActive = active
        // Simulate the real mermaid 11 bug: re-entry returns empty SVG.
        if (active > 1) {
          active -= 1
          return { svg: '' }
        }
        await new Promise(r => setTimeout(r, 5))
        active -= 1
        return { svg: `<svg id="${id}">ok</svg>` }
      },
    }
    const ids = ['a', 'b', 'c', 'd', 'e']
    const results = await Promise.all(ids.map(id =>
      renderQueued(mockApi, id, 'flowchart LR\nA-->B'),
    ))
    expect(maxActive).toBe(1)
    expect(results.every(r => r.svg.length > 0)).toBe(true)
    expect(results.map(r => r.svg)).toEqual(ids.map(id => `<svg id="${id}">ok</svg>`))
  })

  test('caller still sees rejection from its own render', async () => {
    const errMsg = 'parse error'
    const mockApi: MermaidApi = {
      initialize: () => {},
      render: async (id, _src) => {
        if (id === 'bad') throw new Error(errMsg)
        return { svg: `<svg id="${id}"/>` }
      },
    }
    const [r1, r2, r3] = await Promise.allSettled([
      renderQueued(mockApi, 'a', 's'),
      renderQueued(mockApi, 'bad', 's'),
      renderQueued(mockApi, 'c', 's'),
    ])
    expect(r1.status).toBe('fulfilled')
    expect(r2.status).toBe('rejected')
    expect((r2 as PromiseRejectedResult).reason.message).toBe(errMsg)
    // Critical: a failed render must not poison subsequent queue slots.
    expect(r3.status).toBe('fulfilled')
    if (r3.status === 'fulfilled') expect(r3.value.svg).toBe('<svg id="c"/>')
  })
})

describe('nextMermaidId', () => {
  test('monotonic across calls; respects optional prefix', () => {
    const a = nextMermaidId('mermaid')
    const b = nextMermaidId('mermaid')
    expect(a).not.toBe(b)
    const aNum = Number(a.split('-').pop())
    const bNum = Number(b.split('-').pop())
    expect(bNum).toBeGreaterThan(aNum)
    const retheme = nextMermaidId('mermaid-retheme')
    expect(retheme.startsWith('mermaid-retheme-')).toBe(true)
  })
})
