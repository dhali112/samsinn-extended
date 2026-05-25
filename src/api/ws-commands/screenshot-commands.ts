// WS inbound handler for lb_screenshot result delivery from the browser.
// Browser side: receives `lb_screenshot_request`, calls captureIframeRect,
// posts back lb_screenshot_result (success) or lb_screenshot_failed.
// Server side (here): looks up the pending request in the module-level
// map and resolves the agent-tool's promise.

import type { WSInbound } from '../../core/types/ws-protocol.ts'
import type { CommandContext } from './types.ts'
import { resolveScreenshotResult, rejectScreenshotResult } from '../../integrations/leitbild/screenshot-tool.ts'

export const handleScreenshotCommand = (msg: WSInbound, _ctx: CommandContext): boolean => {
  switch (msg.type) {
    case 'lb_screenshot_result': {
      resolveScreenshotResult(msg.requestId, {
        dataUrl: msg.dataUrl,
        width: msg.width,
        height: msg.height,
        mimeType: msg.mimeType,
      })
      return true
    }
    case 'lb_screenshot_failed': {
      rejectScreenshotResult(msg.requestId, msg.reason)
      return true
    }
    default:
      return false
  }
}
