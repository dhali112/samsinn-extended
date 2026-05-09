// ============================================================================
// External wait arrangers — single registry for "subscribe to an external
// event source and resume when it fires."
//
// Scope: ONLY waits that subscribe to a system-wide event source the runner
// doesn't otherwise observe. The other two wait kinds — `click` (resolved by
// the runner's `advance()` API) and `post` (resolved by the runner's existing
// `onRoomMessage` handler) — stay in the runner because the runner already
// owns those subscriptions; routing them through this registry would just
// add indirection without removing duplication.
//
// Each arranger receives the wait args + a `resolve` callback that the
// runner has wired to the per-run await-promise resolver. The arranger
// subscribes to its event source, calls `resolve()` when satisfied, and
// returns an unsubscribe fn the runner calls on terminal status / eviction.
// Arrangers do not own timer tracking — they call the runner-provided
// `trackTimer` so eviction's clearTimers reaches everything.
//
// Pattern: subscribe BEFORE returning, so even fast-firing events are caught.
// Resolve at most once via a `fired` flag per arrangement.
//
// Adding a new external wait kind = add a variant to ExternalWaitArgs +
// add an arranger to the registry. Single-file edit.
// ============================================================================

import type { System } from '../../main.ts'
import type { ScenarioRun } from './types.ts'

// === Wait kind union — only the externally-subscribed kinds. The runner-
// internal `click` and `post` waits live as part of GuideWait in types.ts. ===

export type ExternalWaitArgs =
  | { readonly type: 'timer'; readonly seconds: number }
  | { readonly type: 'llm-response'; readonly agent: string }
  | { readonly type: 'script-completed'; readonly room: string; readonly scriptName: string }

export type ExternalWaitType = ExternalWaitArgs['type']

export interface ArrangerCtx {
  readonly state: ScenarioRun
  readonly system: System
  readonly resolve: () => void
  readonly trackTimer: (handle: ReturnType<typeof setTimeout>) => void
}

export type ArrangerUnsubscribe = () => void

type ArrangerFn<K extends ExternalWaitType> = (
  args: Extract<ExternalWaitArgs, { type: K }>,
  ctx: ArrangerCtx,
) => ArrangerUnsubscribe

// === The arrangers ===

const timerArranger: ArrangerFn<'timer'> = (args, { resolve, trackTimer }) => {
  const ms = Math.max(0, args.seconds * 1000)
  const t = setTimeout(resolve, ms)
  trackTimer(t)
  return () => { clearTimeout(t) }
}

const llmResponseArranger: ArrangerFn<'llm-response'> = (args, { state, system, resolve }) => {
  const targetAgent = system.team.getAgent(args.agent)
  if (!targetAgent) {
    console.warn(`[scenarios] wait { type: llm-response, agent: "${args.agent}" } — agent not found; resolving immediately`)
    resolve()
    return () => { /* noop */ }
  }
  const targetName = targetAgent.name
  let fired = false
  const unsubscribe = system.addEvalEventListener((agentName, event) => {
    if (fired) return
    if (agentName !== targetName) return
    if (event.kind !== 'eval_completed') return
    if (state.status !== 'awaiting') return
    fired = true
    resolve()
  })
  return unsubscribe
}

const scriptCompletedArranger: ArrangerFn<'script-completed'> = (args, { state, system, resolve, trackTimer }) => {
  const room = system.house.getRoom(args.room)
  if (!room) {
    console.warn(`[scenarios] wait { type: script-completed, room: "${args.room}" } — room not found; resolving immediately`)
    resolve()
    return () => { /* noop */ }
  }
  const roomId = room.profile.id
  let fired = false
  // 30 min hard cap matches the prior bespoke implementation. Without it a
  // stuck script would pin the scenario run indefinitely.
  const HARD_CAP_MS = 30 * 60_000
  const hardCap = setTimeout(() => {
    if (fired) return
    fired = true
    console.warn(`[scenarios] wait { type: script-completed, room: "${args.room}", scriptName: "${args.scriptName}" } hard-cap reached after ${HARD_CAP_MS}ms`)
    resolve()
  }, HARD_CAP_MS)
  trackTimer(hardCap)
  const unsubscribe = system.addScriptEventListener((eventRoomId, eventName) => {
    if (fired) return
    if (eventRoomId !== roomId) return
    if (eventName !== 'script_completed') return
    if (state.status !== 'awaiting') return
    fired = true
    clearTimeout(hardCap)
    resolve()
  })
  return () => { unsubscribe(); clearTimeout(hardCap) }
}

// === Registry ===

const arrangers: { [K in ExternalWaitType]: ArrangerFn<K> } = {
  'timer': timerArranger,
  'llm-response': llmResponseArranger,
  'script-completed': scriptCompletedArranger,
}

// Single dispatch — type-safe over the discriminated union.
export const arrangeExternalWait = (
  args: ExternalWaitArgs,
  ctx: ArrangerCtx,
): ArrangerUnsubscribe => {
  const arranger = arrangers[args.type] as ArrangerFn<typeof args.type>
  return arranger(args as never, ctx)
}
