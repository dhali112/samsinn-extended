// Expression derivation: project MediaPipe's 52 ARKit blendshapes down to
// four interpretable scalars (smile / surprise / frown / concentration).
//
// Why not a learned 7-class FER classifier? Because the 7-class FER datasets
// are frozen, brittle, and uninterpretable. Blendshape combinations are
// transparent — the formulas below are auditable and trivially tunable per
// use case if needed. Each output is clamped 0..1.

import type { ExpressionScores } from '../types.ts'

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x))

export const computeExpression = (blendshapes: ReadonlyMap<string, number>): ExpressionScores => {
  const v = (k: string): number => blendshapes.get(k) ?? 0

  // Smile: mouth corners pulled outward. Average left + right.
  const smile = clamp01((v('mouthSmileLeft') + v('mouthSmileRight')) / 2)

  // Surprise: jaw drop combined with raised inner brow. Multiplicative
  // because either alone is more often something else (yawn / squint).
  const surprise = clamp01(v('jawOpen') * (v('browInnerUp') * 2))

  // Frown: mouth corners pulled down + furrowed brow.
  const frown = clamp01(
    ((v('mouthFrownLeft') + v('mouthFrownRight')) / 2) * 0.6 +
    ((v('browDownLeft') + v('browDownRight')) / 2) * 0.4,
  )

  // Concentration: brow furrowed + slight eye squint, NO smile/surprise.
  // We subtract smile/surprise so a happy or shocked face isn't read as
  // "concentrating".
  const browDown = (v('browDownLeft') + v('browDownRight')) / 2
  const eyeSquint = (v('eyeSquintLeft') + v('eyeSquintRight')) / 2
  const concentration = clamp01(
    browDown * 0.7 + eyeSquint * 0.3 - smile * 0.5 - surprise * 0.5,
  )

  return { smile, surprise, frown, concentration }
}
