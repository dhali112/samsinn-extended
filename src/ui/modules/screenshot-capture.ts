// ============================================================================
// screenshot-capture — capture the rect of an iframe via getDisplayMedia
// + ImageCapture (Chrome path) or hidden-video + drawImage (Safari path).
//
// Extracted from leitbild-iframe-panel.ts so the panel stays focused on
// UI concerns, and so Phase B (server-side capture via Leitbild postMessage)
// can later drop in as an alternate implementation at this interface.
//
// Browser support:
//   - Chrome / Edge / Brave   : ImageCapture path (fast, reliable)
//   - Safari                  : video-element fallback path (works)
//   - Firefox / Zen / Gecko   : NOT SUPPORTED — drawImage on a stream
//                                containing cross-origin embedded content
//                                (the Leitbild iframe) throws an irrecoverable
//                                taint error. Caller should short-circuit on
//                                the user-agent check exported here.
//
// Behavior contract:
//   - Returns a discriminated union: { ok: true, ... } | { ok: false, ... }
//   - On ok=false with unsupported=true, the UA is a known-bad browser
//     (caller's UX should be a "use Chrome or Safari" toast, NOT a generic
//     error).
//   - Cleans up MediaStream tracks + the hidden video element in all exit
//     paths (success / failure / unsupported).
//
// Threat model: this runs purely client-side. The captured PNG goes into
// the composer attachments store; uploads happen via the existing message-
// post path. No server-side handling here.
// ============================================================================

export interface CaptureSuccess {
  readonly ok: true
  readonly dataUrl: string
  readonly width: number
  readonly height: number
  readonly mimeType: 'image/png'
}

export interface CaptureFailure {
  readonly ok: false
  readonly reason: string
  // True when failure was the known-bad browser short-circuit (Firefox/Zen
  // cross-origin taint). Caller surfaces a different message ("use Chrome").
  readonly unsupported?: boolean
}

export type CaptureResult = CaptureSuccess | CaptureFailure

// Detect the known-bad browsers (Firefox + Gecko forks). Exported so the
// caller can show a clear "use Chrome or Safari" UX BEFORE invoking
// captureIframeRect — getDisplayMedia would otherwise prompt the user
// for permission they can't actually use.
export const isCaptureUnsupportedBrowser = (): boolean =>
  /firefox|zen|gecko\/2/i.test(navigator.userAgent)

export const isGetDisplayMediaAvailable = (): boolean =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia

