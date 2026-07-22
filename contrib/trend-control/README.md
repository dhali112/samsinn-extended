# Trend Control — contribution package

A SCADA/HMI-style historical trend display for samsinn: an interactive
front-end chart object driven by a new ```` ```trend ```` fence, an archive
API backed by a plant historian, and an AI skill so agents can configure a
display from operator phrasing and interpret what it shows.

Built in [dhali112/samsinn-extended](https://github.com/dhali112/samsinn-extended)
(a detached fork of this repo). Everything in this folder is self-contained:
one patch against `827c887`, one demo-data generator, this guide. MIT, same
as the repo. Tag names, units, and system groupings follow the pwr-ops wiki
tag catalogue (samsinn-wikis.github.io/pwr-ops/tags).

## What it does

- **New inline block type ```` ```trend ````** — an interactive SVG chart
  (no external libs): multi-series traces, dual value axes by unit group,
  stepped binary lanes, per-trace alarm-limit lines, event markers, live
  statistics table, event list.
- **Categorized tag selector**: a "Tags" dropdown of expandable categories
  (RCS, Pressurizer, Steam Generators, Feedwater & AFW, Safety Injection,
  Containment, Reactor Control, Electrical, Radiation Monitoring, Leitbild,
  Plant Overview), each tag a checkbox; toggling re-queries the archive.
  54 tags ship, drawn from the pwr-ops catalogue.
- **Time axis, three modes**: relative window (15m…1w), absolute start–end
  (datetime pickers), or last-N-samples — all re-query the archive, so any
  range is reachable; a refresh button re-anchors relative windows to the
  latest data.
- **Cursor tooling**: Ruler mode (hover crosshair with per-tag readout,
  click to lock) or Region mode (drag to select a span). A selected region
  shows exact server-computed statistics in a strip below the chart —
  per-tag avg/min/max, energy for power tags, state changes for binary —
  with events classified honestly (alarms vs state changes vs notices).
- **Region → agent handoff**: the strip has an
  "ask the agent about the selected region" button that submits the
  question (with explicit times) through the room composer; the selection
  is also stored server-side (persisted to disk across restarts) and
  reachable by the agent as `window: "selection"` in `trend_query`, with
  tags defaulting to the selecting display's pens.
- **Alarm clarity**: limit lines are drawn in the owning trace's color with
  tag-prefixed labels (`PT-455 HIGH 2350`), each tag's labels in their own
  column so they can't overlap; severity is carried by dash pattern (tight
  dash = HIGH-HIGH). Alarm markers sit ON the violated threshold line at
  the crossing time; state changes and notices are top flags.
- **Per-tag colors**: clicking an active tag name unfolds a palette row;
  overrides follow the trace everywhere (line, lane, limits, table, ruler).
  Fences may seed colors via `trends[].color`.
- **Tag semantics from metadata**: binary → stepped + change-point
  compression + state events; power → trapezoidal energy (MWh); limits →
  HIGH/HIHI/LOW excursion detection; rate-of-change notices, suppressed
  inside a tag's own excursion so one disturbance is never double-reported.
- **Data never passes through the LLM.** The fence carries only a
  ~200-byte config; the control fetches samples from `/api/trends/data`
  and re-fetches on every operator interaction. (An early iteration
  embedded data in the fence; a 7B local model needed an hour to copy it
  and corrupted the JSON. Config-only is the fix.)
- **Agent integration** (`skills/plant-trends`): `trend_query` validates
  tags/time, returns the config fence plus a server-computed analysis
  (overall NORMAL/ATTENTION/ALARM + findings) the agent uses to interpret.
- **CSV export** of exactly what is displayed.

## Files (in the patch)

| Path | Role |
|---|---|
| `src/trends/historian.ts` | Data layer: 54-tag categorized catalog, CSV loading, windowing, min-max downsampling, per-series analysis, region-selection store (persisted to `~/.samsinn/trend-selection.json`). `loadHistory()` is the single storage swap point — a real DB (Bun's built-in Postgres client, or mssql) replaces its body and nothing downstream changes. |
| `src/api/routes/trends.ts` | `GET /api/trends/tags`, `GET /api/trends/data` (window \| from/to \| points), `POST/GET /api/trends/selection`. |
| `src/api/http-routes.ts` | +2 lines: route registration. |
| `src/ui/modules/trend/index.ts` | The front-end trend control (self-registers a post-render processor for `code.language-trend`, same pattern as mermaid/map). |
| `src/ui/modules/render/render-message.ts` | +1 line: module import. |
| `skills/plant-trends/SKILL.md` | Agent skill: tag catalog by category, phrasing hints, time modes incl. `window: "selection"`. |
| `skills/plant-trends/tools/trend_query.ts` | Bundled tool (config fence + analysis). |

Not in the patch: the demo historian CSV (`skills/plant-trends/data/` is
gitignored and ~2 MB). Generate it instead — see below.

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
plants a coherent 48 h storyline across all systems: an RCS excursion ~6 h
before data end (TAVG/PT-455 limit crossings, subcooling dip, a brief PORV
lift, air-ejector radiation rise, post-event boration), surveillance runs
(DG-A, turbine-driven AFW pump, SI pump), and a load-follow power ramp.
Per-tag sampling rates vary realistically (30 s for fast channels down to
5 min for tank levels); binaries record change-of-state plus a heartbeat.

## Fence config format

```json
{ "title": "optional",
  "trends": [ { "tag": "PT-455", "color": "#dc2626" } ],
  "time": { "window": "8h" } }
```

`time` is one of `{window: 15m|30m|1h|4h|8h|24h|48h|1w}` (or
`{window: "selection"}` for the operator's selected region),
`{from, to}` (ISO datetimes), or `{points: N}` (last N raw samples, ≤240,
exact — no downsampling). `color` is optional per trend. Legacy fences with
embedded `series[].points` still render via a local provider.

## Notes for review

- Relative windows anchor to the **latest data timestamp**, not wall
  clock — right for a static demo CSV; with a live DB they coincide.
- The region selection is single-slot, latest-wins, persisted to one file
  (single-operator assumption); a multi-tenant deployment would key it per
  instance.
- The tool's usage text says the display fence "is delivered to the room
  automatically" — in the fork that is done by a small generic eval-layer
  mechanism (tool results may carry `data.attachment`, appended to the
  agent's message when not included verbatim; `src/agents/evaluation.ts`,
  commit `a08c4ed`, with tests). It is deliberately NOT part of this patch
  to keep the scope to the trend feature. Without it, either rely on the
  model pasting `report` (capable cloud models do this reliably) or adjust
  the usage text to instruct pasting verbatim.
- Known omissions vs a full HMI trend object model: multiple stacked trend
  windows (binary lanes cover the common case), named/saved view configs,
  and live-scrolling online mode (meaningful once a live DB is behind it).
- The UI file is ~900 lines; the deliberate constraints were: no external
  chart lib, loud failures (unparseable fence keeps raw source visible
  with a warning), and every operator interaction = a fresh archive query
  rather than client-side slicing.
