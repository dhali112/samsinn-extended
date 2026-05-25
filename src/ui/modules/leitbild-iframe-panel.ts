// ============================================================================
// Leitbild iframe panel — lets humans view the bound Leitbild dashboard
// alongside Samsinn chat.
//
// Two pieces:
//  1. A toggle button injected into the room header's icon cluster, just
//     before the trash button. Visible only when the active room has a
//     leitbildMirror binding; click toggles the panel.
//  2. A floating, draggable, resizable panel containing an iframe to the
//     Leitbild SPA for the bound Control Instance.
//
// Position + size persist in localStorage so the user's chosen layout
// survives reloads.
//
// Per repo policy: no agent-driven view sync. The iframe is a window onto
// Leitbild's native SPA — the user interacts via Leitbild's own controls.
// ============================================================================

import type { MessageAttachment } from '../../core/types/messaging.ts'
import { addAttachment } from './composer-attachments.ts'
import { icon } from './icon.ts'
import { captureIframeRect } from './screenshot-capture.ts'
import { send as wsSend } from './ws-send.ts'

interface MirrorStatus {
  readonly status: null | {
    readonly baseUrl: string
    readonly instanceId: string
    readonly connected: boolean
  }
}

// === Module-local state ===

let headerBtn: HTMLButtonElement | null = null
let panel: HTMLDivElement | null = null
let iframe: HTMLIFrameElement | null = null
let currentRoomName: string | undefined
let pollAbort: AbortController | null = null

const STORAGE_KEY = 'samsinn:leitbild-panel-layout'

// === Persistence ===

interface PanelLayout { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

const DEFAULT_LAYOUT: PanelLayout = { left: -1, top: -1, width: 800, height: 600 }

const loadLayout = (): PanelLayout => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_LAYOUT
    const p = JSON.parse(raw) as PanelLayout
    if (typeof p.left === 'number' && typeof p.top === 'number' && typeof p.width === 'number' && typeof p.height === 'number') return p
  } catch { /* fall through */ }
  return DEFAULT_LAYOUT
}

const saveLayout = (p: PanelLayout): void => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)) } catch { /* quota / private mode */ }
}

// === URL helpers ===

const spaUrl = (baseUrl: string, instanceId: string): string => {
  // Leitbild SPA route is /i/{scenarioId}/{runId}
  // where instanceId = `${scenarioId}:${runId}`.
  const colonIdx = instanceId.indexOf(':')
  if (colonIdx < 0) return baseUrl
  const scenarioId = instanceId.slice(0, colonIdx)
  const runId = instanceId.slice(colonIdx + 1)
  return `${baseUrl}/i/${encodeURIComponent(scenarioId)}/${encodeURIComponent(runId)}`
}

