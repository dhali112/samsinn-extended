# Trend Control — contribution package

A SCADA/HMI-style historical trend display for samsinn:
an interactive front-end chart object driven by a new ```` ```trend ```` fence,
an archive API backed by a plant historian, and an AI skill so agents can
configure a display from operator phrasing and interpret what it shows.

Built in [dhali112/samsinn-extended](https://github.com/dhali112/samsinn-extended)
(a detached fork of this repo). Everything in this folder is self-contained:
one patch against `827c887`, one demo-data generator, this guide. MIT, same
as the repo. Tag names/units follow the pwr-ops wiki tag catalogue
(samsinn-wikis.github.io/pwr-ops/tags).

## What it does

- **New inline block type ```` ```trend ````** — renders an interactive SVG chart
  (no external libs): multi-series traces, dual value axes by unit group,
  stepped binary lanes, dashed alarm-limit lines colored per owning trace,
  event markers with tooltips, live statistics table, event list.
- **Operator controls on the display**: categorized tag dropdown with
  checkboxes, three time-axis modes — relative window / absolute start–end /
  last-N-samples, ruler cursor with per-tag readout, drag-select region with
  exact server statistics, per-tag color picker from a fixed palette,
  refresh (relative windows re-anchor to latest data), CSV export.
- **Data never passes through the LLM.** The fence carries only a ~200-byte
  config (tags + time axis); the browser control fetches samples from
  `/api/trends/data` and re-fetches on every interaction. (First iteration
  embedded data in the fence; a 7B local model needed an hour to copy it and
  corrupted the JSON. Config-only is the fix.)
- **Agent integration** (`skills/plant-trends`): the `trend_query` tool
  validates tags/time, returns the config fence plus a server-computed
  analysis (overall NORMAL/ATTENTION/ALARM + findings) the agent uses to
  interpret the display. The operator's drag-selected region is stored
  server-side, so "identify the alarm in the window shown" resolves to the
  actual selected span (`useSelectedRegion: true`).
- **Tag semantics from metadata**: binary → stepped + change-point
  compression + state events; power → trapezoidal energy (MWh); limits →
  HIGH/HIHI/LOW excursion detection; rate-of-change anomalies (suppressed
  inside a tag's own excursion to avoid double-reporting one disturbance).

## Files (in the patch)

| Path | Role |
|---|---|
| `src/trends/historian.ts` | Data layer: 54-tag catalog (categorized), CSV loading, windowing, min-max downsampling, per-series analysis, region-selection store. `loadHistory()` is the single storage swap point — a real DB (Bun's built-in Postgres client, or mssql) replaces its body and nothing downstream changes. |
| `src/api/routes/trends.ts` | `GET /api/trends/tags`, `GET /api/trends/data` (window \| from/to \| points), `POST/GET /api/trends/selection`. |
| `src/api/http-routes.ts` | +2 lines: route registration. |
| `src/ui/modules/trend/index.ts` | The front-end trend control (self-registers a post-render processor for `code.language-trend`, same pattern as mermaid/map). |
| `src/ui/modules/render/render-message.ts` | +1 line: module import. |
| `skills/plant-trends/SKILL.md` | Agent skill: tag catalog by category, phrasing hints, procedure, region-reference grounding. |
| `skills/plant-trends/tools/trend_query.ts` | Bundled tool (config fence + analysis). |

Not in the patch: the demo historian CSV (`skills/plant-trends/data/` is
gitignored and 2 MB). Generate it instead — see below.

## Applying

```bash
git checkout -b feature/trend-control 827c887   # or rebase the patch onto current master
git apply trend-control.patch
bun contrib/trend-control/generate-historian.ts # writes skills/plant-trends/data/historian.csv
bun run check
bun run start
```

Then in any room, post this to see it working (fences render in operator
messages too):

````
```trend
{"trends":[{"tag":"PT-455"},{"tag":"SUB-MARGIN"},{"tag":"CHARGING_PUMP_A_RUN"}],"time":{"window":"8h"}}
```
````

Or ask an agent that has `trend_query`: *"trend the pressurizer pressure and
subcooling margin for the last 8 hours — anything abnormal?"* The demo data
contains a planted RCS excursion ~6 h before data end (TAVG/PT-455 limit
crossings, subcooling dip, brief PORV lift, AEJ-RAD rise) plus surveillance
runs (DG-A, TDAFW, SI pump) and a load-follow ramp.

## Fence config format

```json
{ "title": "optional",
  "trends": [ { "tag": "PT-455", "color": "#dc2626" } ],
  "time": { "window": "8h" } }
```

`time` is one of `{window: 15m|30m|1h|4h|8h|24h|48h|1w}`,
`{from, to}` (ISO datetimes), or `{points: N}` (last N raw samples, ≤240,
exact — no downsampling). `color` is optional per trend. Legacy fences with
embedded `series[].points` still render via a local provider.

## Notes for review

- Relative windows anchor to the **latest data timestamp**, not wall clock —
  right for a static demo CSV; with a live DB they coincide.
- The region selection store is in-memory latest-wins (single-operator
  assumption); a multi-tenant deployment would key it per instance.
- Known omissions vs a full HMI trend object model: multiple stacked trend
  windows (binary lanes cover the common case), named/saved view configs,
  and live-scrolling online mode (meaningful once a live DB is behind it).
- The UI file is ~700 lines; the deliberate constraints were: no external
  chart lib, loud failures (unparseable fence keeps raw source visible with
  a warning), and every operator interaction = a fresh archive query rather
  than client-side slicing.
