// Blink-rate tracker: counts eye-blink transitions and reports a rolling
// blinks-per-minute over a 30-second window.
//
// Detection rule: both eyes' blink blendshape > 0.5, then both back below
// 0.3 (small hysteresis to avoid flutter). Each high→low transition counts
// as one blink. Only blinks within the last 30 s contribute to the rate;
// older entries are evicted on each call.

const HIGH_THRESHOLD = 0.5
const LOW_THRESHOLD = 0.3
const WINDOW_MS = 30_000

export interface BlinkTracker {
  readonly update: (eyeBlinkLeft: number, eyeBlinkRight: number, ts: number) => void
  readonly rate: (ts: number) => number   // blinks per minute over last 30 s
  readonly reset: () => void
}

export const createBlinkTracker = (): BlinkTracker => {
  let inBlink = false
  const blinkTimes: number[] = []

  const evictOld = (ts: number): void => {
    const cutoff = ts - WINDOW_MS
    while (blinkTimes.length > 0 && blinkTimes[0]! < cutoff) blinkTimes.shift()
  }

  return {
    update: (left, right, ts) => {
      const both = (left + right) / 2
      if (!inBlink && both > HIGH_THRESHOLD) {
        inBlink = true
      } else if (inBlink && both < LOW_THRESHOLD) {
        inBlink = false
        blinkTimes.push(ts)
      }
      evictOld(ts)
    },
    rate: (ts) => {
      evictOld(ts)
      if (blinkTimes.length === 0) return 0
      // Scale partial-window samples up: e.g. if we've only been running
      // 10 s, multiply by 6 to get a per-minute estimate.
      const oldest = blinkTimes[0]!
      const elapsed = Math.max(1000, ts - oldest)
      return (blinkTimes.length * 60_000) / elapsed
    },
    reset: () => {
      inBlink = false
      blinkTimes.length = 0
    },
  }
}
