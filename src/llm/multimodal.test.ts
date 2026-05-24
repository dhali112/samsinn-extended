import { describe, expect, test } from 'bun:test'
import { modelSupportsImages, imagePlaceholder } from './multimodal.ts'

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
