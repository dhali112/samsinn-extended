// Plant historian — server-side data layer for the trend control.
//
// The trend control is a FRONT-END object: it never receives data through
// the LLM. The agent (or an operator prompt) produces only a small config
// (which pens, which time axis); the browser control fetches the actual
// samples from /api/trends/data, which calls into this module.
//
// Storage: skills/plant-trends/data/historian.csv (fake 48h historian,
// long format: ts_epoch_s,tag,value). loadHistory() is the ONLY function
// that touches storage — to move to a real database, replace its body:
//   PostgreSQL (Bun ≥1.2 built-in):
//     import { sql } from 'bun'
//     const rows = await sql`SELECT ts, value FROM historian
//                            WHERE tag = ${tag} AND ts BETWEEN ${from} AND ${to}
//                            ORDER BY ts`
//   MS SQL: use the `mssql` npm package with the same return shape.
//
// "Now" is the last timestamp in the historian, not wall-clock time — the
// fake data was generated once, so relative windows anchor to data end.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface TagMeta {
  readonly label: string
  readonly unit: string
  readonly kind: 'analog' | 'binary' | 'power'
  readonly category: string
  readonly limits?: { low?: number; high?: number; highHigh?: number }
  readonly states?: Record<number, string>
}

// Tag catalog. Names, units, and system groupings follow the pwr-ops wiki
// tag catalogue (samsinn-wikis.github.io/pwr-ops/tags — 113 tags documented);
// this is a representative subset spanning every system group, plus the
// original Plant Overview tags (kept for existing displays) and a Leitbild
// group mirroring the ambulance-scenario domain. Extending: add a row here
// and teach the generator its behavior — everything else (API, dropdown,
// alarms, analysis) picks it up automatically.
const RUN_STATES = { 0: 'STOPPED', 1: 'RUNNING' }
const VALVE_STATES = { 0: 'CLOSED', 1: 'OPEN' }

