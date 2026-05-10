// FaceLandmarker driver: spins up a MediaPipe FaceLandmarker, runs it over
// each video frame, and converts each result into a BiometricSignal.
//
// The driver is stateless across captures — each call to createFaceDriver
// builds a fresh FaceLandmarker, blink tracker, and a closure over the
// caller's video/canvas. Caller is responsible for stopping the driver
// before the video element is unmounted.

import { ensureMediaPipe, getWasmBaseUrl, type FaceLandmarkerInstance, type FaceLandmarkerResult } from '../api.ts'
import { computeAttention } from '../derivations/attention.ts'
import { computeExpression } from '../derivations/expression.ts'
import { computePresence } from '../derivations/presence.ts'
import { createBlinkTracker } from '../derivations/blink.ts'
import type { BiometricSignal, HeadPose } from '../types.ts'

export interface FaceDriver {
  readonly run: (videoEl: HTMLVideoElement, ts: number) => BiometricSignal | null
  readonly drawOverlay: (canvasEl: HTMLCanvasElement, videoEl: HTMLVideoElement) => void
  readonly close: () => void
}

// Convert FaceLandmarker's facial transformation matrix (column-major 4x4)
// into yaw/pitch/roll euler angles. Standard rotation extraction; values
// are radians. We use the upper-left 3x3 rotation submatrix.
const matrixToEuler = (m: ReadonlyArray<number>): HeadPose => {
  // Column-major: m[0..3] is column 0, m[4..7] is column 1, m[8..11] is column 2.
  // Rotation submatrix elements (row, col):
  //   r00 = m[0], r10 = m[1], r20 = m[2]
  //   r01 = m[4], r11 = m[5], r21 = m[6]
  //   r02 = m[8], r12 = m[9], r22 = m[10]
  const r10 = m[1] ?? 0
  const r20 = m[2] ?? 0
  const r21 = m[6] ?? 0
  const r22 = m[10] ?? 0
  const r00 = m[0] ?? 1
  const yaw = Math.atan2(-r20, Math.hypot(r21, r22))
  const pitch = Math.atan2(r21, r22)
  const roll = Math.atan2(r10, r00)
  return { yaw, pitch, roll }
}

const blendshapesToMap = (result: FaceLandmarkerResult): ReadonlyMap<string, number> => {
  const map = new Map<string, number>()
  const cats = result.faceBlendshapes?.[0]?.categories
  if (!cats) return map
  for (const c of cats) map.set(c.categoryName, c.score)
  return map
}

const buildSignal = (result: FaceLandmarkerResult, ts: number, blinkRate: number): BiometricSignal => {
  const faceCount = result.faceLandmarks?.length ?? 0
  const presence = computePresence(faceCount)
  const blendshapes = blendshapesToMap(result)
  const matrix = result.facialTransformationMatrixes?.[0]?.data ?? []
  const headPose = matrixToEuler(matrix)
  return {
    ts,
    presence: presence.presence,
    faceCount: presence.faceCount,
    attention: faceCount === 0 ? 0 : computeAttention(headPose.yaw, headPose.pitch, blendshapes),
    expression: computeExpression(blendshapes),
    headPose,
    blinkRate,
  }
}

export const createFaceDriver = async (): Promise<FaceDriver> => {
  const bundle = await ensureMediaPipe()
  const fileset = await bundle.FilesetResolver.forVisionTasks(getWasmBaseUrl())
  const landmarker: FaceLandmarkerInstance = await bundle.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: bundle.modelUrl, delegate: 'GPU' },
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    runningMode: 'VIDEO',
    numFaces: 2,
  })
  const blinks = createBlinkTracker()
  let lastResult: FaceLandmarkerResult | null = null
  let closed = false

  return {
    run: (videoEl, ts) => {
      if (closed) return null
      // detectForVideo requires a monotonically increasing timestamp. The
      // caller passes the rAF time, which is monotonic by spec.
      let result: FaceLandmarkerResult
      try {
        result = landmarker.detectForVideo(videoEl, ts)
      } catch {
        return null
      }
      lastResult = result
      const blendshapes = blendshapesToMap(result)
      blinks.update(blendshapes.get('eyeBlinkLeft') ?? 0, blendshapes.get('eyeBlinkRight') ?? 0, ts)
      return buildSignal(result, ts, blinks.rate(ts))
    },
    drawOverlay: (canvasEl, videoEl) => {
      const ctx = canvasEl.getContext('2d')
      if (!ctx) return
      // Match the canvas to the video's intrinsic dimensions so coordinates
      // map 1:1; the caller usually sets these to match the requested
      // CaptureResolution.
      canvasEl.width = videoEl.videoWidth || canvasEl.width
      canvasEl.height = videoEl.videoHeight || canvasEl.height
      ctx.clearRect(0, 0, canvasEl.width, canvasEl.height)
      const lm = lastResult?.faceLandmarks?.[0]
      if (!lm) return
      ctx.fillStyle = 'rgba(34, 197, 94, 0.85)'
      for (const p of lm) {
        ctx.beginPath()
        ctx.arc(p.x * canvasEl.width, p.y * canvasEl.height, 1.2, 0, Math.PI * 2)
        ctx.fill()
      }
    },
    close: () => {
      if (closed) return
      closed = true
      try { landmarker.close() } catch { /* ignore */ }
    },
  }
}
