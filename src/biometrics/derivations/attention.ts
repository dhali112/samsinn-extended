// Attention derivation: how confidently is the user looking at the screen?
//
// Output is a scalar 0..1 where 1 = direct screen-facing, 0 = clearly looking
// away. Combines two signals:
//
//   1. Head pose (yaw + pitch). The further the head turns, the lower the
//      attention. Roll is excluded — head tilt doesn't imply looking away.
//      The cutoff is ~30° (0.52 rad) on either axis; beyond that we treat
//      attention as zero.
//
//   2. Eye-look blendshapes (eyeLookIn/Out/Up/Down). The model returns
//      values 0..1 per direction; large values mean the eyes have darted
//      that way. We average the magnitudes and discount.
//
// The two signals multiply — both must be "facing forward" for high attention.
// This is calibration-free; no per-user training. It's a heuristic, not a
// gold-standard gaze estimator. For true screen-coordinate gaze, WebGazer
// or a commercial tracker is required (out of scope for v1).

const HEAD_POSE_CUTOFF_RAD = 0.52   // ~30°

const headPoseScore = (yaw: number, pitch: number): number => {
  const yawAbs = Math.min(Math.abs(yaw) / HEAD_POSE_CUTOFF_RAD, 1)
  const pitchAbs = Math.min(Math.abs(pitch) / HEAD_POSE_CUTOFF_RAD, 1)
  // Magnitude in pose space; map to a 1..0 attention factor.
  const magnitude = Math.min(Math.hypot(yawAbs, pitchAbs), 1)
  return 1 - magnitude
}

// Inputs are blendshape category scores by name. We accept a Map so callers
// can pass MediaPipe's output directly without intermediate conversion.
const eyeLookScore = (blendshapes: ReadonlyMap<string, number>): number => {
  const v = (k: string) => blendshapes.get(k) ?? 0
  // Average magnitude across left+right eye and the four directions. Any
  // sustained look in any direction reduces attention.
  const avg = (
    v('eyeLookInLeft') + v('eyeLookOutLeft') +
    v('eyeLookUpLeft') + v('eyeLookDownLeft') +
    v('eyeLookInRight') + v('eyeLookOutRight') +
    v('eyeLookUpRight') + v('eyeLookDownRight')
  ) / 8
  // Most "neutral" gaze still produces small (~0.05) values; subtract a
  // dead-zone so steady eyes register as 1.0 attention.
  const adjusted = Math.max(0, avg - 0.1)
  return 1 - Math.min(adjusted * 2, 1)
}

export const computeAttention = (
  yaw: number,
  pitch: number,
  blendshapes: ReadonlyMap<string, number>,
): number => {
  const head = headPoseScore(yaw, pitch)
  const eye = eyeLookScore(blendshapes)
  return Math.max(0, Math.min(1, head * eye))
}
