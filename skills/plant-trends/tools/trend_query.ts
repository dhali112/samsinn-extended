// trend_query — WinCC-OnlineTrendControl-style historical trend for the
// process-plant simulation.
//
// Data source: skills/plant-trends/data/historian.csv (fake 48h historian,
// long format: ts_epoch_s,tag,value). loadHistory() below is the ONLY place
// that touches storage — to move to a real database later, replace its body:
//   PostgreSQL (Bun ≥1.2 built-in):
//     import { sql } from 'bun'
//     const rows = await sql`SELECT ts, value FROM historian
//                            WHERE tag = ${tag} AND ts BETWEEN ${from} AND ${to}
//                            ORDER BY ts`
//   MS SQL: use the `mssql` npm package with the same return shape.
// Everything downstream (windowing, stats, events, envelope) is unchanged.
//
// Per-tag semantics come from TAGS metadata:
//   kind 'binary' → stepped rendering, change-point compression, state events
//   kind 'power'  → trapezoidal integration → energy (MWh) in stats
//   limits        → HIGH/HIHI/LOW excursion detection + limit lines on chart
// Rate-of-change anomalies are flagged for analog tags (|Δ| ≫ series median).
//
// "Now" is the last timestamp in the historian, not wall-clock time — the
// fake data was generated once, so windows are anchored to data end.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

interface TagMeta {
  readonly label: string
  readonly unit: string
  readonly kind: 'analog' | 'binary' | 'power'
  readonly limits?: { low?: number; high?: number; highHigh?: number }
  readonly states?: Record<number, string>   // binary value → state name
}

const TAGS: Record<string, TagMeta> = {
  REACTOR_POWER_MW: { label: 'Reactor thermal power', unit: 'MW', kind: 'power' },
  GEN_POWER_MW: { label: 'Generator electrical power', unit: 'MW', kind: 'power', limits: { high: 1050 } },
  RCS_TEMP_C: { label: 'RCS coolant temperature', unit: '°C', kind: 'analog', limits: { low: 280, high: 305, highHigh: 310 } },
  RCS_PRESS_BAR: { label: 'RCS pressure', unit: 'bar', kind: 'analog', limits: { low: 150, high: 158 } },
  CTRL_ROD_POS_PCT: { label: 'Control rod position', unit: '%', kind: 'analog' },
  CHARGING_PUMP_A_RUN: { label: 'Charging pump A', unit: '', kind: 'binary', states: { 0: 'STOPPED', 1: 'RUNNING' } },
}

const WINDOWS: Record<string, number> = {
  '15m': 15 * 60, '30m': 30 * 60, '1h': 3600, '4h': 4 * 3600,
  '8h': 8 * 3600, '24h': 24 * 3600, '48h': 48 * 3600, '1w': 7 * 86400,
}

// Explicit sample-count mode is capped so the fence stays small enough to
// stream out of a local model in reasonable time.
const MAX_POINTS = 240

// Accepts epoch seconds, epoch milliseconds, or an ISO-ish datetime string.
const parseWhen = (v: unknown): number | null => {
  if (typeof v === 'number' && isFinite(v)) return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v)
  if (typeof v === 'string' && v.trim()) {
    const ms = Date.parse(v.trim().replace(' ', 'T'))
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000)
  }
  return null
}

type Point = readonly [number, number]   // [epoch_s, value]

