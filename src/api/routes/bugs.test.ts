import { describe, test, expect } from 'bun:test'
import { buildIssueBody } from './bugs.ts'

describe('buildIssueBody — A5 markdown sanitisation', () => {
  test('wraps user description in a 4-tilde code fence', () => {
    const body = buildIssueBody('plain text', '0.1.0', 'TestUA')
    expect(body).toContain('~~~~\nplain text\n~~~~')
  })

  test('@user mentions inside the fence do not fire on GitHub', () => {
    // GitHub does not parse @-mentions inside code blocks. Asserting the
    // mention is INSIDE the fence is the contract — GitHub renderer is
    // out of our test scope, but the structural property is what matters.
    const body = buildIssueBody('cc @torvalds @gvanrossum please review', '0.1.0', 'UA')
    const fenceStart = body.indexOf('~~~~\n')
    const fenceEnd = body.lastIndexOf('\n~~~~')
    expect(fenceStart).toBeGreaterThanOrEqual(0)
    expect(fenceEnd).toBeGreaterThan(fenceStart)
    const inside = body.slice(fenceStart + 5, fenceEnd)
    expect(inside).toContain('@torvalds')
    expect(inside).toContain('@gvanrossum')
  })

  test('#123 cross-refs and owner/repo#42 are inside the fence', () => {
    const body = buildIssueBody('Related: #42 othermaintainer/somerepo#7', '0.1.0', 'UA')
    expect(body).toContain('~~~~\nRelated: #42 othermaintainer/somerepo#7\n~~~~')
  })

  test('embedded ~~~~ in description is replaced with ~~~ before wrapping', () => {
    // Defence against deliberate fence-escape attempts. After replacement,
    // the wrapper's 4-tilde fence still cleanly delimits the content.
    const body = buildIssueBody('breakout~~~~ attempt\n~~~~~ five tildes', '0.1.0', 'UA')
    expect(body).not.toContain('breakout~~~~')
    expect(body).toContain('breakout~~~ attempt')
    expect(body).toContain('~~~ five tildes')
    // Outer fence intact — the body still starts/ends with 4-tilde markers.
    expect(body.match(/^[\s\S]*?\n~~~~\n/)).toBeTruthy()
    expect(body).toMatch(/\n~~~~\n\n---/)
  })

  test('triple-backticks in description survive (the 4-tilde fence wraps them)', () => {
    const body = buildIssueBody('```js\nconst x = 1\n```', '0.1.0', 'UA')
    // Triple-backticks pass through unchanged since the outer fence is 4
    // tildes. GitHub will render them as a nested literal inside a code
    // block — i.e. plain text, no syntax highlighting.
    expect(body).toContain('```js')
    expect(body).toContain('```')
    // Outer fence unbroken.
    expect(body.split(/\n~~~~\n/).length).toBeGreaterThanOrEqual(3)
  })

  test('user agent over 500 chars is truncated', () => {
    const longUA = 'X'.repeat(800)
    const body = buildIssueBody('desc', '0.1.0', longUA)
    expect(body).toContain('user agent: `' + 'X'.repeat(500) + '…`')
  })

  test('falls back to "unknown" when version or user-agent is empty', () => {
    const body = buildIssueBody('desc', '', '')
    expect(body).toContain('samsinn version: `unknown`')
    expect(body).toContain('user agent: `unknown`')
  })
})
