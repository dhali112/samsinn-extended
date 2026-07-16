// Trend rendering — WinCC-OnlineTrendControl-style historical trends.
//
//   renderTrendBlocks(container) — post-processes ```trend code fences inside
//     a rendered markdown container (registered like mermaid/map).
//
// Envelope (produced by the plant-trends skill's trend_query tool):
//   {
//     title?, from, to,                      // epoch seconds
//     series: [{ tag, label?, unit, kind: 'analog'|'binary'|'power',
//                step?, limits?: {low?,high?,highHigh?},
//                stats?, points: [[ts,v],...] }],
//     events?: [{ t, tag, level: 'HIGH'|'HIHI'|'LOW'|'ROC'|'STATE', text }]
//   }
//
// Interactive controls (no external libs — hand-rolled SVG):
//   - series toggle chips (click to show/hide a trace)
//   - time-window <select> (15m … All) filtering within the embedded data
// Behavior rules:
//   - binary series render stepped in dedicated lanes below the plot
//   - power series show trapezoid-integrated energy (MWh) for the visible
//     window in their chip
//   - alarm limits render as dashed lines; events as vertical markers with
//     native-tooltip text
// Axis policy: first unit among visible analog series → left axis; second
// unit → right axis; any further units are min-max normalized (chip marked
// "norm").

import { addPostRenderProcessor } from '../extensions/post-render-registry.ts'

interface TrendSeries {
  readonly tag: string
  readonly label?: string
  readonly unit: string
  readonly kind: 'analog' | 'binary' | 'power'
  readonly step?: boolean
  readonly limits?: { low?: number; high?: number; highHigh?: number }
  readonly points: ReadonlyArray<readonly [number, number]>
}

interface TrendEvent { readonly t: number; readonly tag: string; readonly level: string; readonly text: string }

interface TrendEnvelope {
  readonly title?: string
  readonly from: number
  readonly to: number
  readonly series: ReadonlyArray<TrendSeries>
  readonly events?: ReadonlyArray<TrendEvent>
}

const PALETTE = ['#2563eb', '#f59e0b', '#059669', '#8b5cf6', '#0891b2', '#d946ef', '#84cc16', '#f97316']
const EVENT_COLOR: Record<string, string> = {
  HIHI: '#dc2626', HIGH: '#ea580c', LOW: '#0284c7', ROC: '#9333ea', STATE: '#6b7280',
}
const WINDOW_CHOICES: ReadonlyArray<readonly [label: string, seconds: number]> = [
  ['15m', 900], ['1h', 3600], ['4h', 14400], ['8h', 28800], ['24h', 86400],
]

