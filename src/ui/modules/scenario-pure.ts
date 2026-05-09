// Pure helpers extracted from the scenario UI modules so they're unit-
// testable without a DOM. The DOM-bound modules (scenario-overlay.ts,
// scenario-share-link.ts) call these and otherwise focus on side effects.

// === Share-link ID parsing ===
//
// Accepts `<pack>/<name>`. Both segments must be non-empty. A name segment
// containing additional slashes is rejected (the store keys ids on a single
// `pack/name` pair; deeper paths aren't installable).

export type ParseScenarioIdResult =
  | { readonly ok: true; readonly pack: string; readonly name: string }
  | { readonly ok: false; readonly reason: string }

export const parseScenarioId = (id: string): ParseScenarioIdResult => {
  if (!id) return { ok: false, reason: 'empty id' }
  const slash = id.indexOf('/')
  if (slash < 1) return { ok: false, reason: 'missing pack prefix (expected "pack/name")' }
  if (slash === id.length - 1) return { ok: false, reason: 'missing name (expected "pack/name")' }
  const pack = id.slice(0, slash)
  const name = id.slice(slash + 1)
  if (name.includes('/')) return { ok: false, reason: 'name must not contain slashes' }
  return { ok: true, pack, name }
}

// === Tooltip placement ===
//
// Pure geometry: given the bounding box of the anchor element and the
// tooltip's own dimensions plus the viewport size, compute the {left, top}
// to position the tooltip near the anchor without spilling off-screen.
// Returns center-of-viewport coords (with a `useTransform` flag indicating
// the caller should apply `transform: translate(-50%, -50%)`) when no
// anchor rect is given.

export interface Rect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly width: number
  readonly height: number
}

export interface Viewport {
  readonly innerWidth: number
  readonly innerHeight: number
}

export interface Placement {
  readonly left: number
  readonly top: number
  readonly useTransform: boolean   // true → caller applies translate(-50%, -50%)
}

const MARGIN = 8
const EDGE_PAD = 8

export const computeTooltipPlacement = (
  anchor: Rect | null,
  tooltipDims: { width: number; height: number },
  viewport: Viewport,
): Placement => {
  if (!anchor) {
    return {
      left: viewport.innerWidth / 2,
      top: viewport.innerHeight / 2,
      useTransform: true,
    }
  }
  // Default: pin to the right of the anchor.
  let left = anchor.right + MARGIN
  let top = anchor.top
  // Spilling off the right edge: try to the left of the anchor instead.
  if (left + tooltipDims.width > viewport.innerWidth - EDGE_PAD) {
    left = Math.max(EDGE_PAD, anchor.left - tooltipDims.width - MARGIN)
  }
  // Spilling off the bottom edge: shift up so the bottom sits inside the viewport.
  if (top + tooltipDims.height > viewport.innerHeight - EDGE_PAD) {
    top = Math.max(EDGE_PAD, viewport.innerHeight - tooltipDims.height - EDGE_PAD)
  }
  return { left, top, useTransform: false }
}