const fetchMirrorStatus = async (roomName: string, signal: AbortSignal): Promise<MirrorStatus | null> => {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomName)}/leitbild-mirror`, { signal, credentials: 'same-origin' })
    if (!res.ok) return null
    return await res.json() as MirrorStatus
  } catch {
    return null
  }
}

// === Header button creation ===

const buildHeaderButton = (): HTMLButtonElement => {
  const btn = document.createElement('button')
  btn.id = 'btn-leitbild-toggle'
  btn.type = 'button'
  // Reuse existing room-header icon-button styling for visual parity with
  // trash/bookmarks/etc. data-room-icon-id puts it in the visibility
  // registry alongside other header icons.
  btn.className = 'mode-btn icon-btn hidden'
  btn.setAttribute('data-room-icon-id', 'leitbild-toggle')
  btn.setAttribute('data-room-icon-label', 'Leitbild dashboard')
  btn.setAttribute('title', 'Toggle Leitbild dashboard for this room')
  btn.setAttribute('aria-label', 'Toggle Leitbild dashboard')
  // Use compact text — same vertical footprint as the icon buttons.
  btn.textContent = 'Leitbild'
  btn.style.fontSize = '11px'
  btn.style.padding = '2px 8px'
  btn.addEventListener('click', () => togglePanel())
  return btn
}

const ensureHeaderButton = (): HTMLButtonElement => {
  if (headerBtn && document.body.contains(headerBtn)) return headerBtn
  // Insert before #btn-clear-messages in the room-header toolbar group.
  const trashBtn = document.getElementById('btn-clear-messages')
  if (!trashBtn || !trashBtn.parentElement) {
    // Header not in DOM yet — return a detached button; ensureHeaderButton
    // will be re-called on the next room switch.
    headerBtn = buildHeaderButton()
    return headerBtn
  }
  headerBtn = buildHeaderButton()
  trashBtn.parentElement.insertBefore(headerBtn, trashBtn)
  return headerBtn
}

// === Panel creation (draggable + resizable) ===

const clampToViewport = (p: PanelLayout): PanelLayout => {
  const maxLeft = Math.max(0, window.innerWidth - 200)   // keep at least 200px on screen
  const maxTop = Math.max(0, window.innerHeight - 100)
  return {
    left: Math.min(Math.max(0, p.left), maxLeft),
    top: Math.min(Math.max(0, p.top), maxTop),
    width: Math.max(320, Math.min(p.width, window.innerWidth)),
    height: Math.max(240, Math.min(p.height, window.innerHeight)),
  }
}

const applyLayout = (wrap: HTMLDivElement, p: PanelLayout): void => {
  wrap.style.left = `${p.left}px`
  wrap.style.top = `${p.top}px`
  wrap.style.width = `${p.width}px`
  wrap.style.height = `${p.height}px`
}

const ensurePanel = (): { wrap: HTMLDivElement; ifr: HTMLIFrameElement } => {
  if (panel && iframe && document.body.contains(panel)) return { wrap: panel, ifr: iframe }

  panel = document.createElement('div')
  panel.style.cssText = [
    'position:fixed',
    'z-index:999',
    'background:#fff',
    'border:1px solid #374151',
    'border-radius:8px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.3)',
    'overflow:hidden',
    'display:none',
    'flex-direction:column',
    'resize:both',         // CSS-native resize handle at bottom-right
    'min-width:320px',
    'min-height:240px',
  ].join(';')

  // Initialize position. If no saved layout, place at bottom-right (the
  // historical default). Otherwise restore saved layout.
  const layout = loadLayout()
  const initial = layout.left < 0
    ? { left: Math.max(0, window.innerWidth - layout.width - 20), top: Math.max(0, window.innerHeight - layout.height - 20), width: layout.width, height: layout.height }
    : layout
  applyLayout(panel, clampToViewport(initial))

  // Header bar — drag handle + title + close.
  const header = document.createElement('div')
  header.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'padding:6px 12px',
    'background:#1f2937',
    'color:#fff',
    'font-size:12px',
    'font-family:system-ui,sans-serif',
    'cursor:move',         // signal draggable
    'user-select:none',
    'flex:0 0 auto',
  ].join(';')
  const title = document.createElement('span')
  title.textContent = 'Leitbild dashboard (bound to this room)'
  header.appendChild(title)
  // Screenshot button — capture the iframe area via getDisplayMedia,
  // auto-crop to the iframe's bounding rect (so the user gets the dashboard,
  // not the chat around it), insert into the composer as a pending
  // attachment. User picks the Samsinn tab in the OS picker; if they pick
  // a different surface the rect-crop will be outside captured bounds and
  // we fail loud with a toast hint.
  const headerBtns = document.createElement('div')
  headerBtns.style.cssText = 'display:flex;align-items:center;gap:4px'
  const captureBtn = document.createElement('button')
  captureBtn.type = 'button'
  captureBtn.appendChild(icon('camera', { size: 14 }))
  captureBtn.title = 'Screenshot this panel and attach to composer (does not send)'
  captureBtn.style.cssText = 'background:none;border:none;color:#fff;cursor:pointer;padding:2px 6px;line-height:0;border-radius:3px;display:inline-flex;align-items:center'
  captureBtn.addEventListener('mouseenter', () => { captureBtn.style.background = 'rgba(255,255,255,0.1)' })
  captureBtn.addEventListener('mouseleave', () => { captureBtn.style.background = 'none' })
  captureBtn.addEventListener('click', (e) => { e.stopPropagation(); void captureIframeScreenshot(captureBtn) })
  headerBtns.appendChild(captureBtn)
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '×'
  closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0 4px;line-height:1'
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); panel!.style.display = 'none' })
  headerBtns.appendChild(closeBtn)
  header.appendChild(headerBtns)
  panel.appendChild(header)

  // Drag-by-header behavior.
  let dragState: { startX: number; startY: number; origLeft: number; origTop: number } | null = null
  const onMouseMove = (e: MouseEvent): void => {
    if (!dragState || !panel) return
    const newLeft = dragState.origLeft + (e.clientX - dragState.startX)
    const newTop = dragState.origTop + (e.clientY - dragState.startY)
    const clamped = clampToViewport({
      left: newLeft, top: newTop,
      width: panel.offsetWidth, height: panel.offsetHeight,
    })
    panel.style.left = `${clamped.left}px`
    panel.style.top = `${clamped.top}px`
  }
  const onMouseUp = (): void => {
    if (!dragState || !panel) return
    dragState = null
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('mouseup', onMouseUp)
    saveLayout({ left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight })
  }
  header.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON') return  // close-button click
    if (!panel) return
    dragState = { startX: e.clientX, startY: e.clientY, origLeft: panel.offsetLeft, origTop: panel.offsetTop }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  })

  // Iframe body — fills remaining space below header. Pointer-events
  // would normally let the iframe steal the resize handle on Windows, but
  // the parent's resize:both handle sits on the panel border outside the
  // iframe rect — it works.
  iframe = document.createElement('iframe')
  iframe.style.cssText = 'flex:1;border:none;width:100%;display:block'
  iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade')
  panel.appendChild(iframe)

  // Save layout when CSS resize completes. ResizeObserver fires on every
  // pixel; debounce to the trailing edge.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  new ResizeObserver(() => {
    if (resizeTimer) clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      if (!panel) return
      saveLayout({ left: panel.offsetLeft, top: panel.offsetTop, width: panel.offsetWidth, height: panel.offsetHeight })
    }, 200)
  }).observe(panel)

  document.body.appendChild(panel)
  return { wrap: panel, ifr: iframe }
}

const togglePanel = (): void => {
  if (!panel) ensurePanel()
  if (!panel) return
  panel.style.display = panel.style.display === 'none' ? 'flex' : 'none'
}

// === Screenshot capture ===
//
// Uses navigator.mediaDevices.getDisplayMedia → user picks browser tab →
// we grab one video frame → crop to the iframe's bounding rect (scaled by
// devicePixelRatio of the captured surface) → PNG data URL → add as a
// pending attachment to the current room's composer.
//
// User experience: one click → OS picker → pick the Samsinn tab → chip
// appears in composer. They can type accompanying text + take more
// screenshots before sending.

let currentRoomId: string | undefined  // set by updateLeitbildPanelForRoom — we need it for attach target

const showCaptureToast = (msg: string, kind: 'error' | 'info' = 'error'): void => {
  const bg = kind === 'error' ? '#dc2626' : '#1f2937'
  const toast = document.createElement('div')
  toast.style.cssText = `position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:10000;background:${bg};color:#fff;padding:10px 16px;border-radius:6px;font-size:13px;box-shadow:0 4px 12px rgba(0,0,0,0.3);max-width:80vw;`
  toast.textContent = msg
  document.body.appendChild(toast)
  setTimeout(() => toast.remove(), 6000)
}

