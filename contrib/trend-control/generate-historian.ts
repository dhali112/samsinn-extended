// Generates 48h of fake historian data for the full tag catalog (long CSV:
// ts_epoch_s,tag,value). Per-tag sampling rates:
//   30 s  — fast neutronics/pressure (NIS-PR-AVG, PT-455, TAVG)
//   60 s  — most process analogs
//   120 s — slower secondary/instrument channels
//   300 s — tank levels, radiation monitors, boron, Leitbild counts
//   binaries — change-of-state rows plus a 30-min heartbeat
//
// Storyline (relative to data end):
//   h18–30   load-follow ramp 3000→2400→3000 MW
//   end-26h  DG-A monthly surveillance run (2 h)
//   end-20h  turbine-driven AFW pump surveillance test (1 h)
//   end-28h  SI pump A quarterly test (30 min)
//   end-30h  charging pump A trip (25 min)
//   end-6h   RCS temperature excursion: TAVG/CET spike, subcooling dip,
//            PZR pressure bump w/ brief PORV lift, AEJ-RAD rise,
//            charging pump A trip, post-event boration
//   Leitbild: ambulance availability random walk, evening incident peak

const H = 3600
const end = Math.floor(Date.now() / 1000 / 60) * 60
const start = end - 48 * H

let seed = 1234
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed / 0x7fffffff
}
const noise = (amp: number): number => (rnd() * 2 - 1) * amp

const rows: string[] = ['ts,tag,value']
const emit = (t: number, tag: string, v: number, dp = 2): void => {
  rows.push(`${t},${tag},${v.toFixed(dp)}`)
}

// --- shared storyline signals ---
const excursionStart = end - 6 * H
const powerAt = (t: number): number => {
  const h = (t - start) / H
  let p = 3000
  if (h >= 18 && h < 20) p = 3000 - ((h - 18) / 2) * 600
  else if (h >= 20 && h < 28) p = 2400
  else if (h >= 28 && h < 30) p = 2400 + ((h - 28) / 2) * 600
  return p
}
// 0..1 profile of the temperature excursion (rise 12 min, hold 4, decay 20)
const excAt = (t: number): number => {
  const dt = t - excursionStart
  if (dt < 0 || dt > 36 * 60) return 0
  if (dt < 12 * 60) return dt / (12 * 60)
  if (dt < 16 * 60) return 1
  return 1 - (dt - 16 * 60) / (20 * 60)
}

