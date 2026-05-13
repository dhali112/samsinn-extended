import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseProcedure, PARSER_PROCMD_VERSION, ACCEPTED_PROCMD_VERSIONS } from './parser.ts'

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dir, 'fixtures', name), 'utf-8')

describe('procmd-core — version constants', () => {
  test('PARSER_PROCMD_VERSION is the current spec version', () => {
    expect(PARSER_PROCMD_VERSION).toBe('0.7')
  })
  test('ACCEPTED_PROCMD_VERSIONS is exactly 0.6 (no back-compat)', () => {
    expect([...ACCEPTED_PROCMD_VERSIONS]).toEqual(['0.7'])
  })
})

describe('procmd-core — E-0 fixture (v0.7)', () => {
  const result = parseProcedure(fixture('E-0.md'))
  if ('error' in result) throw new Error(`E-0 failed: ${result.error}`)
  const r = result

  test('frontmatter version handshake clean (no warning for v0.7 content)', () => {
    expect(r.warnings.filter(w => w.includes('procedure-md'))).toEqual([])
  })

  test('all v0.7 fields populated from real fixture', () => {
    expect(r.frontmatter.procedureId).toBe('E-0')
    expect(r.csfChannels.length).toBeGreaterThanOrEqual(6)
    expect(r.tagDefinitions.length).toBeGreaterThan(20)
    let withBecause = 0
    for (const s of r.steps) for (const b of s.branches) if (b.because) withBecause += 1
    expect(withBecause).toBeGreaterThan(0)
  })
})

describe('procmd-core — version handshake rejects unknown versions with a warning, still parses', () => {
  test('v0.5 (legacy) triggers warning, no error', () => {
    const src = `---
procedure-md: 0.5
procedure-id: LEGACY-1
title: Legacy
---
## Step 1 [id: x]
Check: ok
`
    const r = parseProcedure(src)
    if ('error' in r) throw new Error(r.error)
    expect(r.warnings.some(w => w.includes('0.5'))).toBe(true)
    expect(r.steps.length).toBe(1)
  })

  test('v99.9 (future) triggers warning, no error', () => {
    const src = `---
procedure-md: 99.9
procedure-id: FUTURE-1
title: Future
---
## Step 1 [id: x]
Check: ok
`
    const r = parseProcedure(src)
    if ('error' in r) throw new Error(r.error)
    expect(r.warnings.some(w => w.includes('99.9'))).toBe(true)
  })

  test('omitted procedure-md is fine', () => {
    const src = `---
procedure-id: NOVER-1
title: No version
---
## Step 1 [id: x]
Check: ok
`
    expect('error' in parseProcedure(src)).toBe(false)
  })
})

describe('procmd-core — v0.7 Decision: keyword', () => {
  const src = `---
type: procedure
procedure-md: 0.7
procedure-id: TEST-DECISION
title: Decision Test
profile: nuclear-erg
applies-to: anywhere
---

## Step 1 [id: identify-faulted-sg]
Decision: identify the faulted SG using the following paths in order
1. SG pressure dropping uncontrollably (highest priority signal)
2. Steam-line N-16 monitor «N16» elevated
3. Containment radiation rising with steam flow correlation
- Faulted SG identified → #isolate-faulted-sg
- No SG identified after exhausting paths → [[ECA-2.1]]
  Because: unidentified faulted SG with continuing depressurization escalates

## Step 2 [id: isolate-faulted-sg]
Action: close MSIV on identified faulted SG
`
  const r = parseProcedure(src)
  if ('error' in r) throw new Error(r.error)

  test('step.decision present with prologue + numbered paths', () => {
    const s = r.steps[0]!
    expect(s.decision).toBeDefined()
    expect(s.decision!.prologue).toContain('faulted SG using the following paths')
    expect(s.decision!.paths).toHaveLength(3)
    expect(s.decision!.paths[0]).toContain('SG pressure dropping')
    expect(s.decision!.paths[1]).toContain('N-16 monitor')
    expect(s.decision!.paths[2]).toContain('Containment radiation')
  })

  test('Decision: step still parses its branches normally', () => {
    const s = r.steps[0]!
    expect(s.branches).toHaveLength(2)
    expect(s.branches[0]!.target).toEqual({ kind: 'intra', stepId: 'isolate-faulted-sg' })
    expect(s.branches[1]!.target).toEqual({ kind: 'inter', procedureId: 'ECA-2.1' })
  })

  test('Because: still attaches to the preceding branch even after Decision paths', () => {
    const b = r.steps[0]!.branches[1]!
    expect(b.because).toContain('unidentified faulted SG')
  })

  test('Decision step counts as a decision (isDecision: true) even with no branches', () => {
    const synthetic = `---
procedure-id: D-2
title: D2
---
## Step 1 [id: x]
Decision: choose between alternatives
1. path A
2. path B
`
    const r2 = parseProcedure(synthetic)
    if ('error' in r2) throw new Error(r2.error)
    expect(r2.steps[0]!.isDecision).toBe(true)
    expect(r2.steps[0]!.decision!.paths).toHaveLength(2)
    expect(r2.steps[0]!.branches).toHaveLength(0)
  })

  test('Numbered list inside Decision does NOT leak as a tag reference', () => {
    expect(r.steps[0]!.tagsReferenced).toContain('N16')  // explicitly «N16»
    // No spurious tag IDs from path text
    expect(r.steps[0]!.tagsReferenced.length).toBe(1)
  })

  test('Path collection ends before normal body keywords resume', () => {
    const src2 = `---
procedure-id: D-3
title: D3
---
## Step 1 [id: x]
Decision: identify path
1. path A
Caution: do not exceed limit
- ok → END
`
    const r3 = parseProcedure(src2)
    if ('error' in r3) throw new Error(r3.error)
    expect(r3.steps[0]!.decision!.paths).toEqual(['path A'])
    expect(r3.steps[0]!.cautions).toContain('do not exceed limit')
    expect(r3.steps[0]!.branches).toHaveLength(1)
  })
})

