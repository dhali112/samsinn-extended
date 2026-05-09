// Evaluation events — real-time visibility into agent reasoning. Leaf module.

export type EvalEvent =
  | { readonly kind: 'chunk'; readonly delta: string }
  | { readonly kind: 'thinking'; readonly delta: string }
  | { readonly kind: 'tool_start'; readonly tool: string }
  | { readonly kind: 'tool_result'; readonly tool: string; readonly success: boolean; readonly preview?: string }
  | { readonly kind: 'context_ready'; readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>; readonly model: string; readonly temperature?: number; readonly toolCount: number }
  | { readonly kind: 'warning'; readonly message: string }
  // Emitted once per (agent, fallback-target) when the agent's preferred model
  // is unavailable and the call falls back. One-shot: re-emitted only if the
  // preferred model recovers and then becomes unavailable again. Drives a
  // non-blocking UI notice ("Falling back to X — preferred Y unavailable").
  | { readonly kind: 'model_fallback'; readonly preferred: string; readonly effective: string; readonly reason: string }
  // Emitted exactly once per evaluate() call, at the terminal point — whether
  // the agent responded, passed, errored, or hit the iteration cap. Subscribers
  // can use this as a reliable "this agent is done" signal without polling
  // agent.state. Used by the scenario runner's `wait-for-llm-response` arranger
  // and (after refactor) the `start-script` op's wait loop.
  | { readonly kind: 'eval_completed'; readonly outcome: 'respond' | 'pass' | 'error' }

export type OnEvalEvent = (agentName: string, event: EvalEvent) => void
