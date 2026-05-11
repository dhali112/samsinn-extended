// Budget cap — Layer 4 of the Tool Surface Manager.
//
// Enforces a hard ceiling on total tool-definition tokens sent to the LLM.
// Layers 1 (family compression) already does most of the heavy lifting;
// this is a safety net for pathological cases:
//   - 10 packs installed in one room with no compressible families
//   - A user-authored tool with a 2k-token description
//   - Some future addition that quietly bloats the surface
//
// When the cap triggers, core tools and family dispatchers are exempt
// (they're either essential conversational primitives or the result of
// compression we don't want to undo). Remaining tools are kept in
// registration order until the budget is exhausted; the rest are dropped
// with a rate-limited WARN log so ops notice.
//
// Token estimation uses the standard 4-chars-per-token approximation. Fast,
// no tokenizer dependency, accurate enough for budget arithmetic where the
// goal is "stay under N", not "report exact token count".

import type { ToolDefinition } from '../core/types/tool.ts'
import { CORE_TOOL_NAMES, FAMILY_DISPATCHER_NAMES } from './families.ts'

export const DEFAULT_TOOL_TOKEN_BUDGET = 2000

// Names that are never trimmed regardless of the cap. The union of:
//   - CORE_TOOL_NAMES (always-on conversational tools)
//   - FAMILY_DISPATCHER_NAMES (the result of compression — re-trimming
//     would undo Layer 1)
const ALWAYS_KEEP: ReadonlySet<string> = new Set([
  ...CORE_TOOL_NAMES,
  ...FAMILY_DISPATCHER_NAMES,
])

// Approximate token count for a tool definition. ~4 chars per token is the
// rule of thumb for English JSON; close enough for budget comparison.
// Underestimates verbose schemas with deep nesting; overestimates very short
// definitions. Both errors push us conservative on the high-token end,
// which is what the cap wants.
export const estimateTokens = (def: ToolDefinition): number =>
  Math.ceil(JSON.stringify(def).length / 4)

export interface BudgetResult {
  readonly kept: ReadonlyArray<ToolDefinition>
  readonly dropped: ReadonlyArray<string>      // tool names that didn't fit
  readonly totalTokens: number                 // estimated tokens of the `kept` set
  readonly budget: number
}

export const fitProjection = (
  tools: ReadonlyArray<ToolDefinition>,
  budget: number = DEFAULT_TOOL_TOKEN_BUDGET,
): BudgetResult => {
  // Partition into always-keep + the rest. Always-keep is included first
  // regardless of budget (we'd rather exceed the cap by a small amount
  // than break the agent's conversational baseline).
  const keep: ToolDefinition[] = []
  const optional: ToolDefinition[] = []
  for (const t of tools) {
    if (ALWAYS_KEEP.has(t.function.name)) keep.push(t)
    else optional.push(t)
  }

  let used = keep.reduce((sum, t) => sum + estimateTokens(t), 0)
  const dropped: string[] = []

  for (const t of optional) {
    const cost = estimateTokens(t)
    if (used + cost <= budget) {
      keep.push(t)
      used += cost
    } else {
      dropped.push(t.function.name)
    }
  }

  return { kept: keep, dropped, totalTokens: used, budget }
}

// Rate-limited WARN-log for budget triggers. Per-key (default: 'global') a
// log is emitted at most once per WINDOW_MS — subsequent triggers within
// the window are suppressed with a count appended on the next emission.
//
// Callers pass `key = agentId` so per-agent saturation is visible without
// log spam when many agents share the same overhead.
const WINDOW_MS = 5 * 60 * 1000
interface WarnState { readonly firstAt: number; count: number; lastDropped: ReadonlyArray<string>; lastTotal: number; lastBudget: number }
const warnStates = new Map<string, WarnState>()

export const logBudgetTriggerOnce = (key: string, result: BudgetResult): void => {
  if (result.dropped.length === 0) return
  const t = Date.now()
  const prev = warnStates.get(key)
  if (!prev || t - prev.firstAt > WINDOW_MS) {
    if (prev && prev.count > 1) {
      console.warn(`[tool-surface] (${prev.count}× suppressed) last drop: ${prev.lastDropped.slice(0, 5).join(', ')}${prev.lastDropped.length > 5 ? '…' : ''}`)
    }
    console.warn(`[tool-surface] ${key}: dropped ${result.dropped.length} tools to fit ${result.budget}-token budget (used ${result.totalTokens}): ${result.dropped.slice(0, 5).join(', ')}${result.dropped.length > 5 ? '…' : ''}`)
    warnStates.set(key, { firstAt: t, count: 1, lastDropped: result.dropped, lastTotal: result.totalTokens, lastBudget: result.budget })
    return
  }
  prev.count++
  warnStates.set(key, { ...prev, count: prev.count, lastDropped: result.dropped, lastTotal: result.totalTokens, lastBudget: result.budget })
}

// Test seam — clear warn-state between tests so suppress-window assertions
// don't leak across test files.
export const __resetBudgetWarnState = (): void => { warnStates.clear() }
