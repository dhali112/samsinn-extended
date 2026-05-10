// Shared "retry in Ns" countdown formatter for provider/model UI surfaces.
// retryAt is an absolute timestamp (ms epoch); we render seconds remaining,
// clamped to 0 so a stale retryAt never shows negative.

export const retryRemainingSeconds = (retryAt: number, now: () => number = Date.now): number =>
  Math.max(0, Math.round((retryAt - now()) / 1000))
