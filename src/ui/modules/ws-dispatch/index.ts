// ============================================================================
// WS Dispatch — maps incoming WebSocket events to store mutations.
//
// Pure data layer: each handler reads the message and writes to stores.
// No DOM manipulation, no rendering, no side effects beyond store writes
// + CustomEvent fan-out. DOM effects are handled by store subscriptions
// wired in app.ts and the render layer.
//
// Handlers are split by concern across handlers/{state,runs,system}.ts:
//   - state:  snapshot, messages, agent state, room/agent membership
//   - runs:   long-running progress (scripts, summary runs, provider toasts)
//   - system: instance / packs / triggers / providers / reset / errors
// ============================================================================

import type { WSOutbound } from '../../../core/types/ws-protocol.ts'
import { stateHandlers } from './handlers/state.ts'
import { runHandlers } from './handlers/runs.ts'
import { systemHandlers } from './handlers/system.ts'

const merged = {
  ...stateHandlers,
  ...runHandlers,
  ...systemHandlers,
}

export const wsDispatch = merged as Record<string, (msg: WSOutbound) => void>