export const TREND_TAGS: Record<string, TagMeta> = {
  // — Plant Overview (original tags; existing displays reference these) —
  REACTOR_POWER_MW: { label: 'Reactor thermal power', unit: 'MW', kind: 'power', category: 'Plant Overview' },
  GEN_POWER_MW: { label: 'Generator electrical power', unit: 'MW', kind: 'power', category: 'Plant Overview', limits: { high: 1050 } },
  RCS_TEMP_C: { label: 'RCS coolant temperature', unit: '°C', kind: 'analog', category: 'Plant Overview', limits: { low: 280, high: 305, highHigh: 310 } },
  RCS_PRESS_BAR: { label: 'RCS pressure', unit: 'bar', kind: 'analog', category: 'Plant Overview', limits: { low: 150, high: 158 } },
  CTRL_ROD_POS_PCT: { label: 'Control rod position', unit: '%', kind: 'analog', category: 'Plant Overview' },
  CHARGING_PUMP_A_RUN: { label: 'Charging pump A', unit: '', kind: 'binary', category: 'Plant Overview', states: RUN_STATES },

  // — RCS —
  'TAVG': { label: 'RCS average temperature (4-loop)', unit: '°F', kind: 'analog', category: 'RCS', limits: { low: 547, high: 594 } },
  'TE-411-HOT': { label: 'Loop 1 hot-leg temperature', unit: '°F', kind: 'analog', category: 'RCS' },
  'TE-411-COLD': { label: 'Loop 1 cold-leg temperature', unit: '°F', kind: 'analog', category: 'RCS' },
  'SUB-MARGIN': { label: 'RCS subcooling margin', unit: '°F', kind: 'analog', category: 'RCS', limits: { low: 25 } },
  'CET-AVG': { label: 'Core-exit thermocouple average', unit: '°F', kind: 'analog', category: 'RCS', limits: { high: 700 } },
  'RCS-BORON': { label: 'RCS boron concentration', unit: ' ppm', kind: 'analog', category: 'RCS' },
  'RCP-1': { label: 'Reactor coolant pump 1', unit: '', kind: 'binary', category: 'RCS', states: RUN_STATES },
  'RCP-2': { label: 'Reactor coolant pump 2', unit: '', kind: 'binary', category: 'RCS', states: RUN_STATES },

  // — Pressurizer —
  'PT-455': { label: 'Pressurizer pressure (wide-range)', unit: ' psig', kind: 'analog', category: 'Pressurizer', limits: { low: 1870, high: 2350, highHigh: 2385 } },
  'PZR-LVL': { label: 'Pressurizer level', unit: '%', kind: 'analog', category: 'Pressurizer', limits: { low: 17, high: 92 } },
  'PZR-HTR': { label: 'Pressurizer heaters', unit: '', kind: 'binary', category: 'Pressurizer', states: { 0: 'OFF', 1: 'ON' } },
  'PORV-456A': { label: 'PORV 456A position', unit: '', kind: 'binary', category: 'Pressurizer', states: VALVE_STATES },

  // — Steam Generators —
  'SG-A-LVL-NR': { label: 'SG A narrow-range level', unit: '%', kind: 'analog', category: 'Steam Generators', limits: { low: 30, high: 82 } },
  'SG-B-LVL-NR': { label: 'SG B narrow-range level', unit: '%', kind: 'analog', category: 'Steam Generators', limits: { low: 30, high: 82 } },
  'SG-A-PR': { label: 'SG A steam pressure', unit: ' psig', kind: 'analog', category: 'Steam Generators', limits: { high: 1106 } },
  'SG-B-PR': { label: 'SG B steam pressure', unit: ' psig', kind: 'analog', category: 'Steam Generators', limits: { high: 1106 } },
  'SG-A-N16': { label: 'SG A main steam N-16 monitor', unit: ' cps', kind: 'analog', category: 'Steam Generators' },
  'MS-HEADER-PR': { label: 'Main steam header pressure', unit: ' psig', kind: 'analog', category: 'Steam Generators' },
  'MSIV-A': { label: 'Main steam isolation valve A', unit: '', kind: 'binary', category: 'Steam Generators', states: VALVE_STATES },

  // — Feedwater & AFW —
  'MFW-A-CV': { label: 'Main feedwater control valve A', unit: '%', kind: 'analog', category: 'Feedwater & AFW' },
  'AFW-FLOW': { label: 'Aggregate AFW header flow', unit: ' gpm', kind: 'analog', category: 'Feedwater & AFW' },
  'AFW-PUMP-A': { label: 'Motor-driven AFW pump A', unit: '', kind: 'binary', category: 'Feedwater & AFW', states: RUN_STATES },
  'AFW-PUMP-T': { label: 'Turbine-driven AFW pump', unit: '', kind: 'binary', category: 'Feedwater & AFW', states: RUN_STATES },
  'TDAFW-SPEED': { label: 'Turbine-driven AFW pump speed', unit: ' rpm', kind: 'analog', category: 'Feedwater & AFW' },
  'CST-LVL': { label: 'Condensate storage tank level', unit: '%', kind: 'analog', category: 'Feedwater & AFW', limits: { low: 30 } },

  // — Safety Injection —
  'SI-SIG': { label: 'Safety injection actuation signal', unit: '', kind: 'binary', category: 'Safety Injection', states: { 0: 'NORMAL', 1: 'ACTUATED' } },
  'SI-PUMP-A': { label: 'High-head SI pump A', unit: '', kind: 'binary', category: 'Safety Injection', states: RUN_STATES },
  'SI-FLOW': { label: 'High-head SI header flow', unit: ' gpm', kind: 'analog', category: 'Safety Injection' },
  'RWST-LVL': { label: 'Refueling water storage tank level', unit: '%', kind: 'analog', category: 'Safety Injection', limits: { low: 30 } },
  'ACCUM-1': { label: 'Accumulator 1 discharge isolation', unit: '', kind: 'binary', category: 'Safety Injection', states: VALVE_STATES },

  // — Containment —
  'CTMT-PR': { label: 'Containment building pressure', unit: ' psig', kind: 'analog', category: 'Containment', limits: { high: 3 } },
  'CTMT-TEMP': { label: 'Containment average temperature', unit: '°F', kind: 'analog', category: 'Containment', limits: { high: 120 } },
  'CTMT-RAD': { label: 'Containment area radiation', unit: ' rem/hr', kind: 'analog', category: 'Containment', limits: { high: 10 } },
  'CTMT-SUMP-LVL': { label: 'Containment recirc sump level', unit: '%', kind: 'analog', category: 'Containment', limits: { high: 10 } },

  // — Reactor Control (NIS + rods) —
  'NIS-PR-AVG': { label: 'Power-range average (4-channel)', unit: '%', kind: 'analog', category: 'Reactor Control', limits: { high: 109 } },
  'NIS-IR': { label: 'Intermediate-range signal', unit: ' µA', kind: 'analog', category: 'Reactor Control' },
  'NIS-SR': { label: 'Source-range count rate', unit: ' cps', kind: 'analog', category: 'Reactor Control' },
  'ROD-POS-AVG': { label: 'Average rod position', unit: ' steps', kind: 'analog', category: 'Reactor Control' },

  // — Electrical —
  'DG-A': { label: 'Emergency diesel generator A', unit: '', kind: 'binary', category: 'Electrical', states: RUN_STATES },
  'DG-B': { label: 'Emergency diesel generator B', unit: '', kind: 'binary', category: 'Electrical', states: RUN_STATES },
  'BUS-A-EMERG': { label: 'Emergency 4kV bus A energized', unit: '', kind: 'binary', category: 'Electrical', states: { 0: 'DEAD', 1: 'ENERGIZED' } },
  'DC-BUS-LVL': { label: 'Vital DC bus voltage', unit: ' V', kind: 'analog', category: 'Electrical', limits: { low: 125 } },

  // — Radiation Monitoring —
  'AEJ-RAD': { label: 'Condenser air-ejector monitor', unit: ' cps', kind: 'analog', category: 'Radiation Monitoring', limits: { high: 1000 } },
  'MAB-RAD': { label: 'Main aux building area monitor', unit: ' rem/hr', kind: 'analog', category: 'Radiation Monitoring', limits: { high: 2 } },
  'CCW-RAD': { label: 'Component cooling water monitor', unit: ' rem/hr', kind: 'analog', category: 'Radiation Monitoring' },

  // — Leitbild (ambulance scenario domain) —
  'AMB-UNITS-AVAIL': { label: 'Ambulance units available', unit: '', kind: 'analog', category: 'Leitbild', limits: { low: 1 } },
  'AMB-INCIDENTS-ACTIVE': { label: 'Active incidents', unit: '', kind: 'analog', category: 'Leitbild' },
  'HOSP-ED-OCC': { label: 'Hospital ED occupancy', unit: '%', kind: 'analog', category: 'Leitbild', limits: { high: 95 } },
}