// Capture a cropped screenshot of the given iframe's bounding rect.
// Always cleans up the MediaStream + hidden video. Never throws —
// returns { ok: false } on every failure path.
export const captureIframeRect = async (iframe: HTMLIFrameElement): Promise<CaptureResult> => {
  if (isCaptureUnsupportedBrowser()) {
    return { ok: false, reason: 'browser-not-supported', unsupported: true }
  }
  if (!isGetDisplayMediaAvailable()) {
    return { ok: false, reason: 'getDisplayMedia not available in this browser' }
  }

  // Snapshot iframe rect BEFORE the OS picker steals focus.
  const rect = iframe.getBoundingClientRect()

  let stream: MediaStream | undefined
  let video: HTMLVideoElement | undefined
  const cleanup = (): void => {
    // Each step independently best-effort. A failure in stopping tracks
    // must NOT prevent srcObject teardown or DOM removal — capture flow
    // may have partial state (stream acquired but ImageCapture rejected;
    // video appended but never played). One failure shouldn't leak the
    // others.
    try { stream?.getTracks().forEach(t => t.stop()) } catch { /* MediaStream may already be ended; nothing to recover */ }
    try { if (video) video.srcObject = null } catch { /* video element may be detached; assignment harmless either way */ }
    try { video?.remove() } catch { /* already removed via earlier teardown path; idempotent */ }
  }

  try {
    // preferCurrentTab + selfBrowserSurface make Chrome show (and pre-select)
    // the current tab in the picker; Firefox ignores these (and is short-
    // circuited above anyway).
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' } as MediaTrackConstraints,
      audio: false,
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    } as DisplayMediaStreamOptions & { preferCurrentTab?: boolean; selfBrowserSurface?: string })
    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('No video track in capture stream')

    // Get frame dimensions + a drawable source. Two paths:
    //   A. ImageCapture.grabFrame() — works for Chrome's displayMedia tracks.
    //      Firefox supports ImageCapture but NOT for displayMedia tracks
    //      (camera-only per MDN); we catch the throw and fall through to B.
    //   B. Video element — append hidden, await first frame, drawImage.
    //      Works in Safari.
    let frame: ImageBitmap | HTMLVideoElement
    let frameW: number
    let frameH: number

    const ImageCaptureCtor = (window as unknown as { ImageCapture?: new (t: MediaStreamTrack) => { grabFrame: () => Promise<ImageBitmap> } }).ImageCapture
    let bitmap: ImageBitmap | undefined
    if (ImageCaptureCtor) {
      try {
        const ic = new ImageCaptureCtor(track)
        bitmap = await ic.grabFrame()
      } catch {
        bitmap = undefined  // fall through to video path
      }
    }

    if (bitmap) {
      frame = bitmap
      frameW = bitmap.width
      frameH = bitmap.height
    } else {
      video = document.createElement('video')
      video.srcObject = stream
      video.muted = true
      video.playsInline = true
      video.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0'
      document.body.appendChild(video)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Capture stream timed out (loadedmetadata)')), 5000)
        video!.addEventListener('loadedmetadata', () => { clearTimeout(t); resolve() }, { once: true })
        video!.addEventListener('error', () => { clearTimeout(t); reject(new Error('Capture stream errored')) }, { once: true })
      })
      await video.play()
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Capture stream timed out (playing)')), 5000)
        if (!video!.paused && video!.readyState >= 2) { clearTimeout(t); resolve(); return }
        video!.addEventListener('playing', () => { clearTimeout(t); resolve() }, { once: true })
      })
      await new Promise(r => requestAnimationFrame(r))
      await new Promise(r => requestAnimationFrame(r))
      frame = video
      frameW = video.videoWidth
      frameH = video.videoHeight
    }

    if (frameW === 0 || frameH === 0) {
      cleanup()
      return { ok: false, reason: 'Capture frame has zero dimensions' }
    }

    // Crop to the iframe's bounding rect. Map CSS-pixel viewport coords to
    // frame-pixel coords using the actual capture dimensions (browsers
    // often downscale the captured stream).
    const ratioX = frameW / window.innerWidth
    const ratioY = frameH / window.innerHeight
    const sxRaw = Math.round(rect.left * ratioX)
    const syRaw = Math.round(rect.top * ratioY)
    const swRaw = Math.round(rect.width * ratioX)
    const shRaw = Math.round(rect.height * ratioY)
    const sx = Math.max(0, Math.min(sxRaw, Math.max(0, frameW - 1)))
    const sy = Math.max(0, Math.min(syRaw, Math.max(0, frameH - 1)))
    const sw = Math.max(1, Math.min(swRaw, frameW - sx))
    const sh = Math.max(1, Math.min(shRaw, frameH - sy))

    const canvas = document.createElement('canvas')
    canvas.width = sw
    canvas.height = sh
    const cx = canvas.getContext('2d')
    if (!cx) {
      cleanup()
      return { ok: false, reason: 'Could not get 2D canvas context' }
    }
    cx.drawImage(frame, sx, sy, sw, sh, 0, 0, sw, sh)
    const dataUrl = canvas.toDataURL('image/png')

    cleanup()
    return { ok: true, dataUrl, width: sw, height: sh, mimeType: 'image/png' }
  } catch (err) {
    cleanup()
    const rawMsg = err instanceof Error ? err.message : String(err)
    // Firefox: 'The object can not be found here' is the misleading error
    // Firefox throws when drawImage is called on a video that contains
    // cross-origin embedded content. We short-circuit Firefox above, but
    // some other Gecko fork might slip through — surface a clearer message.
    const isCrossOriginTaint = /object\s+can\s*not\s+be\s+found/i.test(rawMsg)
    if (isCrossOriginTaint) {
      return { ok: false, reason: 'Cross-origin taint blocks capture in this browser', unsupported: true }
    }
    return { ok: false, reason: rawMsg }
  }
}
