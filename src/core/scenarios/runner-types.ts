// Runner-internal types shared between runner.ts and ops.ts. Carved out to
// avoid a circular import: runner.ts imports executeOp from ops.ts, ops.ts
// needs to know the event-name union to fire from inside handlers.

export type ScenarioEventName =
  | 'scenario_started'
  | 'scenario_op_executed'
  | 'scenario_guide_shown'
  | 'scenario_completed'
  | 'scenario_failed'
  | 'scenario_stopped'

export type ScenarioEventEmitter = (
  runId: string,
  event: ScenarioEventName,
  detail: Record<string, unknown>,
) => void
