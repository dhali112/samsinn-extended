// norway_weather — Current + projected weather for Norway's 5 biggest cities.
//
// Data: Open-Meteo (https://open-meteo.com) — free, no API key required.
// One request covers all five cities (comma-separated coordinates).
//
// Day-part periods (Europe/Oslo local time):
//   morning 06–12 · afternoon 12–17 · evening 17–21 · night 21–06
// Projections cover the NEXT THREE periods after the one we are currently in
// (e.g. during the evening: night, morning, afternoon).
//
// Output is a single ```map fence framed on Norway. Each city marker shows a
// permanent bold label "City <symbol> <temp>°"; hovering the marker reveals
// current conditions plus the three projected periods (condition, peak, low,
// feels-like, precipitation chance). The label+tooltip pairing relies on the
// renderer treating markers with BOTH fields as permanently labeled
// (src/ui/modules/map/index.ts).

const CITIES = [
  { name: 'Oslo', lat: 59.9139, lng: 10.7522 },
  { name: 'Bergen', lat: 60.3913, lng: 5.3221 },
  { name: 'Trondheim', lat: 63.4305, lng: 10.3951 },
  { name: 'Stavanger', lat: 58.9700, lng: 5.7331 },
  { name: 'Drammen', lat: 59.7439, lng: 10.2045 },
] as const

// Frame the whole of Norway (Lindesnes to Nordkapp), not just the five
// southern cities — auto-fit would crop everything north of Trondheim.
const NORWAY_VIEW = { center: [64.5, 12.5] as [number, number], zoom: 4 }

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

const symbol = (code: number): string => {
  if (code === 0) return '☀️'
  if (code === 1) return '🌤️'
  if (code === 2) return '⛅'
  if (code === 3) return '☁️'
  if (code === 45 || code === 48) return '🌫️'
  if (code >= 51 && code <= 57) return '🌦️'
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return '🌧️'
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return '🌨️'
  if (code >= 95) return '⛈️'
  return '🌡️'
}

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
  readonly symbol: string
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

const summarize = (period: PeriodName, hours: ReadonlyArray<HourPoint>): PeriodSummary => {
  const code = dominantCode(hours.map(h => h.code))
  return {
    period,
    weekday: weekdayOf(hours[0]!.date),
    condition: condition(code),
    symbol: symbol(code),
    peak: Math.round(Math.max(...hours.map(h => h.temp))),
    low: Math.round(Math.min(...hours.map(h => h.temp))),
    feelsLike: Math.round(hours.reduce((s, h) => s + h.feels, 0) / hours.length),
    precipChance: Math.round(Math.max(...hours.map(h => h.precip))),
  }
}

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

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

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
  description: "Live weather map of Norway: current conditions and the next three day-part forecasts (morning/afternoon/evening/night) for the 5 biggest cities — Oslo, Bergen, Trondheim, Stavanger, Drammen. No parameters.",
  usage: 'Call with no arguments whenever the user wants to check the weather in Norway or Norwegian cities. Present the returned `report` field verbatim — it is a map fence; city labels show current weather, hovering a city shows the forecast.',
  returns: 'Object with `report` (a ```map fence of Norway, ready to post) and `data` (structured per-city numbers).',
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
          symbol: symbol(loc.current.weather_code),
          temp: Math.round(loc.current.temperature_2m),
          feelsLike: Math.round(loc.current.apparent_temperature),
          precipChance: nowIdx >= 0 ? Math.round(hours[nowIdx]!.precip) : null,
        },
        projected: nextThreePeriods(hours, nowTime, currentPeriod),
      }
    })

    // Marker label = permanent bold caption (city + current symbol + temp).
    // Tooltip = hover detail; the map renderer inserts it as HTML.
    const mapEnvelope = {
      view: NORWAY_VIEW,
      features: cities.map(c => {
        const rows = c.projected.map(p =>
          `<b>${cap(p.period)} (${p.weekday} ${PERIOD_RANGE[p.period]}):</b> ${p.symbol} ${p.condition} · peak ${p.peak}° · low ${p.low}° · feels ${p.feelsLike}° · precip ${p.precipChance}%`,
        )
        return {
          type: 'marker', lat: c.lat, lng: c.lng, icon: 'dot',
          label: `${c.city} ${c.current.symbol} ${c.current.temp}°`,
          tooltip: [
            `<b>Now:</b> ${c.current.symbol} ${c.current.condition} · ${c.current.temp}° · feels ${c.current.feelsLike}° · precip ${c.current.precipChance ?? '–'}%`,
            ...rows,
          ].join('<br>'),
        }
      }),
    }

    const report = '```map\n' + JSON.stringify(mapEnvelope, null, 1) + '\n```'

    return {
      success: true,
      data: {
        report,
        generatedAt: nowTime,
        currentPeriod,
        cities,
      },
    }
  },
}

export default tool