export const TREND_WINDOWS: Record<string, number> = {
  '15m': 15 * 60, '30m': 30 * 60, '1h': 3600, '4h': 4 * 3600,
  '8h': 8 * 3600, '24h': 24 * 3600, '48h': 48 * 3600, '1w': 7 * 86400,
}

export const MAX_POINTS = 240
const BUCKETS = 48

export type Point = readonly [number, number]

// --- Storage layer (swap point for MS SQL / PostgreSQL — see header) ---
let csvCache: Map<string, Point[]> | null = null
const loadAll = async (): Promise<Map<string, Point[]>> => {
  if (csvCache) return csvCache
  const raw = await readFile(join(process.cwd(), 'skills', 'plant-trends', 'data', 'historian.csv'), 'utf-8')
  const map = new Map<string, Point[]>()
  for (const line of raw.split('\n').slice(1)) {
    if (!line) continue
    const c1 = line.indexOf(','); const c2 = line.indexOf(',', c1 + 1)
    const ts = Number(line.slice(0, c1))
    const tag = line.slice(c1 + 1, c2)
    const v = Number(line.slice(c2 + 1))
    let arr = map.get(tag)
    if (!arr) { arr = []; map.set(tag, arr) }
    arr.push([ts, v])
  }
  csvCache = map
  return map
}
const loadHistory = async (tag: string, from: number, to: number): Promise<Point[]> => {
  const all = await loadAll()
  return (all.get(tag) ?? []).filter(p => p[0] >= from && p[0] <= to)
}

// Analog/power: min-max bucketing (preserves spikes). Binary: exact
// change-point compression.
const downsample = (pts: Point[], kind: TagMeta['kind']): Point[] => {
  if (kind === 'binary') {
    const out: Point[] = []
    for (let i = 0; i < pts.length; i++) {
      if (i === 0 || i === pts.length - 1 || pts[i]![1] !== pts[i - 1]![1]) out.push(pts[i]!)
    }
    return out
  }
  if (pts.length <= BUCKETS * 2) return pts
  const size = Math.ceil(pts.length / BUCKETS)
  const out: Point[] = []
  for (let i = 0; i < pts.length; i += size) {
    const bucket = pts.slice(i, i + size)
    let mn = bucket[0]!, mx = bucket[0]!
    for (const p of bucket) { if (p[1] < mn[1]) mn = p; if (p[1] > mx[1]) mx = p }
    const pair = mn[0] <= mx[0] ? [mn, mx] : [mx, mn]
    for (const p of pair) if (out[out.length - 1] !== p) out.push(p)
  }
  return out
}

