// ============================================================================
// Fenced code block extractor — finds CLOSED ```<lang>\n…\n``` blocks in
// agent response content. Used by the eval loop to validate ```map / ```geojson
// fences server-side before posting.
//
// Why "closed only": a bare opener regex would false-positive on agent
// meta-discussion of the skill body (e.g., the agent saying "you can use
// ```map fences for…"). Requiring an open+close pair eliminates that class
// of false positive — meta-discussion is almost always a single backtick
// triple followed by inline text, never followed by a paired closer + body.
//
// Pure function. Fenced blocks NOT matching the requested languages are
// ignored (they're someone else's problem — e.g., ```mermaid, ```python).
// ============================================================================

export interface FenceBlock {
  readonly language: string   // e.g. 'map' | 'geojson'
  readonly body: string       // content between the fences, no trailing newline
  readonly startLine: number  // 1-based source line of the opener — diagnostics
}

// Match an opener: optional indent + 3+ backticks + language identifier + newline.
// Backtick count is captured so the closer can require the same count (CommonMark).
const OPENER = /^([ \t]*)(`{3,})([a-zA-Z][a-zA-Z0-9_-]*)[ \t]*$/

export const extractFences = (
  content: string,
  languages: ReadonlyArray<string>,
): ReadonlyArray<FenceBlock> => {
  const wantSet = new Set(languages.map(l => l.toLowerCase()))
  const lines = content.split('\n')
  const out: FenceBlock[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const m = line.match(OPENER)
    if (!m) { i++; continue }
    const indent = m[1]!
    const ticks = m[2]!
    const lang = m[3]!.toLowerCase()
    // Closer: same indent + same number of backticks (or more) + nothing else.
    // CommonMark allows the closer to have MORE backticks than the opener;
    // we follow the rule to be lenient on agent output.
    const closerRe = new RegExp(`^${indent}\`{${ticks.length},}[ \\t]*$`)
    let j = i + 1
    while (j < lines.length && !closerRe.test(lines[j]!)) j++
    if (j >= lines.length) {
      // Unterminated fence — skip and resume scan after the opener.
      // (Agent might have truncated. Don't claim the whole rest of content
      // as one block.)
      i++
      continue
    }
    if (wantSet.has(lang)) {
      // Body lines are dedented by the opener's indent. CommonMark says
      // the indent of the opener applies to all interior lines.
      const bodyLines = lines.slice(i + 1, j).map(l => {
        if (indent.length > 0 && l.startsWith(indent)) return l.slice(indent.length)
        return l
      })
      out.push({
        language: lang,
        body: bodyLines.join('\n'),
        startLine: i + 1,
      })
    }
    i = j + 1
  }
  return out
}