const captureIframeScreenshot = async (btn: HTMLButtonElement): Promise<void> => {
  if (!iframe || !panel) {
    showCaptureToast('Internal: panel not initialized')
    return
  }
  if (!currentRoomId) {
    showCaptureToast('Internal: no room context. Switch rooms once and try again.')
    return
  }

  btn.disabled = true
  btn.replaceChildren(document.createTextNode('…'))

  try {
    const result = await captureIframeRect(iframe)
    if (result.ok === false) {
      // Distinguish browser-not-supported from per-call failures.
      const msg = result.unsupported === true
        ? 'Screenshots not available in your browser. Try Chrome or Safari. (Server-side capture is on the roadmap — Phase B.)'
        : `Screenshot failed: ${result.reason}`
      showCaptureToast(msg)
      return
    }
    const attachment: MessageAttachment = {
      kind: 'image',
      mimeType: 'image/png',
      dataUrl: result.dataUrl,
      width: result.width,
      height: result.height,
      source: 'leitbild',
      capturedAt: Date.now(),
    }
    addAttachment(currentRoomId, attachment)
  } finally {
    btn.disabled = false
    btn.replaceChildren(icon('camera', { size: 14 }))
  }
}

// === Public API — call from app.ts when the active room changes ===

export const updateLeitbildPanelForRoom = async (roomName: string | undefined, roomId?: string): Promise<void> => {
  currentRoomName = roomName
  currentRoomId = roomId
  pollAbort?.abort()
  pollAbort = new AbortController()

  const btn = ensureHeaderButton()
  const { ifr } = ensurePanel()

  if (!roomName) {
    btn.classList.add('hidden')
    panel!.style.display = 'none'
    return
  }

  const status = await fetchMirrorStatus(roomName, pollAbort.signal)
  // Guard against stale resolves if user switched rooms during the fetch.
  if (currentRoomName !== roomName) return

  if (!status?.status) {
    btn.classList.add('hidden')
    panel!.style.display = 'none'
    ifr.src = 'about:blank'
    return
  }

  const url = spaUrl(status.status.baseUrl, status.status.instanceId)
  if (ifr.src !== url) ifr.src = url
  btn.classList.remove('hidden')
}

// === Agent-callable screenshot (lb_screenshot tool) ===
//
// Server-side lb_screenshot broadcasts an `lb_screenshot_request` WS frame
// to every session in the instance. We listen here, capture the iframe rect
// via the existing captureIframeRect helper, and post back via WS. First
// responder wins on the server side; if our session has no iframe mounted
// we silently no-op (server timeout will fire after 10s).

let agentRequestListenerInstalled = false

const installAgentRequestListener = (): void => {
  if (agentRequestListenerInstalled) return
  agentRequestListenerInstalled = true
  window.addEventListener('lb-screenshot-request', (e: Event) => {
    const detail = (e as CustomEvent<{ requestId: string; roomId: string }>).detail
    if (!iframe || !panel || panel.style.display === 'none') {
      // No iframe mounted in this session — let some other session
      // respond (or let the server-side timeout fire).
      return
    }
    void (async () => {
      const result = await captureIframeRect(iframe!)
      if (result.ok === true) {
        wsSend({
          type: 'lb_screenshot_result',
          requestId: detail.requestId,
          dataUrl: result.dataUrl,
          width: result.width,
          height: result.height,
          mimeType: result.mimeType,
        })
      } else {
        wsSend({
          type: 'lb_screenshot_failed',
          requestId: detail.requestId,
          reason: result.reason ?? 'capture-failed',
        })
      }
    })()
  })
}

// Auto-install on module load — the panel module is imported once at app boot.
installAgentRequestListener()