const hhmm = (ts: number): string => {
  const d = new Date(ts * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
const fmtDur = (s: number): string => s >= 3600 ? `${(s / 3600).toFixed(1)}h` : `${Math.round(s / 60)} min`

export interface TrendEvent { readonly t: number; readonly tag: string; readonly level: 'HIGH' | 'HIHI' | 'LOW' | 'ROC' | 'STATE'; readonly text: string }

const analyzeSeries = (
  tag: string, meta: TagMeta, pts: Point[],
): { stats: Record<string, unknown>; events: TrendEvent[]; lines: string[] } => {
  const events: TrendEvent[] = []
  const lines: string[] = []
  if (pts.length === 0) return { stats: {}, events, lines: [`${tag}: no data in window`] }

  const values = pts.map(p => p[1])
  const min = Math.min(...values), max = Math.max(...values)
  const avg = values.reduce((s, v) => s + v, 0) / values.length
  const last = values[values.length - 1]!
  const stats: Record<string, unknown> = {
    min: +min.toFixed(2), max: +max.toFixed(2), avg: +avg.toFixed(2), last: +last.toFixed(2),
  }

  if (meta.kind === 'binary') {
    let transitions = 0, downtime = 0
    for (let i = 1; i < pts.length; i++) {
      if (pts[i]![1] !== pts[i - 1]![1]) {
        transitions++
        const state = meta.states?.[pts[i]![1]] ?? String(pts[i]![1])
        events.push({ t: pts[i]![0], tag, level: 'STATE', text: `${meta.label} → ${state} at ${hhmm(pts[i]![0])}` })
      }
      if (pts[i - 1]![1] === 0) downtime += pts[i]![0] - pts[i - 1]![0]
    }
    stats.transitions = transitions
    stats.downtimeS = downtime
    const nowState = meta.states?.[last] ?? String(last)
    lines.push(`${meta.label}: currently ${nowState}; ${transitions} state change${transitions === 1 ? '' : 's'} in window${downtime > 0 ? `, stopped for ${fmtDur(downtime)} total` : ''}.`)
    return { stats, events, lines }
  }

  if (meta.kind === 'power') {
    let mwS = 0
    for (let i = 1; i < pts.length; i++) {
      mwS += (pts[i]![1] + pts[i - 1]![1]) / 2 * (pts[i]![0] - pts[i - 1]![0])
    }
    stats.energyMWh = +(mwS / 3600).toFixed(1)
  }

  const lim = meta.limits
  const excursionIntervals: Array<[number, number]> = []
  if (lim?.high !== undefined) {
    let inExc = false, excStart = 0, peak = -Infinity, excTotal = 0, hihi = false
    for (let i = 0; i < pts.length; i++) {
      const [t, v] = pts[i]!
      if (v > lim.high && !inExc) { inExc = true; excStart = t; peak = v }
      if (inExc) {
        peak = Math.max(peak, v)
        if (lim.highHigh !== undefined && v > lim.highHigh) hihi = true
      }
      if (inExc && (v <= lim.high || i === pts.length - 1)) {
        inExc = v > lim.high
        excTotal += t - excStart
        excursionIntervals.push([excStart, t])
        events.push({ t: excStart, tag, level: hihi ? 'HIHI' : 'HIGH', text: `${meta.label} exceeded ${hihi ? 'HIGH-HIGH' : 'HIGH'} limit — peaked ${peak.toFixed(1)}${meta.unit} at ${hhmm(excStart)}` })
        if (!inExc) { peak = -Infinity; hihi = false }
      }
    }
    if (excTotal > 0) {
      const ongoing = last > lim.high
      lines.push(`${meta.label}: EXCEEDED HIGH limit (${lim.high}${meta.unit}) for ${fmtDur(excTotal)}${lim.highHigh !== undefined && max > lim.highHigh ? `, peaking above HIGH-HIGH (${lim.highHigh}${meta.unit})` : ''} — peak ${max.toFixed(1)}${meta.unit}; ${ongoing ? 'STILL above limit now' : `back in band, now ${last.toFixed(1)}${meta.unit}`}.`)
    }
  }
  if (lim?.low !== undefined && min < lim.low) {
    const t = pts[values.indexOf(min)]![0]
    events.push({ t, tag, level: 'LOW', text: `${meta.label} below LOW limit — ${min.toFixed(1)}${meta.unit} at ${hhmm(t)}` })
    lines.push(`${meta.label}: dropped below LOW limit (${lim.low}${meta.unit}), minimum ${min.toFixed(1)}${meta.unit}.`)
  }

  // Rate-of-change notices. Suppressed inside (±10 min of) this tag's own
  // limit excursions — the excursion event already flags that disturbance,
  // and double-reporting made one visible alarm read as two events.
  const insideOwnExcursion = (t: number): boolean =>
    excursionIntervals.some(([s, e]) => t >= s - 600 && t <= e + 600)
  const diffs: number[] = []
  for (let i = 1; i < pts.length; i++) diffs.push(Math.abs(pts[i]![1] - pts[i - 1]![1]))
  const sorted = [...diffs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  if (median > 0) {
    let lastRoc = -Infinity
    for (let i = 1; i < pts.length; i++) {
      if (diffs[i - 1]! > median * 8 && pts[i]![0] - lastRoc > 1800 && !insideOwnExcursion(pts[i]![0])) {
        lastRoc = pts[i]![0]
        events.push({ t: pts[i]![0], tag, level: 'ROC', text: `${meta.label}: rapid change at ${hhmm(pts[i]![0])}` })
      }
    }
  }

  if (lines.length === 0) {
    const extra = meta.kind === 'power' ? ` ≈ ${stats.energyMWh} MWh over window.` : ''
    lines.push(`${meta.label}: ${min.toFixed(1)}–${max.toFixed(1)}${meta.unit} (avg ${avg.toFixed(1)}), now ${last.toFixed(1)}${meta.unit} — within parameters.${extra}`)
  } else if (meta.kind === 'power') {
    lines.push(`${meta.label}: ≈ ${stats.energyMWh} MWh generated over window.`)
  }

  return { stats, events, lines }
}

// --- Operator region selection ---
// The trend control POSTs the operator's selected region here so the agent
// can reference "the window shown" in prompts (trend_query useSelectedRegion).
// In-memory + latest-wins: single-operator local instance; a multi-user
// deployment would key this per instance/room.
export interface RegionSelection {
  readonly from: number
  readonly to: number
  readonly tags: ReadonlyArray<string>
  readonly savedAt: number
}
let selectedRegion: RegionSelection | null = null
export const setSelectedRegion = (sel: { from: number; to: number; tags: ReadonlyArray<string> } | null): void => {
  selectedRegion = sel ? { ...sel, savedAt: Date.now() } : null
}
export const getSelectedRegion = (): RegionSelection | null => selectedRegion

export interface TrendQueryParams {
  readonly tags: ReadonlyArray<string>
  readonly window?: string
  readonly from?: number | string
  readonly to?: number | string
  readonly points?: number
}

export interface TrendQueryResult {
  readonly from: number
  readonly to: number
  readonly modeLabel: string
  readonly series: Array<Record<string, unknown>>
  readonly events: TrendEvent[]
  readonly analysis: { overall: 'NORMAL' | 'ATTENTION' | 'ALARM'; lines: string[]; series: Record<string, unknown>; eventCount: number }
}

const parseWhen = (v: unknown): number | null => {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v)
  if (typeof v === 'string' && v.trim()) {
    const s = v.trim()
    // Numeric strings are epoch seconds/ms (URL query params arrive as
    // strings — Date.parse would reject them, and the old silent fallback
    // to the default window made region queries return window stats).
    if (/^\d{9,13}$/.test(s)) return Number(s) > 1e12 ? Math.floor(Number(s) / 1000) : Number(s)
    const ms = Date.parse(s.replace(' ', 'T'))
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000)
  }
  return null
}

export const queryTrends = async (params: TrendQueryParams): Promise<TrendQueryResult | { error: string }> => {
  // window === 'selection' resolves the operator's drag-selected region,
  // with tags defaulting to the pens of the display the selection was made
  // on. Folded into the window parameter because small models reliably
  // choose among values of a parameter they already use, but tend to
  // ignore a separate boolean flag.
  if (params.window === 'selection') {
    const sel = getSelectedRegion()
    if (!sel) {
      return { error: 'No region is currently selected on a trend display. Ask the operator to switch the display to Region mode and drag across the span of interest first.' }
    }
    return queryTrends({
      ...params,
      window: undefined,
      from: sel.from,
      to: sel.to,
      tags: params.tags.length > 0 ? params.tags : sel.tags,
    })
  }

  const tags = params.tags.map(String)
  const unknown = tags.filter(t => !TREND_TAGS[t])
  if (tags.length === 0 || unknown.length > 0) {
    return { error: `${unknown.length ? `Unknown tag(s): ${unknown.join(', ')}. ` : 'No tags given. '}Available: ${Object.keys(TREND_TAGS).join(', ')}` }
  }

  const all = await loadAll()
  let dataEnd = 0, dataStart = Infinity
  for (const pts of all.values()) if (pts.length) {
    dataEnd = Math.max(dataEnd, pts[pts.length - 1]![0])
    dataStart = Math.min(dataStart, pts[0]![0])
  }
  if (dataEnd === 0) return { error: 'Historian is empty' }

  const fromP = parseWhen(params.from)
  const toP = parseWhen(params.to)
  // Loud failure: a supplied-but-unparseable bound must NOT silently fall
  // through to the default window (that made region stats show window stats).
  if ((params.from !== undefined && fromP === null) || (params.to !== undefined && toP === null)) {
    return { error: `Unparseable from/to — use ISO datetimes or epoch seconds (got from=${String(params.from)}, to=${String(params.to)})` }
  }
  const nPts = typeof params.points === 'number' && isFinite(params.points)
    ? Math.min(MAX_POINTS, Math.max(10, Math.round(params.points))) : null

  let from: number, to: number, modeLabel: string, pointsMode = false
  if (fromP !== null || toP !== null) {
    from = Math.max(dataStart, fromP ?? dataStart)
    to = Math.min(dataEnd, toP ?? dataEnd)
    if (from >= to) return { error: `Empty range: from must be before to (data covers ${new Date(dataStart * 1000).toISOString()} – ${new Date(dataEnd * 1000).toISOString()})` }
    const f = (t: number): string => { const d = new Date(t * 1000); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hhmm(t)}` }
    modeLabel = `${f(from)} – ${f(to)}`
  } else if (nPts !== null) {
    pointsMode = true
    to = dataEnd
    let earliest = dataEnd
    for (const tag of tags) {
      const pts = all.get(tag) ?? []
      const slice = pts.slice(-nPts)
      if (slice.length) earliest = Math.min(earliest, slice[0]![0])
    }
    from = earliest
    modeLabel = `last ${nPts} samples`
  } else {
    const windowKey = typeof params.window === 'string' && TREND_WINDOWS[params.window] ? params.window : '8h'
    to = dataEnd
    from = Math.max(dataStart, dataEnd - TREND_WINDOWS[windowKey]!)
    modeLabel = `last ${windowKey}`
  }

  const seriesOut: Array<Record<string, unknown>> = []
  const allEvents: TrendEvent[] = []
  const allLines: string[] = []
  const seriesStats: Record<string, unknown> = {}

  for (const tag of tags) {
    const meta = TREND_TAGS[tag]!
    let pts = await loadHistory(tag, from, to)
    if (pointsMode && nPts !== null) pts = pts.slice(-nPts)
    const { stats, events, lines } = analyzeSeries(tag, meta, pts)
    allEvents.push(...events)
    allLines.push(...lines)
    seriesStats[tag] = stats
    seriesOut.push({
      tag, label: meta.label, unit: meta.unit, kind: meta.kind,
      step: meta.kind === 'binary',
      ...(meta.limits ? { limits: meta.limits } : {}),
      stats,
      points: (pointsMode ? pts : downsample(pts, meta.kind)).map(p => [p[0], +p[1].toFixed(2)]),
    })
  }

  allEvents.sort((a, b) => a.t - b.t)
  const stillOut = seriesOut.some(s => {
    const lim = (s as { limits?: { high?: number } }).limits
    const st = (s as { stats: { last?: number } }).stats
    return lim?.high !== undefined && typeof st.last === 'number' && st.last > lim.high
  })
  const overall = stillOut || allEvents.some(e => e.level === 'HIHI') ? 'ALARM'
    : allEvents.length > 0 ? 'ATTENTION' : 'NORMAL'

  return {
    from, to, modeLabel,
    series: seriesOut,
    events: allEvents.slice(0, 20),
    analysis: { overall, lines: allLines, series: seriesStats, eventCount: allEvents.length },
  }
}
