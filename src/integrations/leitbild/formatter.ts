// ============================================================================
// Leitbild event formatter — turn a domain event into a chat line.
//
// V1 is deliberately generic. Leitbild events span ambulance, process-plant,
// traffic, weather, commands, clock, scenario guidance, notifications, and
// telemetry. We don't ship per-domain renderers in V1 — those land
// incrementally as their packs mature. Generic fallback first.
//
// Two formats: 'summary' (one-liner) and 'full' (one-liner + JSON code
// block). Mirror-service picks based on the room's mirror config.
// ============================================================================

import type { LeitbildEvent } from './types.ts'

// === Banner — posted on attach ===

export interface BannerContext {
  readonly baseUrl: string
  readonly instanceId: string
  readonly scenarioTitle?: string
  readonly scenarioDescription?: string
  readonly objectCount?: number
  readonly operator?: string
  readonly authPosture?: string
  readonly clockPaused?: boolean
  readonly clockSpeed?: number
  readonly clockCurrentTime?: string
  readonly snapshotSeq: number
}

export const formatBanner = (ctx: BannerContext): string => {
  const lines: string[] = []
  lines.push(`[Leitbild] Connected to ${ctx.instanceId} on ${hostOf(ctx.baseUrl)}`)
  if (ctx.scenarioTitle) {
    lines.push(`  Scenario: ${ctx.scenarioTitle}${ctx.scenarioDescription ? ' — ' + ctx.scenarioDescription : ''}`)
  }
  const clockBits: string[] = []
  if (ctx.clockCurrentTime) clockBits.push(`clock ${ctx.clockCurrentTime}`)
  if (ctx.clockSpeed !== undefined) clockBits.push(`${ctx.clockSpeed}×`)
  if (ctx.clockPaused !== undefined) clockBits.push(ctx.clockPaused ? 'paused' : 'running')
  if (clockBits.length > 0) lines.push(`  ${clockBits.join(' · ')}`)
  if (ctx.objectCount !== undefined) lines.push(`  ${ctx.objectCount} objects`)
  if (ctx.operator || ctx.authPosture) {
    const meta: string[] = []
    if (ctx.operator) meta.push(`operator: ${ctx.operator}`)
    if (ctx.authPosture) meta.push(`auth: ${ctx.authPosture}`)
    lines.push(`  ${meta.join(' · ')}`)
  }
  lines.push(`  Subscribed at seq=${ctx.snapshotSeq}`)
  return lines.join('\n')
}

// === Reset boundary — posted when Leitbild emits a reset event ===

export const formatResetBoundary = (newSeq: number): string =>
  `[Leitbild] ⟲ CONTROL INSTANCE RESET — historical events above no longer reflect current state. Re-anchored at seq=${newSeq}.`

// === Reconnect notice — posted after a WS reconnect + durable replay ===

export const formatReconnectNotice = (newSeq: number): string =>
  `[Leitbild] reconnected at seq=${newSeq} (durable catch-up applied; any volatile-only events during the outage were not replayed)`

// === Mirror-error notice — posted when attach fails ===

export const formatMirrorError = (reason: string): string =>
  `[Leitbild] ⚠ mirror error: ${reason}`

// === Per-event formatting ===

export type MirrorFormat = 'summary' | 'full'

export const formatEvent = (event: LeitbildEvent, format: MirrorFormat): string => {
  const summary = summarizeEvent(event)
  if (format === 'summary') return summary
  // 'full' — summary + structured JSON code block for downstream agent parsing.
  return `${summary}\n\`\`\`json\n${JSON.stringify(event, null, 2)}\n\`\`\``
}

// === Generic event summary ===

// Generic-first per Codex's correction. Domain renderers can be added as a
// dispatch table over event.type later — keep V1 generic so a new pack's
// events render sensibly without code changes here.

const summarizeEvent = (event: LeitbildEvent): string => {
  const type = event.type
  const obj = (event as { object?: { id?: string; label?: string } }).object
  const objectLabel = obj?.label ?? obj?.id
  if (objectLabel) return `[Leitbild] ${type}: ${objectLabel}`
  const target = (event as { targetObjectIds?: ReadonlyArray<string> }).targetObjectIds
  if (target && target.length > 0) return `[Leitbild] ${type} → ${target.join(', ')}`
  return `[Leitbild] ${type}`
}

// === Helpers ===

const hostOf = (url: string): string => {
  try { return new URL(url).host } catch { return url }
}
