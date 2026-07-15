---
name: norway-weather
description: Use when the user asks about the weather in Norway or Norwegian cities — current conditions, forecast, "what's the weather like", temperature, rain chances. Call the norway_weather tool and present its report.
---

When the user asks about weather in Norway or its cities:

1. Call the `norway_weather` tool with no arguments.
2. Reply with the tool's `report` field EXACTLY as returned — it already contains
   a map fence and formatted tables. Do not alter any numbers, rows, or the map
   block. You may add ONE short sentence of your own after the report (e.g.
   pointing out the warmest city or an incoming rain front).
3. If the tool returns an error, say so plainly and do not invent weather data.

The report covers Oslo, Bergen, Trondheim, Stavanger, and Drammen: current
conditions plus the next three day-parts (morning 06–12, afternoon 12–17,
evening 17–21, night 21–06), each with condition, peak, low, feels-like, and
precipitation chance.
