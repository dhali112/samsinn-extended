// ============================================================================
// lb_screenshot — agent-callable Leitbild screenshot via the user's browser.
//
// Architecture: agents don't have a browser. The screenshot capture lives
// in the user's WS-connected browser (postMessage to the Leitbild iframe,
// then back to the parent — see ui/modules/screenshot-capture.ts). When an
// agent calls this tool, we:
//
//   1. Generate a requestId.
//   2. broadcastToInstance an `lb_screenshot_request` WS frame.
//   3. Browser sessions with a Leitbild iframe mounted respond with
//      `lb_screenshot_result` (or `lb_screenshot_failed`).
//   4. First-responder wins. Tool resolves the matching pending promise.
//   5. Tool posts the screenshot as a system message in the agent's
//      trigger room (with the image as an attachment, so the agent's
//      NEXT eval picks it up via the multimodal pipeline).
//   6. Tool returns metadata only — never the dataURL (a 5MB dataURL
//      passed through formatToolDataForLLM would blow the LLM context).
//
// Failure modes:
//   - No browser session connected:    timeout → { ok:false, reason:'no-browser' }
//   - Browser captures fail:           timeout → { ok:false, reason:'no-response' }
//   - All sessions report failure:     last failure surfaces as the reason
//   - Tool called from agent whose room has no Leitbild iframe: still
//     broadcasts; if nothing responds, timeout.
//
// V1 scope: per-instance broadcast (any session in this Samsinn instance
// with an iframe responds). Future: target a specific room's sessions.
// ============================================================================

import type { Tool, ToolContext } from '../../core/types/tool.ts'
import type { WSOutbound } from '../../core/types/ws-protocol.ts'
import type { MessageAttachment } from '../../core/types/messaging.ts'
import { SYSTEM_SENDER_ID } from '../../core/types/constants.ts'

const REQUEST_TIMEOUT_MS = 10_000

interface PendingRequest {
  readonly resolve: (result: { dataUrl: string; width: number; height: number; mimeType: 'image/png' | 'image/jpeg' }) => void
  readonly reject: (reason: string) => void
  readonly timer: ReturnType<typeof setTimeout>
}

// Process-global pending-request map. Keyed by requestId — the WS-handler
// looks results up here when an lb_screenshot_result arrives.
const pendingRequests = new Map<string, PendingRequest>()

// Called from the WS inbound dispatcher when a result arrives.
export const resolveScreenshotResult = (
  requestId: string,
  result: { dataUrl: string; width: number; height: number; mimeType: 'image/png' | 'image/jpeg' },
): void => {
  const pending = pendingRequests.get(requestId)
  if (!pending) return    // already resolved by another session, or timed out
  clearTimeout(pending.timer)
  pendingRequests.delete(requestId)
  pending.resolve(result)
}

export const rejectScreenshotResult = (requestId: string, reason: string): void => {
  const pending = pendingRequests.get(requestId)
  if (!pending) return
  // Don't reject yet — another session might still succeed. Only count
  // explicit failures. If ALL sessions fail (none succeed), the timeout
  // resolves with reason='no-response'. Distinct failure tracking would
  // need per-session tracking which isn't in V1 scope.
  void reason
}

export interface LeitbildScreenshotToolDeps {
  // Posts a WSOutbound to every session in the named instance. Bootstrap
  // wires this from wsManager.broadcastToInstance + the tool's
  // per-call instance scope (via deps.getScope).
  readonly broadcastToInstance: (instanceId: string, msg: WSOutbound) => void
  // Per-call instance scope (same shape as the other lb_* tools).
  readonly getScope?: (agentId: string) => string | undefined
  // Lookup helpers used to post the screenshot into the agent's room.
  // The tool needs to know which room the agent's eval was triggered in.
  // Returned room is the trigger room when known (ctx.roomId).
  readonly getRoomByName?: (roomName: string) => { post: (params: { senderId: string; senderName: string; content: string; type: 'system'; attachments?: ReadonlyArray<MessageAttachment> }) => unknown } | undefined
}

export const createLeitbildScreenshotTool = (deps: LeitbildScreenshotToolDeps): Tool => ({
  name: 'lb_screenshot',
  description: 'Capture a fresh screenshot of the Leitbild dashboard currently mounted in the user\'s browser, and attach it to the agent\'s room. The image becomes visible to multimodal-capable models in the NEXT eval — call lb_screenshot, then in your next response refer to the screenshot. Returns metadata only (width, height, mime); the actual image is delivered via the room\'s message stream. Requires at least one connected browser session with a Leitbild iframe mounted; returns ok:false otherwise.',
  returns: 'JSON: { ok: true, width, height, mimeType, attached: true } on success; { ok: false, reason } on no-browser-session-available / no-response / timeout',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  execute: async (_params, ctx: ToolContext) => {
    const scope = deps.getScope?.(ctx.callerId)
    if (!scope) {
      return { success: false, error: 'lb_screenshot requires a per-tenant scope (no system associated with this agent).' }
    }

    const requestId = crypto.randomUUID()

    // Issue the request and wait up to REQUEST_TIMEOUT_MS for the FIRST
    // result. Sessions that fail individually don't reject the promise —
    // only the timeout does (the success path resolves on any one session).
    const result = await new Promise<
      { dataUrl: string; width: number; height: number; mimeType: 'image/png' | 'image/jpeg' } | null
    >((resolve) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId)
        resolve(null)
      }, REQUEST_TIMEOUT_MS)
      pendingRequests.set(requestId, {
        resolve: (r) => resolve(r),
        reject: () => { /* see rejectScreenshotResult — V1 does not reject early */ },
        timer,
      })
      // The roomId hint helps the browser-side handler pick the right
      // session (when multi-instance-mounting eventually lands). For
      // V1, every session reads its own currentRoomId and only the
      // session with a Leitbild iframe responds.
      deps.broadcastToInstance(scope, {
        type: 'lb_screenshot_request',
        requestId,
        roomId: ctx.roomId ?? '',
      })
    })

    if (!result) {
      return { success: false, error: 'lb_screenshot timed out after 10s — no browser session with a Leitbild iframe responded.' }
    }

    // Post the screenshot into the agent's trigger room so it appears in
    // the agent's next eval via the multimodal pipeline. roomId on ctx is
    // optional (tools called outside a room context skip the post).
    const triggerRoom = ctx.roomId
      ? deps.getRoomByName?.(ctx.roomId)
      : undefined
    let attached = false
    if (triggerRoom) {
      const attachment: MessageAttachment = {
        kind: 'image',
        mimeType: result.mimeType === 'image/png' ? 'image/png' : 'image/png', // V1 attachments only carry PNG; coerce
        dataUrl: result.dataUrl,
        width: result.width,
        height: result.height,
        source: 'leitbild',
        capturedAt: Date.now(),
      }
      triggerRoom.post({
        senderId: SYSTEM_SENDER_ID,
        senderName: 'Leitbild',
        content: `[Leitbild screenshot requested by agent — ${result.width}×${result.height} ${result.mimeType}]`,
        type: 'system',
        attachments: [attachment],
      })
      attached = true
    }

    return {
      success: true,
      data: {
        width: result.width,
        height: result.height,
        mimeType: result.mimeType,
        attached,
        ...(attached ? {} : { note: 'screenshot captured but not attached — agent was called outside a room context' }),
      },
    }
  },
})
