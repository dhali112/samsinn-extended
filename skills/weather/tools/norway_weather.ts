// norway_weather — Current + projected weather for Norway's 5 biggest cities.
//
// Data: Open-Meteo (https://open-meteo.com) — free, no API key required.
// One request covers all five cities (comma-separated coordinates).
//
// Day-part periods (Europe/Oslo local time):
//   morning 06–12 · afternoon 12–17 · evening 17–21 · night 21–06
// The report shows current conditions plus the NEXT THREE periods after the
// one we are currently in (e.g. during the evening: night, morning, afternoon).
//
// Per period: condition (most frequent WMO code, ties → more severe),
// peak temp (max), low temp (min), feels-like (mean apparent temperature),
// precipitation chance (max hourly probability).

const CITIES = [
  { name: 'Oslo', lat: 59.9139, lng: 10.7522 },
  { name: 'Bergen', lat: 60.3913, lng: 5.3221 },
  { name: 'Trondheim', lat: 63.4305, lng: 10.3951 },
  { name: 'Stavanger', lat: 58.9700, lng: 5.7331 },
  { name: 'Drammen', lat: 59.7439, lng: 10.2045 },
] as const

const WMO: Record<number, string> = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Icy fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
  66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
  85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Thunderstorm w/ hail',
}

const condition = (code: number): string => WMO[code] ?? `Code ${code}`

type PeriodName = 'morning' | 'afternoon' | 'evening' | 'night'

const PERIOD_RANGE: Record<PeriodName, string> = {
  morning: '06–12', afternoon: '12–17', evening: '17–21', night: '21–06',
}

const periodOf = (hour: number): PeriodName => {
  if (hour >= 6 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 17) return 'afternoon'
  if (hour >= 17 && hour < 21) return 'evening'
  return 'night'
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const weekdayOf = (isoDate: string): string => WEEKDAYS[new Date(`${isoDate}T00:00:00Z`).getUTCDay()]!

interface HourPoint {
  readonly time: string     // "2026-07-15T14:00" (Europe/Oslo local)
  readonly hour: number
  readonly date: string     // "2026-07-15"
  readonly temp: number
  readonly feels: number
  readonly precip: number   // probability 0–100
  readonly code: number
}

interface PeriodSummary {
  readonly period: PeriodName
  readonly weekday: string
  readonly condition: string
  readonly peak: number
  readonly low: number
  readonly feelsLike: number
  readonly precipChance: number
}

// Most frequent WMO code in the period; ties broken by the higher (more
// severe) code so a rain/clear split never reads as "Clear".
const dominantCode = (codes: ReadonlyArray<number>): number => {
  const counts = new Map<number, number>()
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1)
  let best = codes[0] ?? 0
  let bestCount = 0
  for (const [code, count] of counts) {
    if (count > bestCount || (count === bestCount && code > best)) {
      best = code
      bestCount = count
    }
  }
  return best
}

const summarize = (period: PeriodName, hours: ReadonlyArray<HourPoint>): PeriodSummary => ({
  period,
  weekday: weekdayOf(hours[0]!.date),
  condition: condition(dominantCode(hours.map(h => h.code))),
  peak: Math.round(Math.max(...hours.map(h => h.temp))),
  low: Math.round(Math.min(...hours.map(h => h.temp))),
  feelsLike: Math.round(hours.reduce((s, h) => s + h.feels, 0) / hours.length),
  precipChance: Math.round(Math.max(...hours.map(h => h.precip))),
})

// Walk hours after `nowTime`, skip the remainder of the current period, then
// collect the next three consecutive-period groups. The night group spans
// midnight naturally because its hours are consecutive in the flat list.
const nextThreePeriods = (hours: ReadonlyArray<HourPoint>, nowTime: string, currentPeriod: PeriodName): PeriodSummary[] => {
  let i = hours.findIndex(h => h.time > nowTime)
  if (i === -1) return []
  while (i < hours.length && periodOf(hours[i]!.hour) === currentPeriod) i++
  const groups: PeriodSummary[] = []
  while (i < hours.length && groups.length < 3) {
    const label = periodOf(hours[i]!.hour)
    const group: HourPoint[] = []
    while (i < hours.length && periodOf(hours[i]!.hour) === label) {
      group.push(hours[i]!)
      i++
    }
    groups.push(summarize(label, group))
  }
  return groups
}

interface OpenMeteoLocation {
  readonly current: { time: string; temperature_2m: number; apparent_temperature: number; weather_code: number }
  readonly hourly: {
    time: string[]
    temperature_2m: number[]
    apparent_temperature: number[]
    precipitation_probability: number[]
    weather_code: number[]
  }
}