const SVGNS = 'http://www.w3.org/2000/svg'
const el = <K extends string>(tag: K, attrs: Record<string, string | number> = {}): SVGElement => {
  const node = document.createElementNS(SVGNS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

const hhmm = (ts: number): string => {
  const d = new Date(ts * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const dayHhmm = (ts: number): string => {
  const d = new Date(ts * 1000)
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hhmm(ts)}`
}

const niceTicks = (min: number, max: number, count: number): number[] => {
  if (!isFinite(min) || !isFinite(max) || min === max) { const v = isFinite(min) ? min : 0; return [v - 1, v, v + 1] }
  const span = max - min
  const step0 = span / count
  const mag = Math.pow(10, Math.floor(Math.log10(step0)))
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) ?? mag * 10
  const start = Math.ceil(min / step) * step
  const out: number[] = []
  for (let v = start; v <= max + step * 1e-6; v += step) out.push(+v.toFixed(6))
  return out
}

const parseEnvelope = (source: string): TrendEnvelope | null => {
  try {
    const raw = JSON.parse(source) as TrendEnvelope
    if (!raw || !Array.isArray(raw.series)) return null
    for (const s of raw.series) if (!Array.isArray(s.points)) return null
    return raw
  } catch { return null }
}

// Trapezoidal MWh over visible (already-downsampled) points — approximate,
// labeled with ≈ in the chip.
const energyMWh = (pts: ReadonlyArray<readonly [number, number]>): number => {
  let mwS = 0
  for (let i = 1; i < pts.length; i++) mwS += (pts[i]![1] + pts[i - 1]![1]) / 2 * (pts[i]![0] - pts[i - 1]![0])
  return mwS / 3600
}

const buildPath = (
  pts: ReadonlyArray<readonly [number, number]>,
  x: (t: number) => number, y: (v: number) => number, stepped: boolean,
): string => {
  let d = ''
  for (let i = 0; i < pts.length; i++) {
    const px = x(pts[i]![0]), py = y(pts[i]![1])
    if (i === 0) d += `M${px.toFixed(1)},${py.toFixed(1)}`
    else if (stepped) d += `H${px.toFixed(1)}V${py.toFixed(1)}`
    else d += `L${px.toFixed(1)},${py.toFixed(1)}`
  }
  return d
}

const render = (
  wrapper: HTMLElement, env: TrendEnvelope,
  state: { hidden: Set<string>; windowS: number | null },
): void => {
  wrapper.textContent = ''
  const colorOf = new Map(env.series.map((s, i) => [s.tag, PALETTE[i % PALETTE.length]!]))

  const to = env.to
  const from = state.windowS === null ? env.from : Math.max(env.from, to - state.windowS)
  const inWindow = (s: TrendSeries): Array<readonly [number, number]> => {
    const pts = s.points.filter(p => p[0] >= from && p[0] <= to)
    // Keep the last point before the window edge so lines/lanes enter from the left.
    const before = s.points.filter(p => p[0] < from)
    if (before.length > 0) pts.unshift([from, before[before.length - 1]![1]])
    return pts
  }

  // --- Toolbar: title, window select, series chips ---
  const bar = document.createElement('div')
  bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;font-size:12px'
  const title = document.createElement('span')
  title.textContent = env.title ?? 'Trend'
  title.style.cssText = 'font-weight:700;margin-right:auto'
  bar.appendChild(title)

  const sel = document.createElement('select')
  sel.style.cssText = 'font-size:12px;padding:1px 4px;border:1px solid rgba(128,128,128,.4);border-radius:4px;background:transparent;color:inherit'
  const total = env.to - env.from
  for (const [label, secs] of WINDOW_CHOICES) {
    if (secs >= total) continue
    const o = document.createElement('option')
    o.value = String(secs)
    o.textContent = `Last ${label}`
    if (state.windowS === secs) o.selected = true
    sel.appendChild(o)
  }
  const oAll = document.createElement('option')
  oAll.value = 'all'
  oAll.textContent = `All (${(total / 3600).toFixed(0)}h)`
  if (state.windowS === null) oAll.selected = true
  sel.appendChild(oAll)
  sel.onchange = () => {
    state.windowS = sel.value === 'all' ? null : Number(sel.value)
    render(wrapper, env, state)
  }
  bar.appendChild(sel)
  wrapper.appendChild(bar)

  const chips = document.createElement('div')
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:0 8px 6px;font-size:11px'
  wrapper.appendChild(chips)

  // --- Layout ---
  const width = Math.max(360, wrapper.clientWidth || 640)
  const visible = env.series.filter(s => !state.hidden.has(s.tag))
  const analog = visible.filter(s => s.kind !== 'binary')
  const binary = visible.filter(s => s.kind === 'binary')
  const laneH = 18
  const ml = 52, mr = 52, mt = 8
  const plotH = 220
  const lanesH = binary.length * (laneH + 4)
  const mb = 22
  const height = mt + plotH + lanesH + mb
  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}` }) as SVGSVGElement
  svg.style.display = 'block'

  const x = (t: number): number => ml + (t - from) / Math.max(1, to - from) * (width - ml - mr)

  // --- Axis groups: unit → series ---
  const unitOrder: string[] = []
  for (const s of analog) if (!unitOrder.includes(s.unit)) unitOrder.push(s.unit)
  const axisUnits = unitOrder.slice(0, 2)
  const groupDomain = (unit: string): { min: number; max: number } => {
    let min = Infinity, max = -Infinity
    for (const s of analog.filter(sr => sr.unit === unit)) {
      for (const p of inWindow(s)) { min = Math.min(min, p[1]); max = Math.max(max, p[1]) }
      if (s.limits?.high !== undefined) max = Math.max(max, s.limits.high)
      if (s.limits?.highHigh !== undefined) max = Math.max(max, s.limits.highHigh)
      if (s.limits?.low !== undefined) min = Math.min(min, s.limits.low)
    }
    if (!isFinite(min)) { min = 0; max = 1 }
    const pad = (max - min || 1) * 0.06
    return { min: min - pad, max: max + pad }
  }
  const domains = new Map(axisUnits.map(u => [u, groupDomain(u)]))
  const yFor = (s: TrendSeries): ((v: number) => number) => {
    if (axisUnits.includes(s.unit)) {
      const d = domains.get(s.unit)!
      return v => mt + plotH - (v - d.min) / (d.max - d.min) * plotH
    }
    // Normalized series (3rd+ unit): min-max of its own visible points
    const pts = inWindow(s)
    let mn = Infinity, mx = -Infinity
    for (const p of pts) { mn = Math.min(mn, p[1]); mx = Math.max(mx, p[1]) }
    if (!isFinite(mn) || mn === mx) { mn = 0; mx = 1 }
    return v => mt + plotH - (v - mn) / (mx - mn) * plotH
  }

  // --- Grid + left/right axis labels ---
  const leftDomain = axisUnits[0] ? domains.get(axisUnits[0])! : { min: 0, max: 1 }
  for (const tick of niceTicks(leftDomain.min, leftDomain.max, 5)) {
    const y = mt + plotH - (tick - leftDomain.min) / (leftDomain.max - leftDomain.min) * plotH
    if (y < mt - 1 || y > mt + plotH + 1) continue
    const line = el('line', { x1: ml, x2: width - mr, y1: y, y2: y, stroke: 'currentColor', 'stroke-opacity': 0.12 })
    svg.appendChild(line)
    const label = el('text', { x: ml - 6, y: y + 3.5, 'text-anchor': 'end', 'font-size': 10, fill: 'currentColor', 'fill-opacity': 0.65 })
    label.textContent = String(tick)
    svg.appendChild(label)
  }
  if (axisUnits[0]) {
    const uLabel = el('text', { x: ml - 6, y: mt + 2, 'text-anchor': 'end', 'font-size': 9, fill: 'currentColor', 'fill-opacity': 0.5 })
    uLabel.textContent = axisUnits[0]
    svg.appendChild(uLabel)
  }
  if (axisUnits[1]) {
    const d = domains.get(axisUnits[1])!
    for (const tick of niceTicks(d.min, d.max, 5)) {
      const y = mt + plotH - (tick - d.min) / (d.max - d.min) * plotH
      if (y < mt - 1 || y > mt + plotH + 1) continue
      const label = el('text', { x: width - mr + 6, y: y + 3.5, 'text-anchor': 'start', 'font-size': 10, fill: 'currentColor', 'fill-opacity': 0.65 })
      label.textContent = String(tick)
      svg.appendChild(label)
    }
    const uLabel = el('text', { x: width - mr + 6, y: mt + 2, 'text-anchor': 'start', 'font-size': 9, fill: 'currentColor', 'fill-opacity': 0.5 })
    uLabel.textContent = axisUnits[1]
    svg.appendChild(uLabel)
  }

  // --- X axis ticks ---
  const fmt = to - from > 26 * 3600 ? dayHhmm : hhmm
  const tickCount = 6
  for (let i = 0; i <= tickCount; i++) {
    const t = from + (to - from) * i / tickCount
    const px = x(t)
    svg.appendChild(el('line', { x1: px, x2: px, y1: mt + plotH, y2: mt + plotH + 4, stroke: 'currentColor', 'stroke-opacity': 0.4 }))
    const label = el('text', { x: px, y: height - 8, 'text-anchor': 'middle', 'font-size': 10, fill: 'currentColor', 'fill-opacity': 0.65 })
    label.textContent = fmt(t)
    svg.appendChild(label)
  }
  svg.appendChild(el('line', { x1: ml, x2: width - mr, y1: mt + plotH, y2: mt + plotH, stroke: 'currentColor', 'stroke-opacity': 0.4 }))

  // --- Limit lines (only for series on a real axis) ---
  for (const s of analog) {
    if (!s.limits || !axisUnits.includes(s.unit)) continue
    const y = yFor(s)
    const drawLimit = (v: number, text: string, color: string): void => {
      const ly = y(v)
      if (ly < mt || ly > mt + plotH) return
      svg.appendChild(el('line', { x1: ml, x2: width - mr, y1: ly, y2: ly, stroke: color, 'stroke-opacity': 0.7, 'stroke-dasharray': '6 4', 'stroke-width': 1 }))
      const label = el('text', { x: width - mr - 4, y: ly - 3, 'text-anchor': 'end', 'font-size': 9, fill: color })
      label.textContent = text
      svg.appendChild(label)
    }
    if (s.limits.highHigh !== undefined) drawLimit(s.limits.highHigh, `HIHI ${s.limits.highHigh}`, '#dc2626')
    if (s.limits.high !== undefined) drawLimit(s.limits.high, `HIGH ${s.limits.high}`, '#ea580c')
    if (s.limits.low !== undefined) drawLimit(s.limits.low, `LOW ${s.limits.low}`, '#0284c7')
  }

  // --- Analog traces ---
  for (const s of analog) {
    const pts = inWindow(s)
    if (pts.length === 0) continue
    const path = el('path', {
      d: buildPath(pts, x, yFor(s), !!s.step),
      fill: 'none', stroke: colorOf.get(s.tag)!, 'stroke-width': 1.6, 'stroke-linejoin': 'round',
    })
    svg.appendChild(path)
  }

  // --- Binary lanes (stepped, below the plot) ---
  binary.forEach((s, i) => {
    const laneTop = mt + plotH + 4 + i * (laneH + 4)
    const pts = inWindow(s)
    const y = (v: number): number => laneTop + (v >= 0.5 ? 2 : laneH - 2)
    svg.appendChild(el('rect', { x: ml, y: laneTop, width: width - ml - mr, height: laneH, fill: 'currentColor', 'fill-opacity': 0.05 }))
    // Shade ON intervals
    for (let j = 0; j < pts.length; j++) {
      if (pts[j]![1] < 0.5) continue
      const x0 = x(pts[j]![0])
      const x1 = x(j + 1 < pts.length ? pts[j + 1]![0] : to)
      svg.appendChild(el('rect', { x: x0, y: laneTop, width: Math.max(0.5, x1 - x0), height: laneH, fill: colorOf.get(s.tag)!, 'fill-opacity': 0.25 }))
    }
    if (pts.length > 0) {
      svg.appendChild(el('path', { d: buildPath(pts, x, y, true), fill: 'none', stroke: colorOf.get(s.tag)!, 'stroke-width': 1.4 }))
    }
    const label = el('text', { x: ml - 6, y: laneTop + laneH / 2 + 3, 'text-anchor': 'end', 'font-size': 9, fill: 'currentColor', 'fill-opacity': 0.65 })
    label.textContent = s.tag
    svg.appendChild(label)
  })

  // --- Event markers ---
  const events = (env.events ?? []).filter(e => e.t >= from && e.t <= to && !state.hidden.has(e.tag))
  for (const e of events) {
    const px = x(e.t)
    const color = EVENT_COLOR[e.level] ?? '#6b7280'
    const line = el('line', { x1: px, x2: px, y1: mt, y2: mt + plotH, stroke: color, 'stroke-opacity': 0.55, 'stroke-dasharray': '2 3' })
    svg.appendChild(line)
    const marker = el('path', { d: `M${px - 4},${mt} L${px + 4},${mt} L${px},${mt + 7} Z`, fill: color })
    const tip = el('title')
    tip.textContent = `[${e.level}] ${e.text}`
    marker.appendChild(tip)
    svg.appendChild(marker)
  }

  wrapper.appendChild(svg)

  // --- Series chips (click to toggle) ---
  for (const s of env.series) {
    const chip = document.createElement('button')
    const off = state.hidden.has(s.tag)
    const normalized = s.kind !== 'binary' && !axisUnits.includes(s.unit)
    const pts = inWindow(s)
    const last = pts.length ? pts[pts.length - 1]![1] : null
    let statText = last !== null ? ` ${last}${s.unit}` : ''
    if (s.kind === 'power' && pts.length > 1) statText += ` · ≈${Math.round(energyMWh(pts)).toLocaleString()} MWh`
    chip.textContent = `${off ? '◻' : '◼'} ${s.tag}${statText}${normalized ? ' (norm)' : ''}`
    chip.title = `${s.label ?? s.tag} — click to ${off ? 'show' : 'hide'}`
    chip.style.cssText = `border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:1px 8px;background:transparent;cursor:pointer;font-size:11px;color:${off ? 'inherit' : colorOf.get(s.tag)};opacity:${off ? 0.55 : 1}`
    chip.onclick = () => {
      if (state.hidden.has(s.tag)) state.hidden.delete(s.tag)
      else state.hidden.add(s.tag)
      render(wrapper, env, state)
    }
    chips.appendChild(chip)
  }

  // --- Event list (compact, below the chart) ---
  if (events.length > 0) {
    const list = document.createElement('div')
    list.style.cssText = 'padding:4px 8px 8px;font-size:11px;line-height:1.5'
    for (const e of events.slice(0, 6)) {
      const row = document.createElement('div')
      const dot = document.createElement('span')
      dot.textContent = '▲ '
      dot.style.color = EVENT_COLOR[e.level] ?? '#6b7280'
      row.appendChild(dot)
      row.appendChild(document.createTextNode(`${fmt(e.t)} — ${e.text}`))
      list.appendChild(row)
    }
    if (events.length > 6) {
      const more = document.createElement('div')
      more.style.opacity = '0.6'
      more.textContent = `… ${events.length - 6} more event(s) in window`
      list.appendChild(more)
    }
    wrapper.appendChild(list)
  }
}

export const renderTrendBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll('code.language-trend')
  if (blocks.length === 0) return
  for (const block of blocks) {
    const pre = block.parentElement
    if (!pre) continue
    const env = parseEnvelope(block.textContent ?? '')
    if (!env) {
      // Loud failure: keep the raw fence visible and flag it, mirroring the
      // map fallback philosophy — an operator should never silently lose data.
      const warn = document.createElement('div')
      warn.className = 'text-warning text-xs'
      warn.textContent = '⚠ trend block failed to parse — showing raw source'
      pre.before(warn)
      continue
    }
    const wrapper = document.createElement('div')
    wrapper.className = 'my-2 rounded border border-border overflow-hidden'
    pre.replaceWith(wrapper)
    render(wrapper, env, { hidden: new Set(), windowS: null })
  }
}

addPostRenderProcessor('trend', renderTrendBlocks)
