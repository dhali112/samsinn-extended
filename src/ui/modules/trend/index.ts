// Trend control — WinCC-OnlineTrendControl-style front-end object.
//
// ARCHITECTURE: this is a pure front-end control. A ```trend fence carries
// only a CONFIG (pens + time axis); the control fetches actual samples from
// /api/trends/data and re-fetches on every operator interaction. Data never
// travels through chat messages or the LLM.
//
// Config fence (produced by trend_query or written by hand):
//   { "title"?: string,
//     "trends": [{ "tag": "RCS_TEMP_C" }, ...],
//     "time": { "window": "8h" } | { "from": ISO, "to": ISO } | { "points": N } }
//
// Legacy fences with embedded data ({ series: [{points…}] }) still render,
// backed by a local provider (spec's "manual" Provider kind) instead of the
// archive API.
//
// Operator surface (spec correspondence):
//   pen add/remove + visibility chips … ShowTrendSelection / ShowTagSelection
//   time-axis mode controls           … ShowTimeSelection
//   ruler with per-pen readout        … Ruler / RulerControl
//   stats table                       … CalculateStatistic
//   CSV export                        … Export()
//   binary lanes, limit lines, event markers … pen semantics from tag metadata

import { addPostRenderProcessor } from '../extensions/post-render-registry.ts'

interface TrendSeries {
  readonly tag: string
  readonly label?: string
  readonly unit: string
  readonly kind: 'analog' | 'binary' | 'power'
  readonly step?: boolean
  readonly limits?: { low?: number; high?: number; highHigh?: number }
  readonly stats?: Record<string, number>
  readonly points: ReadonlyArray<readonly [number, number]>
}
interface TrendEvent { readonly t: number; readonly tag: string; readonly level: string; readonly text: string }
interface TrendData {
  readonly from: number
  readonly to: number
  readonly series: ReadonlyArray<TrendSeries>
  readonly events?: ReadonlyArray<TrendEvent>
}
interface TimeCfg { window?: string; from?: string; to?: string; points?: number }
interface TagInfo { readonly tag: string; readonly label: string; readonly unit: string; readonly kind: string }

// Provider: resolves (pens, time) → data. 'archive' hits the API; 'manual'
// slices data embedded in a legacy fence.
type Provider = (pens: ReadonlyArray<string>, time: TimeCfg) => Promise<TrendData | { error: string }>

interface CtlState {
  pens: string[]
  readonly hidden: Set<string>
  time: TimeCfg
  rulerLocked: boolean
  rulerT: number | null
  // Cursor tooling: 'ruler' = single line + readout; 'region' = drag to
  // select a span (two boundary lines + shaded area) with exact stats and
  // a server-side selection the agent can reference ("the window shown").
  cursorMode: 'ruler' | 'region'
  region: { from: number; to: number } | null
}

const PALETTE = ['#2563eb', '#f59e0b', '#059669', '#8b5cf6', '#0891b2', '#d946ef', '#84cc16', '#f97316']
const EVENT_COLOR: Record<string, string> = {
  HIHI: '#dc2626', HIGH: '#ea580c', LOW: '#0284c7', ROC: '#9333ea', STATE: '#6b7280',
}
const WINDOW_CHOICES: ReadonlyArray<readonly [string, string]> = [
  ['15m', '15m'], ['1h', '1h'], ['4h', '4h'], ['8h', '8h'], ['24h', '24h'], ['1 week', '1w'],
]
const CTL_STYLE = 'font-size:12px;padding:1px 4px;border:1px solid rgba(128,128,128,.4);border-radius:4px;background:transparent;color:inherit'

