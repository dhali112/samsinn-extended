// trend_query — configure a front-end trend display + get its analysis.
//
// ARCHITECTURE: the trend control is a front-end object. Data NEVER passes
// through the LLM — the fence this tool returns is a small config (pens +
// time axis); the browser control fetches actual samples itself from
// /api/trends/data. The analysis returned here is computed server-side by
// src/trends/historian.ts (which also backs the API), so the agent's
// interpretation and the operator's display read from the same source.

import { queryTrends, TREND_TAGS, MAX_POINTS, getSelectedRegion } from '../../../src/trends/historian.ts'

const tool = {
  name: 'trend_query',
  description: 'Historical trend display for plant process tags (like WinCC OnlineTrendControl). Configures a front-end trend control (the browser fetches the data itself) and returns a server-computed analysis with alarms and anomalies.',
  usage: 'Pick tags matching what the operator asked about (see skill for the tag catalog) and ONE time-axis mode: from/to for an absolute range, points for the last N samples, or window for a relative duration (default 8h). Post the returned `report` verbatim (it is small), then interpret using `analysis.lines` and `analysis.overall`.',
  returns: 'Object with `report` (a small ```trend config fence, ready to post) and `analysis` { overall: NORMAL|ATTENTION|ALARM, lines: string[], series: per-tag stats }.',
  parameters: {
    type: 'object',
    properties: {
      tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to plot, e.g. ["RCS_TEMP_C","RCS_PRESS_BAR"]' },
      window: { type: 'string', description: 'Relative window back from latest data: 15m, 30m, 1h, 4h, 8h, 24h, 48h, 1w (default 8h)' },
      from: { type: 'string', description: 'Absolute range start (ISO datetime, e.g. 2026-07-14T06:00). Overrides window/points.' },
      to: { type: 'string', description: 'Absolute range end (ISO datetime). Defaults to latest data when only from is given.' },
      points: { type: 'number', description: `Plot exactly the last N samples per tag (10–${MAX_POINTS}). Overrides window.` },
      useSelectedRegion: { type: 'boolean', description: 'Use the region the operator selected on a trend display (Region mode drag). Use when the operator says "the window shown", "the selected region", "this region". Tags default to the pens of that display if omitted.' },
    },
    required: [],
  },
  execute: async (params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    let tags = Array.isArray(params.tags) ? params.tags.map(String) : []
    let from = typeof params.from === 'string' || typeof params.from === 'number' ? params.from : undefined
    let to = typeof params.to === 'string' || typeof params.to === 'number' ? params.to : undefined

    let regionContext: string | null = null
    if (params.useSelectedRegion === true) {
      const sel = getSelectedRegion()
      if (!sel) {
        return { success: false, error: 'No region is currently selected on a trend display. Ask the operator to switch the display to Region mode and drag across the span of interest first.' }
      }
      from = sel.from
      to = sel.to
      if (tags.length === 0) tags = [...sel.tags]
      regionContext = `This is the region the operator selected on the PLANT TREND display (tags: ${sel.tags.join(', ')}). Answer only about these plant process tags in this time span — the selection has nothing to do with weather, maps, or Leitbild scenarios.`
    }
    if (tags.length === 0) {
      return { success: false, error: `No tags given. Available: ${Object.keys(TREND_TAGS).join(', ')}` }
    }

    const result = await queryTrends({
      tags,
      window: typeof params.window === 'string' ? params.window : undefined,
      from,
      to,
      points: typeof params.points === 'number' ? params.points : undefined,
    })
    if ('error' in result) return { success: false, error: result.error }

    // Config-only fence (spec §10): pens + time axis. The front-end control
    // resolves this against /api/trends/data on render and on every operator
    // interaction (add pens, change window, etc.).
    const time: Record<string, unknown> = {}
    if (from !== undefined || to !== undefined) {
      time.from = new Date(result.from * 1000).toISOString()
      time.to = new Date(result.to * 1000).toISOString()
    } else if (typeof params.points === 'number') {
      time.points = Math.round(params.points)
    } else {
      time.window = typeof params.window === 'string' ? params.window : '8h'
    }
    const config = {
      title: `Plant trend — ${tags.join(', ')} (${result.modeLabel})`,
      trends: tags.map(tag => ({ tag })),
      time,
    }

    return {
      success: true,
      data: {
        report: '```trend\n' + JSON.stringify(config) + '\n```',
        analysis: result.analysis,
        window: result.modeLabel,
        availableTags: Object.keys(TREND_TAGS),
        ...(regionContext ? { regionContext } : {}),
      },
    }
  },
}

export default tool
