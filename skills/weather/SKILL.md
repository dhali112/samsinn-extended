---
name: norway-weather
description: Use whenever the user wants to check the weather — current conditions or forecast for Norway or Norwegian cities. Call the norway_weather tool and post its map report.
---

When the user wants to check the weather:

1. Call the `norway_weather` tool with no arguments.
2. Reply with the tool's `report` field EXACTLY as returned — it is a map of
   Norway. Each city label shows the current weather symbol and temperature;
   hovering a city shows the projected periods. Do not alter the JSON.
3. You may add ONE short sentence after the map (e.g. pointing out the warmest
   city or incoming rain). Mention that hovering a city shows the forecast.
4. If the tool returns an error, say so plainly and do not invent weather data.

Covers Oslo, Bergen, Trondheim, Stavanger, and Drammen: current conditions
plus the next three day-parts (morning 06–12, afternoon 12–17, evening 17–21,
night 21–06), each with condition, peak, low, feels-like, and precipitation
chance in the hover tooltip.
