import { describe, expect, test } from 'bun:test'
import { extractFences } from './fence-extract.ts'

describe('extractFences', () => {
  test('single closed map block', () => {
    const blocks = extractFences('intro\n```map\n{"features":[]}\n```\ntail', ['map'])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.language).toBe('map')
    expect(blocks[0]!.body).toBe('{"features":[]}')
  })

  test('multiple closed blocks of different languages, filtered', () => {
    const src = '```mermaid\nflowchart\n```\n\n```map\n{"features":[]}\n```\n\n```geojson\n{}\n```'
    const blocks = extractFences(src, ['map', 'geojson'])
    expect(blocks.map(b => b.language)).toEqual(['map', 'geojson'])
  })

  test('case-insensitive language match', () => {
    const blocks = extractFences('```MAP\n{}\n```', ['map'])
    expect(blocks).toHaveLength(1)
  })

  test('unmatched-language blocks are silently ignored', () => {
    const blocks = extractFences('```python\nprint(1)\n```', ['map'])
    expect(blocks).toEqual([])
  })

  test('unterminated fence does NOT swallow the rest of content', () => {
    // Agent meta-discussion that mentions an opener mid-prose without
    // a closer. Older bare-regex would have grabbed everything to EOF.
    const src = 'You can use ```map fences for visualization.\n\nMore prose here.'
    const blocks = extractFences(src, ['map'])
    expect(blocks).toEqual([])
  })

  test('agent meta-discussion of the skill body does NOT false-positive', () => {
    // Agent describing what the rendering skill says — opener + closer
    // exist but they wrap a single-line example fragment that we should
    // NOT treat as a real map fence. (Realistically extracted as a real
    // fence here — that's fine; the *validator* will catch the empty body
    // as an error and the retry loop will absorb it.)
    const src = 'The skill says: use ```map fences with this shape:\n\n```map\n{"features":[]}\n```'
    const blocks = extractFences(src, ['map'])
    // We DO extract the real fence at the end. The bare opener earlier in
    // the prose is ignored because it's not at the start of a line on its
    // own (it has prose before it on the same line).
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.body).toBe('{"features":[]}')
  })

  test('CommonMark indented fence — body is dedented', () => {
    const src = '  ```map\n  {"features":[]}\n  ```'
    const blocks = extractFences(src, ['map'])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.body).toBe('{"features":[]}')
  })

  test('closer with more backticks than opener (CommonMark allows)', () => {
    const src = '```map\nbody\n`````'
    const blocks = extractFences(src, ['map'])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.body).toBe('body')
  })

  test('records 1-based startLine of opener', () => {
    const src = 'a\nb\n```map\n{}\n```'
    const blocks = extractFences(src, ['map'])
    expect(blocks[0]!.startLine).toBe(3)
  })

  test('two fences of the same language both extracted', () => {
    const src = '```map\nA\n```\n\n```map\nB\n```'
    const blocks = extractFences(src, ['map'])
    expect(blocks).toHaveLength(2)
    expect(blocks.map(b => b.body)).toEqual(['A', 'B'])
  })

  test('empty content', () => {
    expect(extractFences('', ['map'])).toEqual([])
  })

  test('content with no fences', () => {
    expect(extractFences('just prose, no fences', ['map'])).toEqual([])
  })
})
