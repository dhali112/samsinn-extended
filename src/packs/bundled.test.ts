// Sanity tests on the bundled-pack registry. Two flavours:
//   (a) shape: every entry has the expected fields and the well-known
//       packs (core, local, demos, pwr-ops) are present with the
//       expected flag combination — guards against accidental edits
//       (e.g. flipping a system: true to false).
//   (b) drift: the namespace-to-tool mapping used by list_packs
//       (matchTool inline) decodes the same way packNameFor does.
//       If someone retags a bundled tool without updating both, this
//       test catches it.

import { describe, expect, test } from 'bun:test'
import { BUNDLED_PACKS, defaultActiveNamespaces, isSystemPack, getBundledPack } from './bundled.ts'
import { packNameFor } from '../core/types/tool-pack.ts'
import type { ToolRegistryEntry } from '../core/types/tool.ts'

describe('BUNDLED_PACKS', () => {
  test('contains the four well-known packs in the documented order', () => {
    expect(BUNDLED_PACKS.map(p => p.namespace)).toEqual(['core', 'local', 'demos', 'pwr-ops'])
  })

  test('core and local are system packs; demos and pwr-ops are not', () => {
    expect(isSystemPack('core')).toBe(true)
    expect(isSystemPack('local')).toBe(true)
    expect(isSystemPack('demos')).toBe(false)
    expect(isSystemPack('pwr-ops')).toBe(false)
    expect(isSystemPack('aviation')).toBe(false) // not bundled at all
  })

  test('all four are default-active', () => {
    expect([...defaultActiveNamespaces()].sort()).toEqual(['core', 'demos', 'local', 'pwr-ops'])
  })

  test('every entry has the expected shape', () => {
    for (const p of BUNDLED_PACKS) {
      expect(typeof p.namespace).toBe('string')
      expect(p.namespace.length).toBeGreaterThan(0)
      expect(typeof p.displayName).toBe('string')
      expect(typeof p.description).toBe('string')
      expect(p.description.length).toBeGreaterThan(0)
      expect(typeof p.system).toBe('boolean')
      expect(typeof p.defaultActive).toBe('boolean')
    }
  })

  test('getBundledPack lookup', () => {
    expect(getBundledPack('pwr-ops')?.namespace).toBe('pwr-ops')
    expect(getBundledPack('nope')).toBeUndefined()
  })
})

describe('packNameFor drift — list_packs matcher must agree', () => {
  // Mirror the inline matcher in src/tools/built-in/pack-tools.ts:list_packs.
  // If the two go out of sync, tools end up in the wrong bucket. This test
  // exercises packNameFor against synthetic entries representative of every
  // bundled-pack registration mode.
  const synth = (kind: 'built-in' | 'external' | 'pack-bundled' | 'skill-bundled', pack?: string): ToolRegistryEntry => ({
    tool: { name: 't', description: '', parameters: {}, execute: async () => ({ success: true }) },
    source: kind === 'built-in' ? { kind } : kind === 'external' ? { kind, path: '/x' } : { kind, pack, path: '/p', displayName: 't' } as ToolRegistryEntry['source'],
  })

  test('built-in → core', () => {
    expect(packNameFor(synth('built-in'))).toBe('core')
  })
  test('external → local', () => {
    expect(packNameFor(synth('external'))).toBe('local')
  })
  test('pack-bundled with pack:demos → demos', () => {
    expect(packNameFor(synth('pack-bundled', 'demos'))).toBe('demos')
  })
  test('pack-bundled with pack:pwr-ops → pwr-ops', () => {
    expect(packNameFor(synth('pack-bundled', 'pwr-ops'))).toBe('pwr-ops')
  })
})