// --- Storage layer (swap point for MS SQL / PostgreSQL — see header) ---
let csvCache: Map<string, Point[]> | null = null
const loadAll = async (): Promise<Map<string, Point[]>> => {
  if (csvCache) return csvCache
  const raw = await readFile(join(import.meta.dir, '..', 'data', 'historian.csv'), 'utf-8')
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

// --- Downsampling ---
// Analog/power: min-max bucketing (preserves spikes) to ≤ 2×BUCKETS points.
// Binary: exact change-point compression (first, transitions, last).
const BUCKETS = 48
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

interface TrendEvent { t: number; tag: string; level: 'HIGH' | 'HIHI' | 'LOW' | 'ROC' | 'STATE'; text: string }

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
    // Trapezoidal integration → energy over the window (MW·s → MWh)
    let mwS = 0
    for (let i = 1; i < pts.length; i++) {
      mwS += (pts[i]![1] + pts[i - 1]![1]) / 2 * (pts[i]![0] - pts[i - 1]![0])
    }
    stats.energyMWh = +(mwS / 3600).toFixed(1)
  }

  // Limit excursions
  const lim = meta.limits
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
        inExc = v > lim.high  // still true only on the last-point case
        const excEnd = t
        excTotal += excEnd - excStart
        events.push({ t: excStart, tag, level: hihi ? 'HIHI' : 'HIGH', text: `${meta.label} exceeded ${hihi ? 'HIGH-HIGH' : 'HIGH'} limit — peaked ${peak.toFixed(1)}${meta.unit} at ${hhmm(excStart)}` })
        if (!inExc) { peak = -Infinity; hihi = false }
      }
    }
    if (excTotal > 0) {
      const ongoing = last > lim.high
      lines.push(`${meta.label}: EXCEEDED HIGH limit (${lim.high}${meta.unit}) for ${fmtDur(excTotal)}${hihi || (lim.highHigh !== undefined && max > lim.highHigh) ? `, peaking above HIGH-HIGH (${lim.highHigh}${meta.unit})` : ''} — peak ${max.toFixed(1)}${meta.unit}; ${ongoing ? 'STILL above limit now' : `back in band, now ${last.toFixed(1)}${meta.unit}`}.`)
    }
  }
  if (lim?.low !== undefined && min < lim.low) {
    const t = pts[values.indexOf(min)]![0]
    events.push({ t, tag, level: 'LOW', text: `${meta.label} below LOW limit — ${min.toFixed(1)}${meta.unit} at ${hhmm(t)}` })
    lines.push(`${meta.label}: dropped below LOW limit (${lim.low}${meta.unit}), minimum ${min.toFixed(1)}${meta.unit}.`)
  }

  // Rate-of-change anomaly: |Δ| far above the series' own median |Δ|
  const diffs = []
  for (let i = 1; i < pts.length; i++) diffs.push(Math.abs(pts[i]![1] - pts[i - 1]![1]))
  const sorted = [...diffs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  if (median > 0) {
    let lastRoc = -Infinity
    for (let i = 1; i < pts.length; i++) {
      if (diffs[i - 1]! > median * 8 && pts[i]![0] - lastRoc > 1800) {
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

const tool = {
  name: 'trend_query',
  description: 'Historical trend display for plant process tags (like WinCC OnlineTrendControl). Plots one or more tags over a time window with alarm limits, event markers, stepped binary traces, and energy totals for power tags. Returns a report to post and an analysis to interpret.',
  usage: 'Pick tags matching what the operator asked about (see skill for the tag catalog) and ONE time-axis mode: from/to for an absolute range, points for the last N samples, or window for a relative duration (default 8h). Post the returned `report` verbatim, then interpret using `analysis.lines` and `analysis.overall`.',
  returns: 'Object with `report` (a ```trend fence, ready to post) and `analysis` { overall: NORMAL|ATTENTION|ALARM, lines: string[], series: per-tag stats }.',
  parameters: {
    type: 'object',
    properties: {
      tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to plot, e.g. ["RCS_TEMP_C","RCS_PRESS_BAR"]' },
      window: { type: 'string', description: 'Relative window back from latest data: 15m, 30m, 1h, 4h, 8h, 24h, 48h, 1w (default 8h)' },
      from: { type: 'string', description: 'Absolute range start (ISO datetime, e.g. 2026-07-14T06:00). Overrides window/points.' },
      to: { type: 'string', description: 'Absolute range end (ISO datetime). Defaults to latest data when only from is given.' },
      points: { type: 'number', description: `Plot exactly the last N samples per tag (10–${MAX_POINTS}). Overrides window.` },
    },
    required: ['tags'],
  },
  execute: async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tags = Array.isArray(params.tags) ? params.tags.map(String) : []
    const unknown = tags.filter(t => !TAGS[t])
    if (tags.length === 0 || unknown.length > 0) {
      return { success: false, error: `${unknown.length ? `Unknown tag(s): ${unknown.join(', ')}. ` : 'No tags given. '}Available: ${Object.keys(TAGS).join(', ')}` }
    }
    const all = await loadAll()
    let dataEnd = 0, dataStart = Infinity
    for (const pts of all.values()) if (pts.length) {
      dataEnd = Math.max(dataEnd, pts[pts.length - 1]![0])
      dataStart = Math.min(dataStart, pts[0]![0])
    }
    if (dataEnd === 0) return { success: false, error: 'Historian is empty' }

    // Time-axis mode resolution: absolute range > point count > window.
    const fromP = parseWhen(params.from)
    const toP = parseWhen(params.to)
    const nPts = typeof params.points === 'number' && isFinite(params.points)
      ? Math.min(MAX_POINTS, Math.max(10, Math.round(params.points))) : null

    let from: number, to: number, modeLabel: string, pointsMode = false
    if (fromP !== null || toP !== null) {
      from = Math.max(dataStart, fromP ?? dataStart)
      to = Math.min(dataEnd, toP ?? dataEnd)
      if (from >= to) return { success: false, error: `Empty range: from must be before to (data covers ${new Date(dataStart * 1000).toISOString()} – ${new Date(dataEnd * 1000).toISOString()})` }
      const f = (t: number): string => { const d = new Date(t * 1000); return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')} ${hhmm(t)}` }
      modeLabel = `${f(from)} – ${f(to)}`
    } else if (nPts !== null) {
      // Last N raw samples per tag; the envelope window spans the widest series.
      pointsMode = true
      to = dataEnd
      from = dataStart
      let earliest = dataEnd
      for (const tag of tags) {
        const pts = all.get(tag) ?? []
        const slice = pts.slice(-nPts)
        if (slice.length) earliest = Math.min(earliest, slice[0]![0])
      }
      from = earliest
      modeLabel = `last ${nPts} samples`
    } else {
      const windowKey = typeof params.window === 'string' && WINDOWS[params.window] ? params.window : '8h'
      to = dataEnd
      from = Math.max(dataStart, dataEnd - WINDOWS[windowKey]!)
      modeLabel = `last ${windowKey}`
    }

    const seriesOut: Record<string, unknown>[] = []
    const allEvents: TrendEvent[] = []
    const allLines: string[] = []
    const seriesStats: Record<string, unknown> = {}

    for (const tag of tags) {
      const meta = TAGS[tag]!
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
        // Points mode is exact by request (≤ MAX_POINTS raw samples);
        // range/window modes downsample to keep the fence small.
        points: (pointsMode ? pts : downsample(pts, meta.kind)).map(p => [p[0], +p[1].toFixed(2)]),
      })
    }

    allEvents.sort((a, b) => a.t - b.t)
    const cappedEvents = allEvents.slice(0, 20)

    const alarmLevels = new Set(allEvents.map(e => e.level))
    const stillOut = seriesOut.some(s => {
      const lim = (s as { limits?: { high?: number } }).limits
      const stats = (s as { stats: { last?: number } }).stats
      return lim?.high !== undefined && typeof stats.last === 'number' && stats.last > lim.high
    })
    const overall = stillOut || alarmLevels.has('HIHI') ? 'ALARM'
      : allEvents.length > 0 ? 'ATTENTION' : 'NORMAL'

    const envelope = {
      title: `Plant trend — ${tags.join(', ')} (${modeLabel})`,
      from, to,
      series: seriesOut,
      events: cappedEvents.map(e => ({ t: e.t, tag: e.tag, level: e.level, text: e.text })),
    }

    return {
      success: true,
      data: {
        report: '```trend\n' + JSON.stringify(envelope) + '\n```',
        analysis: { overall, lines: allLines, series: seriesStats, eventCount: allEvents.length },
        window: modeLabel,
      },
    }
  },
}

export default tool
