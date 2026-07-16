// ============================================================================
// Shared WS send reference.
//
// A tiny module that holds the active WSClient so any UI module can dispatch
// messages without being passed the client through multiple layers. Set
// once after connect; every caller reads the same reference.
//
// Dropped sends are LOUD: when the client is missing or the socket is not
// open (pre-connect, post-disconnect, server restarting), the user sees a
// toast telling them to refresh instead of their click silently doing
// nothing. Throttled so a burst of clicks produces one toast, not a stack.
// ============================================================================

import type { WSClient } from './ws-client.ts'
import { showToast } from './toast.ts'

let client: WSClient | null = null
let lastWarnAt = 0
const WARN_THROTTLE_MS = 5_000

export const setWSClient = (c: WSClient | null): void => {
  client = c
}

export const send = (data: unknown): void => {
  const delivered = client?.send(data) ?? false
  if (!delivered) {
    const now = Date.now()
    if (now - lastWarnAt >= WARN_THROTTLE_MS) {
      lastWarnAt = now
      showToast(document.body, 'Not connected to the server — your action was not sent. Refresh the page (F5); if that fails, check the server is running.', { type: 'error', position: 'fixed' })
    }
  }
}