// --- analog generators: tag → (t) => value ---
const A: Record<string, { rate: number; dp?: number; f: (t: number) => number }> = {
  // Plant Overview (legacy)
  REACTOR_POWER_MW: { rate: 60, dp: 1, f: t => powerAt(t) + noise(8) },
  GEN_POWER_MW: { rate: 60, dp: 1, f: t => powerAt(t) / 3 * 0.98 + noise(5) },
  CTRL_ROD_POS_PCT: { rate: 60, dp: 1, f: t => 95 - (3000 - powerAt(t)) / 600 * 17 + noise(0.2) },
  RCS_TEMP_C: { rate: 60, f: t => 292 + (powerAt(t) - 3000) * 0.004 + excAt(t) * 20 + noise(0.4) },
  RCS_PRESS_BAR: { rate: 60, f: t => 155 + excAt(t) * 2.5 + noise(0.3) },
  // RCS
  'TAVG': { rate: 30, dp: 1, f: t => 588 + (powerAt(t) - 3000) * 0.006 + excAt(t) * 14 + noise(0.5) },
  'TE-411-HOT': { rate: 60, dp: 1, f: t => 618 + (powerAt(t) - 3000) * 0.008 + excAt(t) * 16 + noise(0.7) },
  'TE-411-COLD': { rate: 60, dp: 1, f: t => 558 + (powerAt(t) - 3000) * 0.003 + excAt(t) * 8 + noise(0.5) },
  'SUB-MARGIN': { rate: 60, dp: 1, f: t => 42 - excAt(t) * 21 + noise(0.8) },
  'CET-AVG': { rate: 60, dp: 1, f: t => 620 + (powerAt(t) - 3000) * 0.008 + excAt(t) * 18 + noise(0.8) },
  'RCS-BORON': { rate: 300, dp: 0, f: t => 950 - (t - start) / H * 0.2 + (t > excursionStart + 40 * 60 ? 30 : 0) + noise(2) },
  // Pressurizer
  'PT-455': { rate: 30, dp: 0, f: t => 2235 + excAt(t) * 130 + noise(4) },
  'PZR-LVL': { rate: 60, dp: 1, f: t => 58 + (powerAt(t) - 3000) * 0.004 + excAt(t) * 9 + noise(0.5) },
  // Steam generators
  'SG-A-LVL-NR': { rate: 60, dp: 1, f: t => 57 + noise(2.2) - excAt(t) * 6 },
  'SG-B-LVL-NR': { rate: 60, dp: 1, f: t => 57 + noise(2.0) },
  'SG-A-PR': { rate: 60, dp: 0, f: t => 985 + (3000 - powerAt(t)) * 0.02 + excAt(t) * 25 + noise(4) },
  'SG-B-PR': { rate: 60, dp: 0, f: t => 985 + (3000 - powerAt(t)) * 0.02 + noise(4) },
  'SG-A-N16': { rate: 120, dp: 0, f: t => 5200 * powerAt(t) / 3000 + excAt(t) * 900 + noise(120) },
  'MS-HEADER-PR': { rate: 120, dp: 0, f: t => 975 + (3000 - powerAt(t)) * 0.018 + noise(4) },
  // Feedwater & AFW
  'MFW-A-CV': { rate: 120, dp: 1, f: t => 30 + powerAt(t) / 3000 * 48 + noise(1) },
  'AFW-FLOW': { rate: 60, dp: 0, f: t => (inWindow(t, end - 20 * H, 60) ? 440 + noise(20) : 0 + Math.abs(noise(2))) },
  'TDAFW-SPEED': { rate: 120, dp: 0, f: t => (inWindow(t, end - 20 * H, 60) ? 3900 + noise(60) : 0) },
  'CST-LVL': { rate: 300, dp: 1, f: t => 68 - (t - start) / (48 * H) * 1.5 - (inWindow(t, end - 20 * H, 60) ? 0.8 : 0) + noise(0.1) },
  // Safety injection
  'SI-FLOW': { rate: 60, dp: 0, f: t => (inWindow(t, end - 28 * H, 30) ? 640 + noise(25) : 0) },
  'RWST-LVL': { rate: 300, dp: 1, f: t => 92 - (inWindow(t, end - 28 * H, 30) ? 0.4 : 0) + noise(0.08) },
  // Containment
  'CTMT-PR': { rate: 120, dp: 2, f: t => 0.3 + excAt(t) * 0.35 + noise(0.05) },
  'CTMT-TEMP': { rate: 300, dp: 1, f: t => 105 + excAt(t) * 4 + noise(0.8) },
  'CTMT-RAD': { rate: 300, dp: 2, f: t => 0.5 + excAt(t) * 0.8 + Math.abs(noise(0.05)) },
  'CTMT-SUMP-LVL': { rate: 300, dp: 1, f: () => 1.2 + Math.abs(noise(0.15)) },
  // Reactor control
  'NIS-PR-AVG': { rate: 30, dp: 1, f: t => powerAt(t) / 3000 * 100 + noise(0.3) },
  'NIS-IR': { rate: 120, dp: 1, f: t => 320 * powerAt(t) / 3000 + noise(4) },
  'NIS-SR': { rate: 300, dp: 0, f: () => 2 + Math.abs(noise(1)) },
  'ROD-POS-AVG': { rate: 60, dp: 0, f: t => 216 - (3000 - powerAt(t)) / 600 * 38 + noise(0.4) },
  // Electrical
  'DC-BUS-LVL': { rate: 300, dp: 1, f: () => 131.5 + noise(0.4) },
  // Radiation
  'AEJ-RAD': { rate: 300, dp: 0, f: t => 210 + excAt(t) * 160 + noise(15) },
  'MAB-RAD': { rate: 300, dp: 3, f: () => 0.012 + Math.abs(noise(0.002)) },
  'CCW-RAD': { rate: 300, dp: 3, f: () => 0.008 + Math.abs(noise(0.0015)) },
  // Leitbild
  'AMB-UNITS-AVAIL': { rate: 300, dp: 0, f: t => Math.max(0, Math.min(6, Math.round(4 + Math.sin((t - start) / H / 3.8) * 1.6 + noise(1)))) },
  'AMB-INCIDENTS-ACTIVE': { rate: 300, dp: 0, f: t => Math.max(0, Math.round(1 + Math.sin(((t / 3600) % 24 - 19) / 24 * 2 * Math.PI) * 1.4 + noise(0.9))) },
  'HOSP-ED-OCC': { rate: 300, dp: 0, f: t => Math.max(40, Math.min(99, 72 + Math.sin(((t / 3600) % 24 - 20) / 24 * 2 * Math.PI) * 14 + noise(4))) },
}