const tool = {
  name: 'norway_weather',
  description: "Current weather and the next three day-part forecasts (morning/afternoon/evening/night) for Norway's 5 biggest cities: Oslo, Bergen, Trondheim, Stavanger, Drammen. No parameters.",
  usage: 'Call with no arguments whenever the user asks about weather in Norway or Norwegian cities. Present the returned `report` field verbatim — it contains a rendered map and formatted tables.',
  returns: 'Object with `report` (markdown incl. a ```map fence, ready to post) and `data` (structured per-city numbers).',
  parameters: { type: 'object', properties: {}, required: [] },
  execute: async (): Promise<Record<string, unknown>> => {
    const lats = CITIES.map(c => c.lat).join(',')
    const lngs = CITIES.map(c => c.lng).join(',')
    const url = 'https://api.open-meteo.com/v1/forecast'
      + `?latitude=${lats}&longitude=${lngs}`
      + '&current=temperature_2m,apparent_temperature,weather_code'
      + '&hourly=temperature_2m,apparent_temperature,precipitation_probability,weather_code'
      + '&timezone=Europe%2FOslo&forecast_days=3'

    let locations: OpenMeteoLocation[]
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return { success: false, error: `Open-Meteo error ${res.status}: ${await res.text()}` }
      const body = await res.json() as OpenMeteoLocation | OpenMeteoLocation[]
      locations = Array.isArray(body) ? body : [body]
    } catch (err) {
      return { success: false, error: `Open-Meteo request failed: ${err instanceof Error ? err.message : String(err)}` }
    }
    if (locations.length !== CITIES.length) {
      return { success: false, error: `Expected ${CITIES.length} locations from Open-Meteo, got ${locations.length}` }
    }

    const nowTime = locations[0]!.current.time
    const nowHour = Number(nowTime.slice(11, 13))
    const currentPeriod = periodOf(nowHour)

    const cities = CITIES.map((city, idx) => {
      const loc = locations[idx]!
      const h = loc.hourly
      const hours: HourPoint[] = h.time.map((t, i) => ({
        time: t,
        hour: Number(t.slice(11, 13)),
        date: t.slice(0, 10),
        temp: h.temperature_2m[i]!,
        feels: h.apparent_temperature[i]!,
        precip: h.precipitation_probability[i] ?? 0,
        code: h.weather_code[i]!,
      }))
      const nowIdx = hours.findIndex(x => x.time >= nowTime.slice(0, 13) + ':00')
      return {
        city: city.name,
        lat: city.lat,
        lng: city.lng,
        current: {
          condition: condition(loc.current.weather_code),
          temp: Math.round(loc.current.temperature_2m),
          feelsLike: Math.round(loc.current.apparent_temperature),
          precipChance: nowIdx >= 0 ? Math.round(hours[nowIdx]!.precip) : null,
        },
        projected: nextThreePeriods(hours, nowTime, currentPeriod),
      }
    })

    // --- Ready-to-post report: map fence + one table per section ---
    const mapEnvelope = {
      features: cities.map(c => ({
        type: 'marker', lat: c.lat, lng: c.lng,
        label: `${c.city} ${c.current.temp}°`, tooltip: c.current.condition, icon: 'city',
      })),
    }

    const lines: string[] = []
    lines.push('```map')
    lines.push(JSON.stringify(mapEnvelope, null, 1))
    lines.push('```')
    lines.push('')
    lines.push(`**Current — ${weekdayOf(nowTime.slice(0, 10))} ${nowTime.slice(11, 16)} (${currentPeriod})**`)
    lines.push('')
    lines.push('| City | Weather | Temp | Feels like | Precip |')
    lines.push('|---|---|---|---|---|')
    for (const c of cities) {
      lines.push(`| ${c.city} | ${c.current.condition} | ${c.current.temp}° | ${c.current.feelsLike}° | ${c.current.precipChance ?? '–'}% |`)
    }
    const periods = cities[0]!.projected
    periods.forEach((p, pi) => {
      lines.push('')
      lines.push(`**${p.period.charAt(0).toUpperCase() + p.period.slice(1)} (${p.weekday} ${PERIOD_RANGE[p.period]})**`)
      lines.push('')
      lines.push('| City | Weather | Peak | Low | Feels like | Precip |')
      lines.push('|---|---|---|---|---|---|')
      for (const c of cities) {
        const s = c.projected[pi]
        if (s) lines.push(`| ${c.city} | ${s.condition} | ${s.peak}° | ${s.low}° | ${s.feelsLike}° | ${s.precipChance}% |`)
      }
    })

    return {
      success: true,
      data: {
        report: lines.join('\n'),
        generatedAt: nowTime,
        currentPeriod,
        cities,
      },
    }
  },
}

export default tool
