// ============================================================================
// Minimal YAML-subset parser for scenario op blocks.
//
// Generic shape only — no scenario-specific knowledge lives here. Two forms:
//
//   Inline object:   { key: value, key: "value with spaces", arr: [a, b] }
//   Block object:    indented `key: value` lines, with `key: |` block scalars
//
// Strings: bare identifier, double-quoted, or single-quoted. No escape
// sequence interpretation (use the YAML block scalar `|` for multiline
// content). Numbers: integer + decimal. Booleans: `true` / `false`. `null`.
// Arrays: inline `[a, b, c]` only.
//
// Why hand-rolled instead of pulling in `js-yaml`: the project policy is
// zero runtime deps where reasonable, and the ~250 LOC subset is enough
// for every authored scenario shape we expect.
// ============================================================================

import { ScenarioParseError } from './errors.ts'

// === Primitives shared with parser.ts ===

// Strip a single matching pair of double or single quotes. Used in the
// frontmatter parser too — exported so parser.ts doesn't reimplement it.
export const unquote = (raw: string): string => {
  const t = raw.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1)
  }
  return t
}

// === Inline object: { k: v, k: "v with spaces" } ===

export const parseInlineObject = (raw: string, absLine: number): Record<string, unknown> => {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    throw new ScenarioParseError(`expected "{...}" inline object, got "${raw}"`, absLine)
  }
  const inner = trimmed.slice(1, -1).trim()
  if (inner.length === 0) return {}
  const out: Record<string, unknown> = {}
  // Tokenize by top-level commas, respecting double-quoted, single-quoted,
  // and { } / [ ] nesting.
  const parts = splitTopLevel(inner, ',', absLine)
  for (const part of parts) {
    const colonIdx = findUnquotedColon(part)
    if (colonIdx === -1) {
      throw new ScenarioParseError(`inline object field missing ":" in "${part}"`, absLine)
    }
    const key = part.slice(0, colonIdx).trim()
    const val = part.slice(colonIdx + 1).trim()
    out[key] = parseInlineValue(val, absLine)
  }
  return out
}

export const parseInlineValue = (raw: string, absLine: number): unknown => {
  if (raw.length === 0) return ''
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null') return null
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) return raw.slice(1, -1)
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1)
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (inner.length === 0) return []
    return splitTopLevel(inner, ',', absLine).map(p => parseInlineValue(p.trim(), absLine))
  }
  if (raw.startsWith('{') && raw.endsWith('}')) return parseInlineObject(raw, absLine)
  // Number — strict regex so `0x10`, `123abc`, `1.2.3` fall through to bare-string.
  const n = Number(raw)
  if (!Number.isNaN(n) && /^-?\d+(\.\d+)?$/.test(raw)) return n
  // Bare identifier — treat as string.
  return raw
}

// Split a string on a separator that appears at top level only (i.e. not
// inside quotes or brackets). Backslash escapes within strings are skipped
// but not interpreted.
export const splitTopLevel = (s: string, sep: string, absLine: number): string[] => {
  const out: string[] = []
  let depth = 0
  let inDouble = false
  let inSingle = false
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inDouble) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inDouble = false
      continue
    }
    if (inSingle) {
      if (ch === '\\') { i++; continue }
      if (ch === "'") inSingle = false
      continue
    }
    if (ch === '"') { inDouble = true; continue }
    if (ch === "'") { inSingle = true; continue }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') depth--
    else if (depth === 0 && ch === sep) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  if (depth !== 0) throw new ScenarioParseError(`unbalanced brackets in "${s}"`, absLine)
  if (inDouble || inSingle) throw new ScenarioParseError(`unterminated string in "${s}"`, absLine)
  out.push(s.slice(start))
  return out
}

// Find the first colon that is NOT inside a quoted string. Used to split
// `key: value` pairs without choking on values that contain colons.
export const findUnquotedColon = (s: string): number => {
  let inDouble = false
  let inSingle = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (inDouble) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') inDouble = false
      continue
    }
    if (inSingle) {
      if (ch === '\\') { i++; continue }
      if (ch === "'") inSingle = false
      continue
    }
    if (ch === '"') { inDouble = true; continue }
    if (ch === "'") { inSingle = true; continue }
    if (ch === ':') return i
  }
  return -1
}

// === Block object: indented `key: value` and `key: |` block scalars ===

export const parseBlockObject = (lines: ReadonlyArray<string>, startAbsLine: number): Record<string, unknown> => {
  const nonEmpty = lines.filter(l => l.trim() !== '')
  if (nonEmpty.length === 0) return {}
  // Base indent = leading whitespace of first non-empty line.
  const firstIndent = (nonEmpty[0]!.match(/^(\s*)/)?.[1] ?? '').length

  const out: Record<string, unknown> = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.trim() === '') { i++; continue }
    const indent = (line.match(/^(\s*)/)?.[1] ?? '').length
    if (indent !== firstIndent) {
      throw new ScenarioParseError(
        `block-object field at unexpected indent (got ${indent}, want ${firstIndent})`,
        startAbsLine + i,
      )
    }
    const m = line.slice(firstIndent).match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/)
    if (!m) {
      throw new ScenarioParseError(`expected "key: value", got "${line}"`, startAbsLine + i)
    }
    const key = m[1]!
    const rawVal = m[2]!.trim()

    if (rawVal === '|') {
      // Block scalar: collect subsequent lines indented MORE than firstIndent.
      let j = i + 1
      let innerIndent = -1
      const buf: string[] = []
      while (j < lines.length) {
        const nl = lines[j]!
        if (nl.trim() === '') { buf.push(''); j++; continue }
        const ind = (nl.match(/^(\s*)/)?.[1] ?? '').length
        if (ind <= firstIndent) break
        if (innerIndent === -1) innerIndent = ind
        buf.push(nl.slice(innerIndent))
        j++
      }
      // Strip trailing blank lines inside the scalar block.
      while (buf.length > 0 && buf[buf.length - 1] === '') buf.pop()
      out[key] = buf.join('\n')
      i = j
      continue
    }

    if (rawVal.startsWith('{') || rawVal.startsWith('[')) {
      out[key] = parseInlineValue(rawVal, startAbsLine + i)
      i++
      continue
    }

    if (rawVal.length > 0) {
      out[key] = parseInlineValue(rawVal, startAbsLine + i)
      i++
      continue
    }

    // Empty value with no `|` — treat as empty string (forgiving).
    out[key] = ''
    i++
  }
  return out
}