function inWindow(t: number, from: number, minutes: number): boolean {
  return t >= from && t < from + minutes * 60
}

for (const [tag, spec] of Object.entries(A)) {
  for (let t = start; t <= end; t += spec.rate) emit(t, tag, spec.f(t), spec.dp ?? 2)
}

// --- binaries: change-of-state + 30-min heartbeat ---
const B: Record<string, (t: number) => number> = {
  CHARGING_PUMP_A_RUN: t => (inWindow(t, end - 30 * H, 25) || inWindow(t, excursionStart + 5 * 60, 18) ? 0 : 1),
  'RCP-1': () => 1,
  'RCP-2': () => 1,
  'PZR-HTR': t => (excAt(t) > 0.1 ? 0 : (Math.floor(t / (45 * 60)) % 2)),   // heaters cycle; off during over-pressure
  'PORV-456A': t => (inWindow(t, excursionStart + 11 * 60, 3) ? 1 : 0),      // brief lift at the pressure peak
  'MSIV-A': () => 1,
  'AFW-PUMP-A': () => 0,
  'AFW-PUMP-T': t => (inWindow(t, end - 20 * H, 60) ? 1 : 0),
  'SI-SIG': () => 0,
  'SI-PUMP-A': t => (inWindow(t, end - 28 * H, 30) ? 1 : 0),
  'ACCUM-1': () => 1,
  'DG-A': t => (inWindow(t, end - 26 * H, 120) ? 1 : 0),
  'DG-B': () => 0,
  'BUS-A-EMERG': () => 1,
}

for (const [tag, f] of Object.entries(B)) {
  let prev: number | null = null
  for (let t = start; t <= end; t += 60) {
    const v = f(t)
    const heartbeat = (t - start) % (30 * 60) === 0
    if (v !== prev || heartbeat || t === end) emit(t, tag, v, 0)
    prev = v
  }
}

rows.sort((a, b) => {
  const ta = Number(a.slice(0, a.indexOf(','))), tb = Number(b.slice(0, b.indexOf(',')))
  return (isNaN(ta) ? -1 : ta) - (isNaN(tb) ? -1 : tb)
})

// Run from the repo root: bun contrib/trend-control/generate-historian.ts
await Bun.write('skills/plant-trends/data/historian.csv', rows.join('\n') + '\n')
console.log(`wrote ${rows.length - 1} rows, ${Object.keys(A).length} analog + ${Object.keys(B).length} binary tags, ${start} → ${end}`)
