import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { modelSupportsImages, imagePlaceholder, warnImageDroppedOnce, __resetMultimodalWarnTracker } from './multimodal.ts'

describe('modelSupportsImages', () => {
  test('recognizes known multimodal OpenAI models', () => {
    expect(modelSupportsImages('gpt-4o')).toBe(true)
    expect(modelSupportsImages('gpt-4o-mini')).toBe(true)
    expect(modelSupportsImages('gpt-5.4')).toBe(true)
  })
  test('recognizes Anthropic vision models', () => {
    expect(modelSupportsImages('claude-3-5-sonnet')).toBe(true)
    expect(modelSupportsImages('claude-3.5-sonnet-20241022')).toBe(true)
    expect(modelSupportsImages('claude-sonnet-4-20250514')).toBe(true)
  })
  test('recognizes Gemini vision models', () => {
    expect(modelSupportsImages('gemini-1.5-pro')).toBe(true)
    expect(modelSupportsImages('gemini-2-flash')).toBe(true)
  })
  test('strips provider prefix before matching', () => {
    expect(modelSupportsImages('openai:gpt-4o-mini')).toBe(true)
    expect(modelSupportsImages('anthropic:claude-3-5-sonnet')).toBe(true)
  })
  test('returns false for text-only models', () => {
    expect(modelSupportsImages('llama3.2')).toBe(false)
    expect(modelSupportsImages('mistral-7b')).toBe(false)
    expect(modelSupportsImages('')).toBe(false)
    expect(modelSupportsImages('gpt-3.5-turbo')).toBe(false)
  })
})

describe('modelSupportsImages — catalog tier', () => {
  // Catalogued vision models should be recognized via catalog, not just
  // substring. (The substring path would already cover gpt-4o etc; the
  // tier-1 catalog lookup is the new authoritative source.)
  test('catalogued vision models return true', () => {
    expect(modelSupportsImages('openai:gpt-5.4')).toBe(true)
    expect(modelSupportsImages('anthropic:claude-haiku-4-5')).toBe(true)
    expect(modelSupportsImages('gemini:gemini-2.5-flash')).toBe(true)
  })
  test('catalogued text-only models return false even if name superficially looks vision-y', () => {
    // moonshot-v1-* is in the catalog with supportsImages: false.
    // The substring allowlist would have matched 'moonshot' if it had one
    // (it doesn't, but this asserts the contract).
    expect(modelSupportsImages('kimi:moonshot-v1-128k')).toBe(false)
    expect(modelSupportsImages('groq:llama-3.3-70b-versatile')).toBe(false)
    expect(modelSupportsImages('mistral:mistral-large-latest')).toBe(false)
  })
  test('uncatalogued models fall back to substring allowlist', () => {
    // Not in the curated catalog → substring path.
    expect(modelSupportsImages('llama-3.2-vision-90b')).toBe(true)   // matches 'llama-3.2-vision'
    expect(modelSupportsImages('pixtral-large')).toBe(true)          // matches 'pixtral'
    expect(modelSupportsImages('random-future-flagship')).toBe(false) // no match either tier
  })
})

describe('warnImageDroppedOnce', () => {
  const orig = console.warn
  let captured: string[] = []
  beforeEach(() => {
    captured = []
    console.warn = (...args: unknown[]) => { captured.push(args.map(a => String(a)).join(' ')) }
    __resetMultimodalWarnTracker()
  })
  afterEach(() => { console.warn = orig })

  test('first call for a (model, callerId) fires once', () => {
    warnImageDroppedOnce('gpt-6-future', 'agent-a', 1, 'image/png 800×600')
    expect(captured.length).toBe(1)
    expect(captured[0]).toContain('model=gpt-6-future')
    expect(captured[0]).toContain('caller=agent-a')
    expect(captured[0]).toContain('dropped 1 image(s)')
  })

  test('subsequent calls with same (model, callerId) do NOT fire', () => {
    warnImageDroppedOnce('gpt-6-future', 'agent-a', 1, 'x')
    warnImageDroppedOnce('gpt-6-future', 'agent-a', 3, 'y')
    expect(captured.length).toBe(1)
  })

  test('different caller fires fresh warn', () => {
    warnImageDroppedOnce('gpt-6-future', 'agent-a', 1, 'x')
    warnImageDroppedOnce('gpt-6-future', 'agent-b', 1, 'x')
    expect(captured.length).toBe(2)
  })

  test('different model fires fresh warn', () => {
    warnImageDroppedOnce('gpt-6-future', 'agent-a', 1, 'x')
    warnImageDroppedOnce('claude-7-future', 'agent-a', 1, 'x')
    expect(captured.length).toBe(2)
  })

  test('reset tracker re-arms', () => {
    warnImageDroppedOnce('gpt-6-future', 'agent-a', 1, 'x')
    expect(captured.length).toBe(1)
    __resetMultimodalWarnTracker()
    warnImageDroppedOnce('gpt-6-future', 'agent-a', 1, 'x')
    expect(captured.length).toBe(2)
  })
})

describe('imagePlaceholder', () => {
  test('produces a descriptive placeholder string', () => {
    const text = imagePlaceholder({ width: 1024, height: 768, mimeType: 'image/png', source: 'leitbild' })
    expect(text).toContain('1024')
    expect(text).toContain('768')
    expect(text).toContain('leitbild')
    expect(text).toContain('cannot view')
  })
  test('handles missing source gracefully', () => {
    const text = imagePlaceholder({ width: 100, height: 100, mimeType: 'image/png' })
    expect(text).toContain('image/png')
    expect(text).not.toContain('()')
  })
})
