---
name: plant-trends
description: Use when the operator asks to trend, plot, graph, or review the history of plant process values — temperature, pressure, power, levels, pump status — or asks whether a parameter is behaving normally. Call trend_query, then interpret its analysis.
---

Historical trend display for the plant simulation. Always answer trend
questions by calling `trend_query` — the display is delivered to the room
automatically; your job is picking the right tags/time and interpreting.

Tags by category (pick the ones matching the operator's words):

- Plant Overview: REACTOR_POWER_MW, GEN_POWER_MW, RCS_TEMP_C, RCS_PRESS_BAR, CTRL_ROD_POS_PCT, CHARGING_PUMP_A_RUN
- RCS: TAVG, TE-411-HOT, TE-411-COLD, SUB-MARGIN, CET-AVG, RCS-BORON, RCP-1, RCP-2
- Pressurizer: PT-455, PZR-LVL, PZR-HTR, PORV-456A
- Steam Generators: SG-A-LVL-NR, SG-B-LVL-NR, SG-A-PR, SG-B-PR, SG-A-N16, MS-HEADER-PR, MSIV-A
- Feedwater & AFW: MFW-A-CV, AFW-FLOW, AFW-PUMP-A, AFW-PUMP-T, TDAFW-SPEED, CST-LVL
- Safety Injection: SI-SIG, SI-PUMP-A, SI-FLOW, RWST-LVL, ACCUM-1
- Containment: CTMT-PR, CTMT-TEMP, CTMT-RAD, CTMT-SUMP-LVL
- Reactor Control: NIS-PR-AVG, NIS-IR, NIS-SR, ROD-POS-AVG
- Electrical: DG-A, DG-B, BUS-A-EMERG, DC-BUS-LVL
- Radiation Monitoring: AEJ-RAD, MAB-RAD, CCW-RAD
- Leitbild: AMB-UNITS-AVAIL, AMB-INCIDENTS-ACTIVE, HOSP-ED-OCC

Hints: "subcooling" → SUB-MARGIN · "pressurizer pressure" → PT-455 ·
"reactor power" → NIS-PR-AVG · "SG level" → SG-A-LVL-NR · "diesel" → DG-A.

Time axis (one of): { window: 15m|30m|1h|4h|8h|24h|48h|1w } (default 8h) ·
{ from, to } as ISO datetimes · { points: N } for the last N samples (≤240) ·
{ window: "selection" } when the operator says "the selected region", "the
window shown", or "this region" (tags optional — they default to that
display's tags; a region always refers to this trend display, never to
weather or Leitbild).

After the call, reply with 2–4 sentences from `analysis`: state
`analysis.overall` (NORMAL / ATTENTION / ALARM) plainly and use
`analysis.lines` for specifics. Use only numbers from the analysis.
Do not write any diagram or fence yourself — the trend display is
attached to your message automatically.
