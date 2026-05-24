// ============================================================================
// Leitbild iframe panel — floating widget that lets humans view the bound
// Leitbild dashboard alongside Samsinn chat.
//
// When the active room has a `leitbildMirror` config set, a small button
// appears at the bottom-right corner. Click expands a 800×600 iframe of
// the Leitbild SPA URL for the bound Control Instance. Click again to
// collapse. Drag the toggle to reposition.
//
// Self-contained: no styling dependency, no DOM coupling beyond `document.body`.
// All state lives in module-local variables.
//
// V1 scope: read-only embed. No agent-driven view sync (scrapped with
// screenshot capability). No view controls beyond what Leitbild's SPA
// natively exposes (the iframe is just a window onto the deployment).
// ============================================================================

interface MirrorStatus {
  readonly status: null | {
    readonly baseUrl: string
    readonly instanceId: string
    readonly connected: boolean
  }
}

let toggleBtn: HTMLButtonElement | null = null
let iframeWrap: HTMLDivElement | null = null
let iframe: HTMLIFrameElement | null = null
let currentRoomName: string | undefined
let pollAbort: AbortController | null = null

const styleToggle = (btn: HTMLButtonElement, visible: boolean): void => {
  btn.style.cssText = [
    'position:fixed', 'bottom:20px', 'right:20px', 'z-index:1000',
    'padding:8px 14px', 'border-radius:20px',
    'background:#1f2937', 'color:#fff', 'border:1px solid #374151',
    'cursor:pointer', 'font-size:13px', 'font-family:system-ui,sans-serif',
    'box-shadow:0 2px 8px rgba(0,0,0,0.2)',
    visible ? 'display:flex' : 'display:none',
    'align-items:center', 'gap:6px',
  ].join(';')
}

const styleIframeWrap = (wrap: HTMLDivElement, visible: boolean): void => {
  wrap.style.cssText = [
    'position:fixed', 'bottom:70px', 'right:20px', 'z-index:999',
    'width:800px', 'height:600px',
    'background:#fff', 'border:1px solid #374151', 'border-radius:8px',
    'box-shadow:0 8px 32px rgba(0,0,0,0.3)',
    'overflow:hidden',
    visible ? 'display:flex' : 'display:none',
    'flex-direction:column',
  ].join(';')
}

const spaUrl = (baseUrl: string, instanceId: string): string => {
  // Per Codex (Leitbild thread): SPA route is /i/{scenarioId}/{runId}
  // where instanceId = `${scenarioId}:${runId}`.
  const colonIdx = instanceId.indexOf(':')
  if (colonIdx < 0) return baseUrl  // unexpected; fall through to deployment root
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

const ensureDOM = (): { toggle: HTMLButtonElement; wrap: HTMLDivElement; iframe: HTMLIFrameElement } => {
  if (toggleBtn && iframeWrap && iframe) return { toggle: toggleBtn, wrap: iframeWrap, iframe }

  toggleBtn = document.createElement('button')
  toggleBtn.type = 'button'
  toggleBtn.title = 'Toggle Leitbild dashboard view'
  toggleBtn.innerHTML = '<span style="font-size:16px">⛶</span><span>Leitbild</span>'
  styleToggle(toggleBtn, false)

  iframeWrap = document.createElement('div')
  styleIframeWrap(iframeWrap, false)

  const header = document.createElement('div')
  header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:#1f2937;color:#fff;font-size:12px;font-family:system-ui,sans-serif'
  header.innerHTML = '<span>Leitbild dashboard (bound to this room)</span>'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '×'
  closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:0 4px;line-height:1'
  closeBtn.addEventListener('click', () => styleIframeWrap(iframeWrap!, false))
  header.appendChild(closeBtn)
  iframeWrap.appendChild(header)

  iframe = document.createElement('iframe')
  iframe.style.cssText = 'flex:1;border:none;width:100%'
  // No sandbox attribute — Leitbild is a first-party deployment (same owner
  // as Samsinn). Sandbox flags broke the SPA's mount (white iframe). For
  // cross-publisher embeds, add sandbox back with at minimum
  // allow-scripts allow-same-origin allow-forms.
  iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade')
  iframeWrap.appendChild(iframe)

  toggleBtn.addEventListener('click', () => {
    const isVisible = iframeWrap!.style.display !== 'none'
    styleIframeWrap(iframeWrap!, !isVisible)
  })

  document.body.appendChild(toggleBtn)
  document.body.appendChild(iframeWrap)

  return { toggle: toggleBtn, wrap: iframeWrap, iframe }
}

// Public API — call from app.ts when the active room changes.
export const updateLeitbildPanelForRoom = async (roomName: string | undefined): Promise<void> => {
  currentRoomName = roomName
  pollAbort?.abort()
  pollAbort = new AbortController()

  const { toggle, wrap, iframe: ifr } = ensureDOM()

  if (!roomName) {
    styleToggle(toggle, false)
    styleIframeWrap(wrap, false)
    return
  }

  const status = await fetchMirrorStatus(roomName, pollAbort.signal)
  // Guard against stale resolves if user switched rooms during the fetch.
  if (currentRoomName !== roomName) return

  if (!status?.status) {
    styleToggle(toggle, false)
    styleIframeWrap(wrap, false)
    ifr.src = 'about:blank'
    return
  }

  const url = spaUrl(status.status.baseUrl, status.status.instanceId)
  if (ifr.src !== url) ifr.src = url
  styleToggle(toggle, true)
}