// H.2: feature-focused fixtures. One file per procmd v0.7 language feature.
// Adding a feature without a fixture here means the renderer-parity contract
// (golden output on the same input in both consumers) has no anchor.
describe('procmd-core — feat-decision fixture', () => {
  const r = parseProcedure(fixture('feat-decision.md'))
  if ('error' in r) throw new Error(`feat-decision: ${r.error}`)
  test('Decision: step is flagged isDecision', () => {
    expect(r.steps[0]!.isDecision).toBe(true)
  })
  test('Decision-style branches preserve Because: and Against: rationale', () => {
    const branches = r.steps[0]!.branches
    expect(branches.length).toBe(3)
    const withBecause = branches.filter(b => b.because).length
    const withAgainst = branches.filter(b => b.against).length
    expect(withBecause).toBeGreaterThanOrEqual(2)
    expect(withAgainst).toBeGreaterThanOrEqual(1)
  })
})

describe('procmd-core — feat-within fixture', () => {
  const r = parseProcedure(fixture('feat-within.md'))
  if ('error' in r) throw new Error(`feat-within: ${r.error}`)
  test('Within: lifecycle keyword surfaces on the step', () => {
    expect(r.steps[0]!.withins).toEqual(['60 s'])
  })
  test('inline tag ref «SUB-MARGIN» is captured', () => {
    expect(r.steps[0]!.tagsReferenced).toContain('SUB-MARGIN')
  })
  test('Tags appendix yields a definition with sim-path / units / equipment', () => {
    const def = r.tagDefinitions.find(t => t.id === 'SUB-MARGIN')!
    expect(def.simPath).toBe('rcs.subcooling')
    expect(def.units).toBe('degF')
    expect(def.equipment).toBe('rcs')
  })
})

describe('procmd-core — feat-caution-note fixture', () => {
  const r = parseProcedure(fixture('feat-caution-note.md'))
  if ('error' in r) throw new Error(`feat-caution-note: ${r.error}`)
  test('Caution: and Note: are first-class keyword lists on the step', () => {
    expect(r.steps[0]!.cautions.length).toBe(1)
    expect(r.steps[0]!.cautions[0]).toMatch(/pressurizer pressure/i)
    expect(r.steps[0]!.notes.length).toBe(1)
    expect(r.steps[0]!.notes[0]).toMatch(/informational/i)
  })
})

describe('procmd-core — feat-freetext-branch fixture', () => {
  const r = parseProcedure(fixture('feat-freetext-branch.md'))
  if ('error' in r) throw new Error(`feat-freetext-branch: ${r.error}`)
  test('free-text branch target parses to kind freeText', () => {
    const ft = r.steps[0]!.branches.find(b => b.target.kind === 'freeText')
    expect(ft).toBeDefined()
    if (ft && ft.target.kind === 'freeText') {
      expect(ft.target.text).toMatch(/SAMG/)
    }
  })
  test('intra-page branch resolves to a sibling step id', () => {
    const intra = r.steps[0]!.branches.find(b => b.target.kind === 'intra')
    expect(intra).toBeDefined()
    if (intra && intra.target.kind === 'intra') {
      expect(intra.target.stepId).toBe('continue')
    }
  })
})
