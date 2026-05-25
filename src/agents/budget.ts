// ============================================================================
// Per-eval context budget computation.
//
// Extracted from ai-agent.ts so the budget policy lives in one testable
// place and the two modes (static, dynamic) have a clear contract.
//
// Two modes:
//
//   STATIC (default, byte-identical to pre-extraction behavior):
//     budget = max(FLOOR, contextMax * FRACTION)
//     where FRACTION = 0.7 (reserve 30% for tool defs + output + safety).
//     Right when tool-def cost is small relative to context; conservative
//     for pack-heavy agents where tool defs alone can be ~30%+.
//
//   DYNAMIC (opt-in via SAMSINN_AUTO_BUDGET_DYNAMIC=1):
//     budget = max(FLOOR, contextMax - estTokens(toolDefs) - expectedOutput - safety)
//     Sizes budget against the actual per-eval tool surface. A bare agent
//     with 2 tools gets ~95% of context for system+history; a pack-heavy
//     agent with 30 tools gets less. The expectedOutput allowance keeps
//     generation room headroom; FLOOR prevents pathological surfaces from
//     starving the budget below usefulness.
//
// Why a canary flag: dynamic mode changes every existing agent's per-call
// budget. Some currently-borderline contexts would suddenly fit; some
// currently-fine evals might newly trip a budget cap. Default-off lets
// operators opt in per-instance for canary while the static path stays
// the safe-by-default for everyone else. Promotion to default-on after a
// canary period with no observed regressions.
// ============================================================================

// 30% headroom for tool defs + generation + safety. The fraction sized for
// an average pack load (~5-10 tools active). Pack-heavy agents can blow
// past 30%; the dynamic mode below sizes against actual tool cost.
export const AUTO_BUDGET_FRACTION = 0.7

// Lower bound on the budget. Below this, system + history are too narrow
// for meaningful conversation. Applies in both modes.
export const AUTO_BUDGET_FLOOR = 2000

// Used when the model's context window is unknown to the registry
// (uncatalogued model). 64K is conservative — most modern flagships are
// 128K+. Update src/llm/models/context-window.ts when a new model lands.
export const AUTO_BUDGET_FALLBACK = 64_000

// Headroom reserved for the model's output. Most agent replies fit well
// under this, but reasoning-style models (thinking, etc.) and tool-result
// summarizations can use the full window.
export const DYNAMIC_OUTPUT_RESERVE = 4_096

// Final safety margin past everything we accounted for explicitly.
// Catches estimation drift on tool-def serialization, BPE-tokenization
// quirks, and stream framing overhead.
export const DYNAMIC_SAFETY_MARGIN = 1_000

// ToolDefinition shape we serialize. Matches src/core/types/tool.ts
// loosely — only the fields we count toward token cost.
interface BudgetableToolDef {
  readonly name: string
  readonly description: string
  readonly parameters: unknown
}

export type BudgetMode = 'static' | 'dynamic'

export interface ContextBudget {
  readonly budget: number
  readonly mode: BudgetMode
  // Diagnostic string. Used by eval-event emitters so an operator can see
  // how the budget was computed when triaging a context-overflow incident.
  readonly reason: string
}

export interface BudgetInputs {
  // Context window of the resolved model. Pass 0 (or any value <= 0) when
  // the registry has no entry — caller will fall back to AUTO_BUDGET_FALLBACK
  // before invoking computeContextBudget.
  readonly contextMax: number
  // Tool definitions visible to this eval. Pass [] when no tools are wired.
  // Dynamic mode subtracts their serialized token cost from the budget.
  readonly toolDefinitions: ReadonlyArray<BudgetableToolDef>
}

// Read the env flag at call time so tests + hot-reload set the mode without
// restart. process.env access is cheap.
const isDynamicEnabled = (): boolean =>
  process.env.SAMSINN_AUTO_BUDGET_DYNAMIC === '1'

// Token estimator. Re-imported from context-builder via the caller to avoid
// a circular import (context-builder imports from agents/, and this module
// is in agents/ too). Caller passes the estimator in.
export type EstimateTokensFn = (text: string) => number

const computeStatic = (contextMax: number): ContextBudget => {
  if (contextMax <= 0) {
    return {
      budget: AUTO_BUDGET_FALLBACK,
      mode: 'static',
      reason: `unknown-model: fallback=${AUTO_BUDGET_FALLBACK}`,
    }
  }
  return {
    budget: Math.max(AUTO_BUDGET_FLOOR, Math.floor(contextMax * AUTO_BUDGET_FRACTION)),
    mode: 'static',
    reason: `static: floor(${contextMax} * ${AUTO_BUDGET_FRACTION})`,
  }
}

const computeDynamic = (
  inputs: BudgetInputs,
  estimateTokens: EstimateTokensFn,
): ContextBudget => {
  const { contextMax, toolDefinitions } = inputs
  if (contextMax <= 0) {
    return {
      budget: AUTO_BUDGET_FALLBACK,
      mode: 'dynamic',
      reason: `unknown-model: fallback=${AUTO_BUDGET_FALLBACK}`,
    }
  }
  // Serialize each tool def (name + description + parameters) the way the
  // wire format does. JSON.stringify is the closest cheap analog; the
  // actual wire format may differ per provider but cost is within ~10%.
  let toolDefTokens = 0
  for (const tool of toolDefinitions) {
    const serialized = JSON.stringify({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })
    toolDefTokens += estimateTokens(serialized)
  }
  const raw = contextMax - toolDefTokens - DYNAMIC_OUTPUT_RESERVE - DYNAMIC_SAFETY_MARGIN
  const clamped = Math.max(AUTO_BUDGET_FLOOR, raw)
  return {
    budget: clamped,
    mode: 'dynamic',
    reason: `dynamic: ${contextMax} - tools=${toolDefTokens} - output=${DYNAMIC_OUTPUT_RESERVE} - safety=${DYNAMIC_SAFETY_MARGIN} → max(floor=${AUTO_BUDGET_FLOOR}, ${raw})`,
  }
}

export const computeContextBudget = (
  inputs: BudgetInputs,
  estimateTokens: EstimateTokensFn,
): ContextBudget => isDynamicEnabled()
  ? computeDynamic(inputs, estimateTokens)
  : computeStatic(inputs.contextMax)