const SVGNS = 'http://www.w3.org/2000/svg'
const el = (tag: string, attrs: Record<string, string | number> = {}): SVGElement => {
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
const epochToLocalInput = (ts: number): string => {
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
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

// --- Providers ---

const archiveProvider: Provider = async (pens, time) => {
  const qs = new URLSearchParams({ tags: pens.join(',') })
  if (time.from) qs.set('from', time.from)
  if (time.to) qs.set('to', time.to)
  if (!time.from && !time.to && time.points) qs.set('points', String(time.points))
  else if (!time.from && !time.to && time.window) qs.set('window', time.window)
  try {
    const res = await fetch(`/api/trends/data?${qs}`)
    if (!res.ok) return { error: `Trend data request failed (${res.status}): ${(await res.text()).slice(0, 200)}` }
    return await res.json() as TrendData
  } catch (err) {
    return { error: `Trend data request failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}

const makeEmbeddedProvider = (envData: TrendData): Provider => async (pens, time) => {
  const slice = (s: TrendSeries, from: number, to: number): TrendSeries => {
    const pts = s.points.filter(p => p[0] >= from && p[0] <= to)
    const before = s.points.filter(p => p[0] < from)
    if (before.length > 0) pts.unshift([from, before[before.length - 1]![1]])
    return { ...s, points: pts }
  }
  let from = envData.from, to = envData.to
  if (time.window) {
    const secs: Record<string, number> = { '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '8h': 28800, '24h': 86400, '48h': 172800, '1w': 604800 }
    from = Math.max(envData.from, envData.to - (secs[time.window] ?? Infinity))
  } else if (time.from || time.to) {
    const p = (v?: string): number | null => { const ms = v ? Date.parse(v) : NaN; return Number.isNaN(ms) ? null : ms / 1000 }
    from = Math.max(envData.from, p(time.from) ?? envData.from)
    to = Math.min(envData.to, p(time.to) ?? envData.to)
  } else if (time.points) {
    const densest = [...envData.series].sort((a, b) => b.points.length - a.points.length)[0]
    const sl = densest?.points.slice(-Math.max(2, time.points))
    if (sl?.length) from = Math.max(envData.from, sl[0]![0])
  }
  return {
    from, to,
    series: envData.series.filter(s => pens.includes(s.tag)).map(s => slice(s, from, to)),
    events: (envData.events ?? []).filter(e => e.t >= from && e.t <= to),
  }
}

// --- Tag catalog (for the add-pen picker; fetched once, shared) ---
let catalogCache: TagInfo[] | null = null
const loadCatalog = async (): Promise<TagInfo[]> => {
  if (catalogCache) return catalogCache
  try {
    const res = await fetch('/api/trends/tags')
    if (res.ok) catalogCache = await res.json() as TagInfo[]
  } catch { /* catalog unavailable → add-pen picker simply not shown */ }
  return catalogCache ?? []
}

// --- Control ---

const renderControl = (
  wrapper: HTMLElement, title: string, provider: Provider,
  state: CtlState, live: boolean,
): void => {
  const refresh = (): void => renderControl(wrapper, title, provider, state, live)

  wrapper.textContent = ''
  const loading = document.createElement('div')
  loading.style.cssText = 'padding:10px;font-size:12px;opacity:.7'
  loading.textContent = 'Loading trend data…'
  wrapper.appendChild(loading)

  void (async () => {
    const [data, catalog] = await Promise.all([
      provider(state.pens, state.time),
      live ? loadCatalog() : Promise.resolve([] as TagInfo[]),
    ])
    wrapper.textContent = ''

    if ('error' in data) {
      const err = document.createElement('div')
      err.style.cssText = 'padding:10px;font-size:12px;color:#dc2626'
      err.textContent = `⚠ ${data.error}`
      const retry = document.createElement('button')
      retry.textContent = 'Retry'
      retry.style.cssText = CTL_STYLE + ';margin-left:8px;cursor:pointer'
      retry.onclick = refresh
      err.appendChild(retry)
      wrapper.appendChild(err)
      return
    }
    draw(wrapper, title, data, catalog, state, live, refresh)
  })()
}

const draw = (
  wrapper: HTMLElement, title: string, data: TrendData, catalog: TagInfo[],
  state: CtlState, live: boolean, refresh: () => void,
): void => {
  const colorOf = new Map(state.pens.map((tag, i) => [tag, PALETTE[i % PALETTE.length]!]))
  const from = data.from, to = data.to
  const redraw = (): void => draw(wrapper, title, data, catalog, state, live, refresh)

  wrapper.textContent = ''

  // --- Toolbar ---
  const bar = document.createElement('div')
  bar.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:6px 8px;font-size:12px'
  const titleEl = document.createElement('span')
  titleEl.textContent = title
  titleEl.style.cssText = 'font-weight:700;margin-right:auto'
  bar.appendChild(titleEl)

  // Time-axis mode picker
  const mode: 'last' | 'range' | 'points' = state.time.from || state.time.to ? 'range' : state.time.points ? 'points' : 'last'
  const modeSel = document.createElement('select')
  modeSel.style.cssText = CTL_STYLE
  for (const [value, label] of [['last', 'Last…'], ['range', 'Start–end'], ['points', 'N points']] as const) {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    if (mode === value) o.selected = true
    modeSel.appendChild(o)
  }
  modeSel.onchange = () => {
    if (modeSel.value === 'last') state.time = { window: '8h' }
    else if (modeSel.value === 'points') state.time = { points: 60 }
    else state.time = { from: epochToLocalInput(from), to: epochToLocalInput(to) }
    refresh()
  }
  bar.appendChild(modeSel)

  if (mode === 'last') {
    const sel = document.createElement('select')
    sel.style.cssText = CTL_STYLE
    for (const [label, key] of WINDOW_CHOICES) {
      const o = document.createElement('option')
      o.value = key
      o.textContent = `Last ${label}`
      if (state.time.window === key) o.selected = true
      sel.appendChild(o)
    }
    sel.onchange = () => { state.time = { window: sel.value }; refresh() }
    bar.appendChild(sel)
  } else if (mode === 'range') {
    const mk = (initial: string, onSet: (v: string) => void): HTMLInputElement => {
      const inp = document.createElement('input')
      inp.type = 'datetime-local'
      inp.style.cssText = CTL_STYLE
      inp.value = initial
      inp.onchange = () => { if (inp.value) { onSet(inp.value); refresh() } }
      return inp
    }
    bar.appendChild(mk(state.time.from ?? epochToLocalInput(from), v => { state.time = { ...state.time, from: v, window: undefined, points: undefined } }))
    const dash = document.createElement('span')
    dash.textContent = '–'
    bar.appendChild(dash)
    bar.appendChild(mk(state.time.to ?? epochToLocalInput(to), v => { state.time = { ...state.time, to: v, window: undefined, points: undefined } }))
  } else {
    const inp = document.createElement('input')
    inp.type = 'number'
    inp.min = '10'
    inp.max = '240'
    inp.value = String(state.time.points ?? 60)
    inp.style.cssText = CTL_STYLE + ';width:64px'
    inp.title = 'Show the last N samples (10–240)'
    inp.onchange = () => {
      const n = Math.max(10, Math.min(240, Math.round(Number(inp.value) || 60)))
      state.time = { points: n }
      refresh()
    }
    bar.appendChild(inp)
    const lbl = document.createElement('span')
    lbl.textContent = 'points'
    lbl.style.opacity = '0.7'
    bar.appendChild(lbl)
  }

  // Add-pen picker (live/archive mode only)
  if (live && catalog.length > 0) {
    const addable = catalog.filter(t => !state.pens.includes(t.tag))
    if (addable.length > 0) {
      const add = document.createElement('select')
      add.style.cssText = CTL_STYLE
      const o0 = document.createElement('option')
      o0.value = ''
      o0.textContent = '＋ add pen…'
      add.appendChild(o0)
      for (const t of addable) {
        const o = document.createElement('option')
        o.value = t.tag
        o.textContent = `${t.tag}${t.unit ? ` (${t.unit})` : ''}`
        o.title = t.label
        add.appendChild(o)
      }
      add.onchange = () => {
        if (add.value) { state.pens = [...state.pens, add.value]; refresh() }
      }
      bar.appendChild(add)
    }
  }

  // Cursor tooling toggle: Ruler (one line) vs Region (drag two lines)
  const cursorSel = document.createElement('select')
  cursorSel.style.cssText = CTL_STYLE
  for (const [value, label] of [['ruler', 'Ruler'], ['region', 'Region']] as const) {
    const o = document.createElement('option')
    o.value = value
    o.textContent = label
    if (state.cursorMode === value) o.selected = true
    cursorSel.appendChild(o)
  }
  cursorSel.title = 'Ruler: hover readout at one instant. Region: drag across the plot to select a span and get its statistics.'
  cursorSel.onchange = () => {
    state.cursorMode = cursorSel.value as CtlState['cursorMode']
    redraw()
  }
  bar.appendChild(cursorSel)

  // Export CSV of what is currently displayed
  const exp = document.createElement('button')
  exp.textContent = '⬇ CSV'
  exp.title = 'Export the displayed data as CSV'
  exp.style.cssText = CTL_STYLE + ';cursor:pointer'
  exp.onclick = () => {
    const rows = ['ts_iso,tag,value']
    for (const s of data.series) {
      if (state.hidden.has(s.tag)) continue
      for (const p of s.points) rows.push(`${new Date(p[0] * 1000).toISOString()},${s.tag},${p[1]}`)
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'trend-export.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  bar.appendChild(exp)
  wrapper.appendChild(bar)

  const chips = document.createElement('div')
  chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:0 8px 6px;font-size:11px'
  wrapper.appendChild(chips)

  // --- Plot layout ---
  const width = Math.max(360, wrapper.clientWidth || 640)
  const visible = data.series.filter(s => !state.hidden.has(s.tag))
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

  const unitOrder: string[] = []
  for (const s of analog) if (!unitOrder.includes(s.unit)) unitOrder.push(s.unit)
  const axisUnits = unitOrder.slice(0, 2)
  const groupDomain = (unit: string): { min: number; max: number } => {
    let min = Infinity, max = -Infinity
    for (const s of analog.filter(sr => sr.unit === unit)) {
      for (const p of s.points) { min = Math.min(min, p[1]); max = Math.max(max, p[1]) }
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
    let mn = Infinity, mx = -Infinity
    for (const p of s.points) { mn = Math.min(mn, p[1]); mx = Math.max(mx, p[1]) }
    if (!isFinite(mn) || mn === mx) { mn = 0; mx = 1 }
    return v => mt + plotH - (v - mn) / (mx - mn) * plotH
  }

  // Grid + axes
  const leftDomain = axisUnits[0] ? domains.get(axisUnits[0])! : { min: 0, max: 1 }
  for (const tick of niceTicks(leftDomain.min, leftDomain.max, 5)) {
    const y = mt + plotH - (tick - leftDomain.min) / (leftDomain.max - leftDomain.min) * plotH
    if (y < mt - 1 || y > mt + plotH + 1) continue
    svg.appendChild(el('line', { x1: ml, x2: width - mr, y1: y, y2: y, stroke: 'currentColor', 'stroke-opacity': 0.12 }))
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

  // Limit lines
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

  // Analog traces
  for (const s of analog) {
    if (s.points.length === 0) continue
    svg.appendChild(el('path', {
      d: buildPath(s.points, x, yFor(s), !!s.step),
      fill: 'none', stroke: colorOf.get(s.tag) ?? '#888', 'stroke-width': 1.6, 'stroke-linejoin': 'round',
    }))
  }

  // Binary lanes
  binary.forEach((s, i) => {
    const laneTop = mt + plotH + 4 + i * (laneH + 4)
    const pts = s.points
    const y = (v: number): number => laneTop + (v >= 0.5 ? 2 : laneH - 2)
    svg.appendChild(el('rect', { x: ml, y: laneTop, width: width - ml - mr, height: laneH, fill: 'currentColor', 'fill-opacity': 0.05 }))
    for (let j = 0; j < pts.length; j++) {
      if (pts[j]![1] < 0.5) continue
      const x0 = x(pts[j]![0])
      const x1 = x(j + 1 < pts.length ? pts[j + 1]![0] : to)
      svg.appendChild(el('rect', { x: x0, y: laneTop, width: Math.max(0.5, x1 - x0), height: laneH, fill: colorOf.get(s.tag) ?? '#888', 'fill-opacity': 0.25 }))
    }
    if (pts.length > 0) {
      svg.appendChild(el('path', { d: buildPath(pts, x, y, true), fill: 'none', stroke: colorOf.get(s.tag) ?? '#888', 'stroke-width': 1.4 }))
    }
    const label = el('text', { x: ml - 6, y: laneTop + laneH / 2 + 3, 'text-anchor': 'end', 'font-size': 9, fill: 'currentColor', 'fill-opacity': 0.65 })
    label.textContent = s.tag
    svg.appendChild(label)
  })

  // Event markers
  const events = (data.events ?? []).filter(e => !state.hidden.has(e.tag))
  for (const e of events) {
    const px = x(e.t)
    const color = EVENT_COLOR[e.level] ?? '#6b7280'
    svg.appendChild(el('line', { x1: px, x2: px, y1: mt, y2: mt + plotH, stroke: color, 'stroke-opacity': 0.55, 'stroke-dasharray': '2 3' }))
    const marker = el('path', { d: `M${px - 4},${mt} L${px + 4},${mt} L${px},${mt + 7} Z`, fill: color })
    const tip = el('title')
    tip.textContent = `[${e.level}] ${e.text}`
    marker.appendChild(tip)
    svg.appendChild(marker)
  }

  // --- Ruler: vertical cursor + per-pen readout; click to lock ---
  const rulerLine = el('line', { x1: -10, x2: -10, y1: mt, y2: mt + plotH + lanesH, stroke: 'currentColor', 'stroke-opacity': 0.6, 'stroke-width': 1 })
  svg.appendChild(rulerLine)
  const readout = document.createElement('div')
  readout.style.cssText = 'position:absolute;display:none;pointer-events:none;background:rgba(20,20,25,.92);color:#eee;font-size:10px;line-height:1.5;padding:4px 7px;border-radius:4px;z-index:10;white-space:nowrap'
  const nearestValue = (s: TrendSeries, t: number): number | null => {
    if (s.points.length === 0) return null
    let best: readonly [number, number] | null = null
    for (const p of s.points) {
      if (s.step || s.kind === 'binary') { if (p[0] <= t) best = p; else break }
      else if (best === null || Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p
    }
    return best ? best[1] : null
  }
  const positionRuler = (t: number, clientX: number, clientY: number): void => {
    const px = x(t)
    rulerLine.setAttribute('x1', String(px))
    rulerLine.setAttribute('x2', String(px))
    const lines = [`<b>${fmt(t)}</b>`]
    for (const s of visible) {
      const v = nearestValue(s, t)
      const color = colorOf.get(s.tag) ?? '#888'
      lines.push(`<span style="color:${color}">●</span> ${s.tag}: ${v === null ? '–' : `${+v.toFixed(2)}${s.unit}`}`)
    }
    readout.innerHTML = lines.join('<br>')
    readout.style.display = 'block'
    const rect = wrapper.getBoundingClientRect()
    const rx = clientX - rect.left + 12
    readout.style.left = `${Math.min(rx, rect.width - 170)}px`
    readout.style.top = `${clientY - rect.top + 12}px`
  }
  const timeAtClientX = (clientX: number): number | null => {
    const rect = svg.getBoundingClientRect()
    const sx = (clientX - rect.left) * (width / rect.width)
    if (sx < ml || sx > width - mr) return null
    return from + (sx - ml) / (width - ml - mr) * (to - from)
  }

  if (state.cursorMode === 'ruler') {
    svg.addEventListener('mousemove', (ev) => {
      if (state.rulerLocked) return
      const t = timeAtClientX(ev.clientX)
      if (t === null) { rulerLine.setAttribute('x1', '-10'); rulerLine.setAttribute('x2', '-10'); readout.style.display = 'none'; return }
      state.rulerT = t
      positionRuler(t, ev.clientX, ev.clientY)
    })
    svg.addEventListener('mouseleave', () => {
      if (state.rulerLocked) return
      rulerLine.setAttribute('x1', '-10')
      rulerLine.setAttribute('x2', '-10')
      readout.style.display = 'none'
    })
    svg.addEventListener('click', (ev) => {
      state.rulerLocked = !state.rulerLocked
      if (state.rulerLocked && state.rulerT !== null) positionRuler(state.rulerT, ev.clientX, ev.clientY)
    })
    svg.style.cursor = 'crosshair'
  } else {
    // Region mode: drag across the plot to select [t0, t1].
    const dragRect = el('rect', { x: -10, y: mt, width: 0, height: plotH + lanesH, fill: '#2563eb', 'fill-opacity': 0.12 })
    svg.appendChild(dragRect)
    let dragT0: number | null = null
    svg.addEventListener('mousedown', (ev) => {
      const t = timeAtClientX(ev.clientX)
      if (t !== null) { dragT0 = t; ev.preventDefault() }
    })
    svg.addEventListener('mousemove', (ev) => {
      if (dragT0 === null) return
      const t = timeAtClientX(ev.clientX)
      if (t === null) return
      const x0 = x(Math.min(dragT0, t)), x1 = x(Math.max(dragT0, t))
      dragRect.setAttribute('x', String(x0))
      dragRect.setAttribute('width', String(Math.max(0, x1 - x0)))
    })
    const finish = (ev: MouseEvent): void => {
      if (dragT0 === null) return
      const t = timeAtClientX(ev.clientX)
      const t0 = dragT0
      dragT0 = null
      if (t === null) return
      const rFrom = Math.min(t0, t), rTo = Math.max(t0, t)
      if (rTo - rFrom < 30) return   // ignore accidental clicks (< 30 s span)
      state.region = { from: Math.round(rFrom), to: Math.round(rTo) }
      // Persist so the agent can resolve "the window shown" via trend_query.
      void fetch('/api/trends/selection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: state.region.from, to: state.region.to, tags: state.pens }),
      })
      redraw()
    }
    svg.addEventListener('mouseup', finish)
    svg.addEventListener('mouseleave', (ev) => { if (dragT0 !== null) finish(ev) })
    svg.style.cursor = 'col-resize'
  }

  // Persistent region overlay (survives redraws and window changes)
  if (state.region) {
    const rFrom = Math.max(from, state.region.from)
    const rTo = Math.min(to, state.region.to)
    if (rTo > rFrom) {
      const x0 = x(rFrom), x1 = x(rTo)
      svg.appendChild(el('rect', { x: x0, y: mt, width: x1 - x0, height: plotH + lanesH, fill: '#2563eb', 'fill-opacity': 0.1 }))
      for (const bx of [x0, x1]) {
        svg.appendChild(el('line', { x1: bx, x2: bx, y1: mt, y2: mt + plotH + lanesH, stroke: '#2563eb', 'stroke-opacity': 0.8, 'stroke-width': 1.2, 'stroke-dasharray': '4 3' }))
      }
    }
  }

  wrapper.style.position = 'relative'
  wrapper.appendChild(svg)
  wrapper.appendChild(readout)

  // --- Pen chips: click toggles visibility; ✕ removes the pen ---
  for (const tag of state.pens) {
    const s = data.series.find(sr => sr.tag === tag)
    const chip = document.createElement('button')
    const off = state.hidden.has(tag)
    const last = s && s.points.length ? s.points[s.points.length - 1]![1] : null
    let statText = s && last !== null ? ` ${+last.toFixed(2)}${s.unit}` : ''
    if (s?.kind === 'power' && typeof s.stats?.energyMWh === 'number') statText += ` · ≈${Math.round(s.stats.energyMWh).toLocaleString()} MWh`
    chip.textContent = `${off ? '◻' : '◼'} ${tag}${statText} `
    chip.title = `${s?.label ?? tag} — click to ${off ? 'show' : 'hide'}`
    chip.style.cssText = `border:1px solid rgba(128,128,128,.35);border-radius:10px;padding:1px 8px;background:transparent;cursor:pointer;font-size:11px;color:${off ? 'inherit' : colorOf.get(tag)};opacity:${off ? 0.55 : 1}`
    const removeBtn = document.createElement('span')
    removeBtn.textContent = '✕'
    removeBtn.title = `Remove ${tag} from the display`
    removeBtn.style.cssText = 'margin-left:4px;opacity:.5'
    removeBtn.onclick = (ev) => {
      ev.stopPropagation()
      state.pens = state.pens.filter(p => p !== tag)
      state.hidden.delete(tag)
      refresh()
    }
    chip.appendChild(removeBtn)
    chip.onclick = () => {
      if (state.hidden.has(tag)) state.hidden.delete(tag)
      else state.hidden.add(tag)
      redraw()
    }
    chips.appendChild(chip)
  }

  // --- Region statistics strip (exact server stats for the selected span) ---
  if (state.region) {
    const strip = document.createElement('div')
    strip.style.cssText = 'margin:2px 8px 4px;padding:4px 8px;border:1px dashed rgba(37,99,235,.55);border-radius:6px;font-size:11px;line-height:1.6'
    const dur = state.region.to - state.region.from
    const head = document.createElement('div')
    head.style.cssText = 'display:flex;align-items:center;gap:8px'
    const headText = document.createElement('b')
    headText.textContent = `Region ${fmt(state.region.from)} – ${fmt(state.region.to)} (${dur >= 3600 ? `${(dur / 3600).toFixed(1)}h` : `${Math.round(dur / 60)} min`})`
    head.appendChild(headText)
    const hint = document.createElement('span')
    hint.style.cssText = 'opacity:.6'
    hint.textContent = 'saved — you can ask the agent about "the selected region"'
    head.appendChild(hint)
    const clear = document.createElement('button')
    clear.textContent = '✕ clear'
    clear.style.cssText = CTL_STYLE + ';cursor:pointer;margin-left:auto'
    clear.onclick = () => {
      state.region = null
      void fetch('/api/trends/selection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'null' })
      redraw()
    }
    head.appendChild(clear)
    strip.appendChild(head)
    const body = document.createElement('div')
    body.textContent = 'Computing region statistics…'
    body.style.opacity = '0.7'
    strip.appendChild(body)
    wrapper.appendChild(strip)

    void (async () => {
      try {
        const qs = new URLSearchParams({ tags: state.pens.join(','), from: String(state.region!.from), to: String(state.region!.to) })
        const res = await fetch(`/api/trends/data?${qs}`)
        if (!res.ok) { body.textContent = `⚠ region stats failed (${res.status})`; return }
        const rd = await res.json() as TrendData
        body.style.opacity = '1'
        body.textContent = ''
        for (const s of rd.series) {
          if (state.hidden.has(s.tag)) continue
          const st = (s.stats ?? {}) as Record<string, number>
          const row = document.createElement('div')
          const dot = document.createElement('span')
          dot.textContent = '● '
          dot.style.color = colorOf.get(s.tag) ?? '#888'
          row.appendChild(dot)
          let text: string
          if (s.kind === 'binary') {
            text = `${s.tag}: ${st.transitions ?? 0} state change(s), stopped ${Math.round((st.downtimeS ?? 0) / 60)} min`
          } else {
            text = `${s.tag}: avg ${st.avg}${s.unit} · min ${st.min}${s.unit} · max ${st.max}${s.unit}`
            if (typeof st.energyMWh === 'number') text += ` · ≈${Math.round(st.energyMWh).toLocaleString()} MWh`
          }
          row.appendChild(document.createTextNode(text))
          body.appendChild(row)
        }
        const evCount = (rd.events ?? []).length
        if (evCount > 0) {
          const ev = document.createElement('div')
          ev.style.color = '#ea580c'
          ev.textContent = `▲ ${evCount} event(s) in region — ${(rd.events ?? []).slice(0, 2).map(e => e.text).join(' · ')}${evCount > 2 ? ' …' : ''}`
          body.appendChild(ev)
        }
      } catch (err) {
        body.textContent = `⚠ region stats failed: ${err instanceof Error ? err.message : String(err)}`
      }
    })()
  }

  // --- Statistics table (server stats are exact for the fetched window) ---
  if (visible.length > 0) {
    const table = document.createElement('table')
    table.style.cssText = 'width:calc(100% - 16px);margin:2px 8px 6px;border-collapse:collapse;font-size:11px'
    const hrow = document.createElement('tr')
    for (const h of ['Tag', 'Avg', 'Min', 'Max', 'Last', 'Info']) {
      const th = document.createElement('th')
      th.textContent = h
      th.style.cssText = `text-align:${h === 'Tag' || h === 'Info' ? 'left' : 'right'};padding:2px 6px;border-bottom:1px solid rgba(128,128,128,.35);opacity:.7;font-weight:600`
      hrow.appendChild(th)
    }
    const thead = document.createElement('thead')
    thead.appendChild(hrow)
    table.appendChild(thead)
    const tbody = document.createElement('tbody')

    for (const s of visible) {
      if (s.points.length === 0) continue
      const st = s.stats ?? {}
      const vals = s.points.map(p => p[1])
      const min = st.min ?? Math.min(...vals)
      const max = st.max ?? Math.max(...vals)
      const avg = st.avg ?? vals.reduce((a, v) => a + v, 0) / vals.length
      const last = st.last ?? vals[vals.length - 1]!
      const u = s.unit

      let dutyPct = 0
      if (s.kind === 'binary') {
        let onS = 0
        for (let i = 1; i < s.points.length; i++) {
          if (s.points[i - 1]![1] >= 0.5) onS += s.points[i]![0] - s.points[i - 1]![0]
        }
        dutyPct = Math.round(onS / Math.max(1, s.points[s.points.length - 1]![0] - s.points[0]![0]) * 100)
      }

      let info: string
      if (s.kind === 'power') {
        const e = typeof st.energyMWh === 'number' ? st.energyMWh : energyMWh(s.points)
        info = `≈ ${Math.round(e).toLocaleString()} MWh in window`
      } else if (s.kind === 'binary') {
        const stops = (data.events ?? []).filter(ev => ev.tag === s.tag && ev.level === 'STATE' && ev.text.includes('STOPPED')).length
        info = `${stops} stop${stops === 1 ? '' : 's'} in window`
      } else if (s.limits && (s.limits.high !== undefined || s.limits.low !== undefined)) {
        const n = (data.events ?? []).filter(ev => ev.tag === s.tag && ev.level !== 'STATE').length
        info = n > 0 ? `⚠ ${n} alarm event${n === 1 ? '' : 's'} in window` : 'no limit violations'
      } else {
        const std = Math.sqrt(vals.reduce((a, v) => a + (v - avg) ** 2, 0) / vals.length)
        info = `σ ${std.toFixed(2)}${u}`
      }

      const row = document.createElement('tr')
      const fmtV = (v: number): string => s.kind === 'binary' ? String(Math.round(v * 100) / 100) : `${(+v.toFixed(2)).toLocaleString()}${u}`
      const cells: Array<{ text: string; align: string; color?: string }> = [
        { text: `● ${s.tag}`, align: 'left', color: colorOf.get(s.tag) },
        { text: s.kind === 'binary' ? `${dutyPct}% on` : fmtV(avg), align: 'right' },
        { text: fmtV(min), align: 'right' },
        { text: fmtV(max), align: 'right' },
        { text: fmtV(last), align: 'right' },
        { text: info, align: 'left' },
      ]
      for (const c of cells) {
        const td = document.createElement('td')
        td.textContent = c.text
        td.style.cssText = `text-align:${c.align};padding:2px 6px;border-bottom:1px solid rgba(128,128,128,.15);white-space:nowrap${c.color ? `;color:${c.color};font-weight:600` : ''}`
        row.appendChild(td)
      }
      tbody.appendChild(row)
    }
    table.appendChild(tbody)
    wrapper.appendChild(table)
  }

  // --- Event list ---
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

// --- Fence entry point ---

interface LiveConfig { title?: string; trends: Array<{ tag: string }>; time?: TimeCfg }

const parseFence = (source: string): { kind: 'live'; cfg: LiveConfig } | { kind: 'embedded'; data: TrendData; title: string } | null => {
  try {
    const raw = JSON.parse(source) as Record<string, unknown>
    if (Array.isArray(raw.trends)) {
      const trends = (raw.trends as Array<{ tag?: unknown }>).filter(t => typeof t?.tag === 'string') as Array<{ tag: string }>
      if (trends.length === 0) return null
      return { kind: 'live', cfg: { title: typeof raw.title === 'string' ? raw.title : undefined, trends, time: (raw.time ?? {}) as TimeCfg } }
    }
    if (Array.isArray(raw.series)) {
      for (const s of raw.series as Array<{ points?: unknown }>) if (!Array.isArray(s.points)) return null
      return { kind: 'embedded', data: raw as unknown as TrendData, title: typeof raw.title === 'string' ? raw.title : 'Trend' }
    }
    return null
  } catch { return null }
}

export const renderTrendBlocks = async (container: HTMLElement): Promise<void> => {
  const blocks = container.querySelectorAll('code.language-trend')
  if (blocks.length === 0) return
  for (const block of blocks) {
    const pre = block.parentElement
    if (!pre) continue
    const parsed = parseFence(block.textContent ?? '')
    if (!parsed) {
      // Loud failure: keep the raw fence visible and flag it — an operator
      // should never silently lose a display.
      const warn = document.createElement('div')
      warn.className = 'text-warning text-xs'
      warn.textContent = '⚠ trend block failed to parse — showing raw source'
      pre.before(warn)
      continue
    }
    const wrapper = document.createElement('div')
    wrapper.className = 'my-2 rounded border border-border overflow-hidden'
    pre.replaceWith(wrapper)
    if (parsed.kind === 'live') {
      const pens = parsed.cfg.trends.map(t => t.tag)
      renderControl(wrapper, parsed.cfg.title ?? `Plant trend — ${pens.join(', ')}`, archiveProvider,
        { pens, hidden: new Set(), time: parsed.cfg.time ?? { window: '8h' }, rulerLocked: false, rulerT: null, cursorMode: 'ruler', region: null }, true)
    } else {
      const pens = parsed.data.series.map(s => s.tag)
      renderControl(wrapper, parsed.title, makeEmbeddedProvider(parsed.data),
        { pens, hidden: new Set(), time: {}, rulerLocked: false, rulerT: null, cursorMode: 'ruler', region: null }, false)
    }
  }
}

addPostRenderProcessor('trend', renderTrendBlocks)
