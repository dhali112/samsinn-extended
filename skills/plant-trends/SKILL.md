---
name: plant-trends
description: Use when the operator asks to trend, plot, graph, or review the history of plant process values — power, temperature, pressure, rod position, pump status — or asks whether a parameter is behaving normally. Call trend_query and post its trend display, then interpret it.
---

Historical trend display for the plant simulation (WinCC OnlineTrendControl
style). Tag catalog — pick the tags that match the operator's words:

| Tag | Meaning | Unit | Kind |
|---|---|---|---|
| REACTOR_POWER_MW | Reactor thermal power | MW | power |
| GEN_POWER_MW | Generator electrical output / power draw | MW | power |
| RCS_TEMP_C | Reactor coolant temperature | °C | analog (HIGH 305, HIHI 310, LOW 280) |
| RCS_PRESS_BAR | Reactor coolant pressure | bar | analog (HIGH 158, LOW 150) |
| CTRL_ROD_POS_PCT | Control rod position | % | analog |
| CHARGING_PUMP_A_RUN | Charging pump A running status | – | binary |

Procedure:

1. Choose tags from the catalog based on the operator's request (multiple tags
   on one display is fine and encouraged when they are related, e.g. coolant
   temperature + pressure). Choose a window: 15m, 30m, 1h, 4h, 8h, 24h, 48h —
   default 8h if the operator didn't say.
2. Call `trend_query` with { tags, window }.
3. Post the returned `report` field EXACTLY as returned (it is a ```trend
   fence — the display has its own on-screen series toggles and time-window
   selector; alarms and anomalies are marked on it automatically).
4. Then interpret the display in 2–4 sentences using `analysis`:
   - `analysis.overall` is NORMAL / ATTENTION / ALARM — state it plainly
     (e.g. "operating within parameters" / "needs attention" / "alarm state").
   - Use `analysis.lines` for the specifics (excursions, pump trips, energy
     totals). Do not invent numbers not present in the analysis.
5. If the operator asks a follow-up about an already-posted trend, call
   `trend_query` again with the same tags/window and answer from `analysis`
   without re-posting the display.

Binary tags render stepped automatically; power tags include energy (MWh)
integrated over the window; alarm-limit crossings, rapid changes, and state
changes appear as markers on the display.
