// Public API for the biometrics package.
//
// COUPLING RULE: this package imports nothing from src/core/, src/agents/,
// src/api/, src/ui/. It is a leaf package designed for future extraction
// to its own repository. Don't add Samsinn-specific imports here.
//
// Lifecycle:
//   const session = createBiometricSession({ videoEl, canvasEl, resolution })
//   await session.start()         // requests getUserMedia, loads MediaPipe,
//                                  // begins rAF loop
//   const signal = session.read() // sync; latest snapshot or null
//   await session.stop()           // releases stream + tears down loop
//
// Resolution defaults to 320×240. Callers can override per the design doc;
// higher resolution costs more CPU per frame.

import { createFaceDriver, type FaceDriver } from './modules/face.ts'
import {
  type CaptureConfig,
  type CaptureSession,
  type BiometricSignal,
  DEFAULT_RESOLUTION,
} from './types.ts'

export type {
  CaptureConfig,
  CaptureSession,
  BiometricSignal,
  ExpressionScores,
  HeadPose,
  CaptureResolution,
} from './types.ts'

export { DEFAULT_RESOLUTION } from './types.ts'

export const createBiometricSession = (config: CaptureConfig): CaptureSession => {
  const resolution = config.resolution ?? DEFAULT_RESOLUTION
  let driver: FaceDriver | null = null
  let stream: MediaStream | null = null
  let rafHandle: number | null = null
  let latest: BiometricSignal | null = null
  let started = false
  let stopped = false
  // Mutable view-side bindings. retarget() swaps these when the widget
  // gets re-mounted into a fresh DOM (chat re-render, room switch back).
  // The rAF loop reads these every frame instead of capturing config.*
  // in its closure, so the live MediaStream keeps painting the
  // currently-attached video element.
  let currentVideoEl: HTMLVideoElement = config.videoEl
  let currentCanvasEl: HTMLCanvasElement = config.canvasEl

  const errorListeners = new Set<(e: Error) => void>()
  const emitError = (e: Error): void => {
    for (const cb of errorListeners) {
      try { cb(e) } catch { /* ignore */ }
    }
  }

  const loop = (): void => {
    if (stopped || !driver) return
    rafHandle = requestAnimationFrame(loop)
    try {
      const ts = performance.now()
      const signal = driver.run(currentVideoEl, ts)
      if (signal) latest = signal
      driver.drawOverlay(currentCanvasEl, currentVideoEl)
    } catch (err) {
      emitError(err instanceof Error ? err : new Error(String(err)))
    }
  }

  return {
    start: async (): Promise<void> => {
      if (started) return
      started = true
      try {
        const constraints: MediaStreamConstraints = {
          video: {
            width: { ideal: resolution.width },
            height: { ideal: resolution.height },
            ...(config.deviceId ? { deviceId: { exact: config.deviceId } } : {}),
          },
          audio: false,
        }
        stream = await navigator.mediaDevices.getUserMedia(constraints)
        currentVideoEl.srcObject = stream
        currentVideoEl.muted = true
        // playsInline keeps the video element from going full-screen on iOS;
        // harmless on desktop and consistent across platforms.
        currentVideoEl.setAttribute('playsinline', '')
        await currentVideoEl.play()
        // Match canvas intrinsic size to the negotiated track size where
        // possible — falls back to requested resolution if videoWidth is
        // not yet available (some browsers report 0 until first frame).
        currentCanvasEl.width = currentVideoEl.videoWidth || resolution.width
        currentCanvasEl.height = currentVideoEl.videoHeight || resolution.height
        driver = await createFaceDriver()
        loop()
      } catch (err) {
        stopped = true
        const e = err instanceof Error ? err : new Error(String(err))
        emitError(e)
        throw e
      }
    },
    // Re-attach the live MediaStream to a different pair of video/canvas
    // elements without restarting the session. Used by the widget when
    // the chat re-renders and the original video element is detached —
    // without retargeting, the stream keeps playing into the orphaned
    // node and the user sees a black box in the new wrapper.
    retarget: async (videoEl: HTMLVideoElement, canvasEl: HTMLCanvasElement): Promise<void> => {
      currentVideoEl = videoEl
      currentCanvasEl = canvasEl
      if (stream) {
        videoEl.srcObject = stream
        videoEl.muted = true
        videoEl.setAttribute('playsinline', '')
        canvasEl.width = videoEl.videoWidth || resolution.width
        canvasEl.height = videoEl.videoHeight || resolution.height
        try { await videoEl.play() } catch { /* autoplay may reject; live tracks still drive frames */ }
      }
    },
    read: () => latest,
    stop: async (): Promise<void> => {
      // Always run track teardown. The previous short-circuit on `stopped`
      // assumed start() was the only path that allocated resources, which
      // is fragile — if anything else flipped `stopped` (a start-failure
      // path, a future cleanup helper) the MediaStream would leak. Track
      // .stop() is idempotent at the browser level, so re-stopping is
      // safe. `started` still guards start() from being re-entered.
      stopped = true
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle)
        rafHandle = null
      }
      try { driver?.close() } catch { /* ignore */ }
      driver = null
      if (stream) {
        for (const track of stream.getTracks()) {
          try { track.stop() } catch { /* ignore */ }
        }
        stream = null
      }
      try { currentVideoEl.srcObject = null } catch { /* ignore */ }
    },
    onError: (cb) => {
      errorListeners.add(cb)
      return () => errorListeners.delete(cb)
    },
  }
}
