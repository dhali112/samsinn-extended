---
name: plant-trends
description: Use when the operator asks to trend, plot, graph, or review the history of plant process values — power, temperature, pressure, rod position, pump status — or asks whether a parameter is behaving normally. Call trend_query and post its trend display, then interpret it.
---

Historical trend display for the plant simulation (SCADA-style online trend
control). Tag catalog by category — pick tags matching the operator's words
(names follow the pwr-ops wiki tag catalogue):

- Plant Overview: REACTOR_POWER_MW, GEN_POWER_MW (power → energy MWh),
  RCS_TEMP_C, RCS_PRESS_BAR, CTRL_ROD_POS_PCT, CHARGING_PUMP_A_RUN
- RCS: TAVG, TE-411-HOT, TE-411-COLD, SUB-MARGIN (subcooling), CET-AVG
  (core-exit temp), RCS-BORON, RCP-1, RCP-2
- Pressurizer: PT-455 (pressure), PZR-LVL, PZR-HTR, PORV-456A
- Steam Generators: SG-A-LVL-NR, SG-B-LVL-NR, SG-A-PR, SG-B-PR, SG-A-N16,
  MS-HEADER-PR, MSIV-A
- Feedwater & AFW: MFW-A-CV, AFW-FLOW, AFW-PUMP-A, AFW-PUMP-T, TDAFW-SPEED,
  CST-LVL
- Safety Injection: SI-SIG, SI-PUMP-A, SI-FLOW, RWST-LVL, ACCUM-1
- Containment: CTMT-PR, CTMT-TEMP, CTMT-RAD, CTMT-SUMP-LVL
- Reactor Control: NIS-PR-AVG (reactor power %), NIS-IR, NIS-SR, ROD-POS-AVG
- Electrical: DG-A, DG-B, BUS-A-EMERG, DC-BUS-LVL
- Radiation Monitoring: AEJ-RAD (air ejector — steam-side activity),
  MAB-RAD, CCW-RAD
- Leitbild: AMB-UNITS-AVAIL, AMB-INCIDENTS-ACTIVE, HOSP-ED-OCC

Operator phrasing hints: "subcooling" → SUB-MARGIN; "pressurizer pressure"
→ PT-455; "reactor power" → NIS-PR-AVG or REACTOR_POWER_MW; "steam generator
level" → SG-A-LVL-NR/SG-B-LVL-NR; "diesel" → DG-A/DG-B; "ambulances" →
AMB-UNITS-AVAIL. If unsure, the tool's error lists every valid tag.

Procedure:

1. Choose tags from the catalog based on the operator's request (multiple tags
   on one display is fine and encouraged when they are related, e.g. coolant
   temperature + pressure). Choose ONE time-axis mode from the operator's
   phrasing:
   - Absolute range → { from, to } as ISO datetimes
     ("between 06:00 and noon yesterday" → from: 2026-07-14T06:00, to: 2026-07-14T12:00)
   - Last N samples → { points } ("show me the last 100 data points" → points: 100, max 240)
   - Relative window → { window }: 15m, 30m, 1h, 4h, 8h, 24h, 48h, 1w
     ("past week" → 1w). Default 8h if the operator didn't say.
   - Operator's selected region → { useSelectedRegion: true } when they say
     "the window shown", "the selected region", "this region", "the span I
     selected". Tags may be omitted (they default to that display's tags).
     IMPORTANT: a "region" or "window shown" ALWAYS refers to the plant trend
     display and its process tags — never to weather maps, Leitbild
     scenarios, or any other earlier display. For region questions use ONLY
     trend_query; do not call weather or lb_* tools.
2. Call `trend_query` with { tags } plus the chosen time-axis fields.
3. Post the returned `report` field EXACTLY as returned. It is a SMALL
   ```trend config fence — the display fetches its own data from the server
   and the operator can then add/remove pens, change the time window, move a
   ruler cursor, and export CSV directly on the display; alarms and anomalies
   are marked on it automatically. Never write data points into the fence.
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
