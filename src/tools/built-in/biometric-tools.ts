// Biometric capture tools — start / stop / read.
//
// These tools are implemented in core but registered with
// source = { kind: 'pack-bundled', pack: 'biometrics' } when the
// samsinn-biometrics pack is installed. That means:
//   - Per-room activation filter (effectiveActivePacks) gates them just
//     like any pack-bundled tool.
//   - Uninstalling the pack removes them via the pack-tool unregister path
//     (source.pack === 'biometrics' is the scrub key).
//   - Installing the pack makes them appear without redeploying core.
//
// The pack repository (samsinn-biometrics) ships only pack.json (declares
// ui_extensions) plus the agent-facing skill. Tool implementation lives
// here so it can reach House + capture registry without exposing a
// globalThis surface to drop-in pack code.

import type { House } from '../../core/types/room.ts'
import type { Tool, ToolContext } from '../../core/types/tool.ts'
import type { CaptureRegistry } from '../../core/biometrics/registry.ts'

const PACK_NAMESPACE = 'biometrics'

const generateCaptureId = (): string => {
  const random = Math.random().toString(36).slice(2, 10)
  return `cap_${Date.now().toString(36)}_${random}`
}

const fenceContent = (payload: object): string =>
  '```biometric\n' + JSON.stringify(payload, null, 2) + '\n```'

export interface BiometricToolsDeps {
  readonly house: House
  readonly registry: CaptureRegistry
}

export const createBiometricsStartTool = (deps: BiometricToolsDeps): Tool => ({
  name: `${PACK_NAMESPACE}_start`,
  description: 'Begins a webcam-based biometric capture from the user. Returns immediately with a captureId; the user must explicitly consent in the inline widget before the camera activates. Always pair with biometrics_stop when done.',
  usage: 'Use only when the user has explicitly invited observation (e.g. "watch my reaction"). Never for surveillance. State a clear reason. After the user consents, call biometrics_read to fetch live snapshots between turns. When finished, call biometrics_stop.',
  returns: '{ captureId, status: "pending_consent" } on success, or { status: "unavailable", reason } if biometrics are not available in the current room.',
  parameters: {
    type: 'object',
    properties: {
      reason: { type: 'string', description: 'Short, user-readable explanation of why you want to capture biometrics. Shown verbatim in the consent prompt.' },
    },
    required: ['reason'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const reason = typeof params.reason === 'string' ? params.reason.trim() : ''
    if (!reason) return { success: false, error: 'reason is required' }
    if (!context.roomId) return { success: false, error: 'biometrics_start must be invoked from a room context' }
    const room = deps.house.getRoom(context.roomId)
    if (!room) return { success: false, error: `room "${context.roomId}" not found` }

    const captureId = generateCaptureId()
    deps.registry.create({
      captureId,
      agentId: context.callerId,
      agentName: context.callerName,
      roomId: room.profile.id,
      reason,
    })

    // Post the fenced block as a system message in the room. Cause is
    // 'biometric' so the snapshot redactor strips its content on save.
    room.post({
      senderId: context.callerId,
      senderName: context.callerName,
      content: fenceContent({
        captureId,
        agentName: context.callerName,
        reason,
        state: 'requested',
      }),
      type: 'system',
      cause: { kind: 'biometric', name: captureId },
    })

    return { success: true, data: { captureId, status: 'pending_consent' } }
  },
})

export const createBiometricsStopTool = (deps: BiometricToolsDeps): Tool => ({
  name: `${PACK_NAMESPACE}_stop`,
  description: 'Stops an active biometric capture. Idempotent — calling stop on an already-stopped capture is safe. ALWAYS call this when you no longer need the live signal stream; leaving captures running is bad practice.',
  usage: 'Required cleanup for every biometrics_start. The user can also stop manually via the widget; call this anyway to be defensive.',
  returns: '{ status: "stopped" | "not_found" }',
  parameters: {
    type: 'object',
    properties: {
      captureId: { type: 'string', description: 'captureId returned from biometrics_start' },
    },
    required: ['captureId'],
  },
  execute: async (params: Record<string, unknown>, context: ToolContext) => {
    const captureId = typeof params.captureId === 'string' ? params.captureId : ''
    if (!captureId) return { success: false, error: 'captureId is required' }
    const entry = deps.registry.get(captureId)
    if (!entry) return { success: true, data: { status: 'not_found' } }

    deps.registry.setStopped(captureId, 'agent')

    // Post a stopped-state fenced block so the corresponding widget
    // re-renders as a static summary on next markdown re-pass. The widget
    // is also actively driven by samsinn:biometric-stop-all; this is the
    // out-of-band record, not the primary stop mechanism.
    if (context.roomId) {
      const room = deps.house.getRoom(context.roomId)
      if (room) {
        room.post({
          senderId: context.callerId,
          senderName: context.callerName,
          content: fenceContent({
            captureId,
            agentName: entry.agentName,
            reason: entry.reason,
            state: 'stopped',
          }),
          type: 'system',
          cause: { kind: 'biometric', name: captureId },
        })
      }
    }

    return { success: true, data: { status: 'stopped' } }
  },
})

export const createBiometricsReadTool = (deps: BiometricToolsDeps): Tool => ({
  name: `${PACK_NAMESPACE}_read`,
  description: 'Returns the latest biometric snapshot for an active or recently-stopped capture. Pull-only — call this each turn while a capture is active to pick up the user\'s current state.',
  usage: 'Call after biometrics_start succeeds and the user has consented. Returns the most recent signal sample (sub-second freshness). Returns { status: "pending" } before consent, { status: "active", signals } during capture, { status: "stopped", signals } after stop, { status: "not_found" } for unknown ids.',
  returns: '{ status, signals?: { presence, attention, expression, headPose, blinkRate, ts } }',
  parameters: {
    type: 'object',
    properties: {
      captureId: { type: 'string', description: 'captureId returned from biometrics_start' },
    },
    required: ['captureId'],
  },
  execute: async (params: Record<string, unknown>) => {
    const captureId = typeof params.captureId === 'string' ? params.captureId : ''
    if (!captureId) return { success: false, error: 'captureId is required' }
    const entry = deps.registry.get(captureId)
    if (!entry) return { success: true, data: { status: 'not_found' } }

    const status =
      entry.status === 'pending_consent' ? 'pending' :
      entry.status === 'active' ? 'active' :
      entry.status === 'stopped' ? 'stopped' :
      entry.status === 'denied' ? 'denied' :
      entry.status === 'failed' ? 'failed' :
      'unknown'

    return {
      success: true,
      data: entry.lastSnapshot
        ? { status, signals: entry.lastSnapshot }
        : { status },
    }
  },
})

export const createBiometricsTools = (deps: BiometricToolsDeps): ReadonlyArray<Tool> => [
  createBiometricsStartTool(deps),
  createBiometricsStopTool(deps),
  createBiometricsReadTool(deps),
]

export const BIOMETRICS_PACK_NAMESPACE = PACK_NAMESPACE
