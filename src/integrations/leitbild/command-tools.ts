// ============================================================================
// Leitbild command tool (V2.B — write surface).
//
// One generic tool — lb_command(kind, targets, payload) — gated by the
// agent's leitbildBinding.role === 'operator'. Tools registered with
// role='observer' return a permission error instead of dispatching.
//
// Identity wiring (Codex round 8): each agent issues commands with a
// stable actorId + clientId derived from the agent's name:
//   actorId  = "actor:samsinn:<agent-slug>"
//   clientId = "client:samsinn:<agent-slug>"
//
// The clientId is the primary handle for echo filtering: the room mirror
// re-broadcasts command.issued / command.result events, and a bound agent
// already filters all external-mirror messages from its context (V2.A's
// suppressLeitbildMirror), so the agent does not double-react to its own
// command. Other room participants (humans, supervisor agents) still see
// the events through the mirror as designed.
//
// No echo-specific data structures needed: V2.A's filter is sufficient.
// ============================================================================

import { createHash } from 'node:crypto'
import type { Tool, ToolContext, ToolResult } from '../../core/types/tool.ts'
import type { LeitbildAgentBinding } from '../../core/types/agent.ts'
import { createLeitbildClient } from './client.ts'

export interface LeitbildCommandToolDeps {
  readonly getBinding: (agentId: string) => LeitbildAgentBinding | undefined
  readonly getAgentName?: (agentId: string) => string | undefined
  // Per-tenant scope for the LeitbildClient pool, looked up per-call by
  // agent id (bootstrap resolves to the owning system's instance id).
  // Audit Finding 2.1.3.
  readonly getScope?: (agentId: string) => string | undefined
}

// Convert an agent name (free-form) into a Leitbild-compatible slug.
// Leitbild ids must match `^[a-zA-Z0-9][a-zA-Z0-9._:-]*$` (≤128 chars).
// Lowercase, replace whitespace/underscores/slashes with hyphen, strip
// any remaining disallowed chars, collapse repeats, trim.
export const toLeitbildSlug = (input: string): string => {
  const lowered = input.toLowerCase()
  const dashed = lowered.replace(/[\s/_]+/g, '-')
  const stripped = dashed.replace(/[^a-z0-9.:-]/g, '')
  const collapsed = stripped.replace(/-+/g, '-').replace(/^[-.:]+|[-.:]+$/g, '')
  return collapsed || 'unknown'
}

const fail = (error: string): ToolResult => ({ success: false, error })
const ok = (data: unknown): ToolResult => ({ success: true, data })

const createLbCommand = (deps: LeitbildCommandToolDeps): Tool => ({
  name: 'lb_command',
  description: 'Issue a control command to the bound Leitbild Control Instance. Use accepted command kinds (discover via the per-CI capabilities endpoint). Returns the immediate accept/reject result; live downstream events are visible to other room participants via the room mirror. Requires the agent\'s leitbildBinding.role === "operator".',
  returns: 'JSON: { ok: true, commandId, acceptedAt } on accept; { ok: false, commandId, rejectedAt, reason } on reject.',
  parameters: {
    type: 'object',
    properties: {
      kind: { type: 'string', description: 'Command kind, e.g. "ambulance.assign_to_incident" (must be one of acceptedCommandKinds from the CI capabilities).' },
      targets: { type: 'array', items: { type: 'string' }, description: 'Target object ids the command applies to. May be empty if the command kind takes no targets.' },
      payload: { type: 'object', description: 'Command-kind-specific payload (pass {} if none).' },
    },
    required: ['kind', 'targets'],
    additionalProperties: false,
  },
  execute: async (params, ctx: ToolContext) => {
    const binding = deps.getBinding(ctx.callerId)
    if (!binding) return fail('No leitbildBinding configured for this agent. Add { baseUrl, instanceId, role } to the agent config to use lb_command.')
    if (binding.role !== 'operator') return fail('lb_command requires leitbildBinding.role === "operator". This agent has role: "' + binding.role + '".')

    const kind = String(params.kind ?? '').trim()
    if (!kind) return fail('lb_command requires kind (string).')
    const targetsRaw = params.targets
    if (!Array.isArray(targetsRaw)) return fail('lb_command requires targets (array of object ids; pass [] if none).')
    const targets = targetsRaw.map(t => String(t))
    const payload = (params.payload as Record<string, unknown> | undefined) ?? {}

    const slug = toLeitbildSlug(deps.getAgentName?.(ctx.callerId) ?? ctx.callerName ?? ctx.callerId)
    const actorId = `actor:samsinn:${slug}`
    const clientId = `client:samsinn:${slug}`

    // Deterministic idempotency key — sha256 of (callerId + kind + targets
    // + payload). Two semantically-identical lb_command calls from the same
    // agent get the same key. Combined with Leitbild's 1h dedup TTL (per
    // docs/samsinn-integration.md), this means:
    //   - LLM-eval retries that re-derive identical args = single Leitbild effect
    //   - Intentional same-command-twice within an hour = also collapsed (the
    //     LLM should vary something — a sequence id, a different target — to
    //     get distinct effects; if it truly intends a duplicate, the dedup
    //     window expires and the second one fires)
    //   - Distinct calls (different targets / payload) = distinct keys, distinct effects
    // The hash strategy beats a per-call cache because it has zero state in
    // Samsinn (no eviction, no memory creep) while still giving Leitbild the
    // stable anchor it needs.
    const fingerprint = JSON.stringify({ callerId: ctx.callerId, kind, targets, payload })
    const idempotencyKey = createHash('sha256').update(fingerprint).digest('hex').slice(0, 32)

    try {
      const client = createLeitbildClient(binding.baseUrl, { scope: deps.getScope?.(ctx.callerId) })
      const body = await client.callCommand(binding.instanceId, {
        actorId, clientId, kind, targetObjectIds: targets, payload, idempotencyKey,
      }) as { result?: unknown }
      return ok(body.result ?? body)
    } catch (err) {
      return fail(`lb_command failed: ${(err as Error).message}`)
    }
  },
})

export const createLeitbildCommandTools = (deps: LeitbildCommandToolDeps): ReadonlyArray<Tool> => [
  createLbCommand(deps),
]
