// Biometric capture WS handlers — the server-side glue between the inline
// widget (browser DOM) and the in-memory capture registry. The widget
// reports lifecycle events; this handler updates the registry so the
// `biometrics_read` tool can answer current state to agents.
//
// First-claim-wins semantics live here: when the first tab sends
// biometric_capture_started, registry.claim() succeeds and we broadcast
// biometric_capture_claimed so other tabs swap to a placeholder. Late tabs
// also receive biometric_capture_claimed but with claimedBy != their own
// session id.

import type { WSInbound, WSOutbound } from '../../core/types/ws-protocol.ts'
import type { CommandContext } from './types.ts'
import { getCaptureRegistry } from '../../core/biometrics/registry.ts'

export const handleBiometricCommand = (msg: WSInbound, ctx: CommandContext): boolean => {
  const registry = getCaptureRegistry()

  switch (msg.type) {
    case 'biometric_capture_started': {
      const sessionId = ctx.session.sessionToken
      const claimed = registry.claim(msg.captureId, sessionId)
      if (claimed) {
        // Broadcast to every connected WS so other tabs (which may be
        // showing the same fenced block in the same room) swap to the
        // claimed-elsewhere placeholder.
        ctx.broadcast({ type: 'biometric_capture_claimed', captureId: msg.captureId, claimedBy: sessionId } satisfies WSOutbound)
      }
      return true
    }
    case 'biometric_capture_signal': {
      registry.setSnapshot(msg.captureId, msg.snapshot)
      return true
    }
    case 'biometric_capture_stopped': {
      registry.setStopped(msg.captureId, msg.reason)
      return true
    }
    case 'biometric_capture_denied': {
      registry.setDenied(msg.captureId)
      return true
    }
    case 'biometric_capture_failed': {
      registry.setFailed(msg.captureId, msg.error)
      return true
    }
    default:
      return false
  }
}
