// Presence derivation: face count → boolean + integer.
// Trivial — kept as a separate module so the package's signal-builder has a
// uniform import surface.

export const computePresence = (faceCount: number): { presence: boolean; faceCount: number } => ({
  presence: faceCount > 0,
  faceCount: Math.max(0, faceCount),
})
