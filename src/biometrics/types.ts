// Biometric signal types — emitted by createBiometricSession on every
// inference frame and surfaced via session.read().
//
// The package treats these as opaque-ish data — server-side consumers and
// the inline widget interpret them per the documented derivation formulas.

export interface ExpressionScores {
  // Each component is 0..1, derived from MediaPipe's 52 ARKit blendshapes.
  // Formulas are documented in derivations/expression.ts.
  readonly smile: number
  readonly surprise: number
  readonly frown: number
  readonly concentration: number
}

export interface HeadPose {
  // Radians. Yaw = left/right, pitch = up/down, roll = head tilt.
  // Derived from MediaPipe's facial transformation matrix.
  readonly yaw: number
  readonly pitch: number
  readonly roll: number
}

export interface BiometricSignal {
  readonly ts: number              // wall-clock ms when sampled
  readonly presence: boolean       // is at least one face detected
  readonly faceCount: number       // 0, 1, or 2 (FaceLandmarker is configured for max 2)
  readonly attention: number       // 0..1; 1 = looking at screen, 0 = looking away
  readonly expression: ExpressionScores
  readonly headPose: HeadPose
  readonly blinkRate: number       // blinks per minute over rolling 30 s window
}

export interface CaptureResolution {
  readonly width: number
  readonly height: number
}

export interface CaptureConfig {
  // Caller-provided <video> element receiving the camera stream.
  readonly videoEl: HTMLVideoElement
  // Caller-provided <canvas> sized to match resolution; landmark overlay drawn here.
  readonly canvasEl: HTMLCanvasElement
  // Optional resolution override. Default 320×240. The actual constraints
  // requested from getUserMedia use these as ideal values; the browser may
  // negotiate down. Higher resolution = more detail but more CPU per frame.
  readonly resolution?: CaptureResolution
  // Optional camera device id from navigator.mediaDevices.enumerateDevices().
  // When omitted, the browser picks a default.
  readonly deviceId?: string
}

export interface CaptureSession {
  readonly start: () => Promise<void>
  readonly read: () => BiometricSignal | null
  readonly stop: () => Promise<void>
  // Re-bind the live MediaStream + face-landmark overlay to a different
  // pair of video/canvas elements without restarting the session. Used
  // by the widget when the chat re-renders and the original video
  // element is detached.
  readonly retarget: (videoEl: HTMLVideoElement, canvasEl: HTMLCanvasElement) => Promise<void>
  // Push channel for mid-stream errors (loader failure, model fetch, lost
  // device). Returns an unsubscribe function. The widget surfaces these as
  // inline-error states.
  readonly onError: (cb: (e: Error) => void) => () => void
}

export const DEFAULT_RESOLUTION: CaptureResolution = { width: 320, height: 240 }
