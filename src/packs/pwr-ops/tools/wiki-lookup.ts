// wiki_lookup — fetch a non-procedure page from the samsinn-wikis pwr-ops
// wiki (system descriptions, tag/setpoint catalogues, tech-spec extracts,
// lineups). Companion to procedure_lookup.
//
// The manifest's `pages` array drives discovery; if the wiki publishes a
// v1 manifest without `pages`, this tool reports "no reference pages
// available — try procedure_lookup".

import type { Tool, ToolResult } from '../../../core/types/tool.ts'
import type { WikiSourceBinding } from '../../types.ts'
import {
  createWikiSource,
  type WikiSource,
  type WikiManifestPageEntry,
  type WikiPageType,
} from '../../../wikis/wiki-fetcher.ts'

interface WikiLookupDeps {
  readonly source: WikiSource
  readonly wikiName: string
  readonly wikiHomepage: string
  readonly telemetry?: (event: WikiLookupTelemetry) => void
}

export interface WikiLookupTelemetry {
  readonly tool: 'wiki_lookup'
  readonly ts: string
  readonly callerId: string
  readonly callerName: string
  readonly type: string | null
  readonly id: string | null
  readonly success: boolean
  readonly durationMs: number
  readonly errorClass?: 'no-manifest' | 'no-pages' | 'unknown-type' | 'unknown-id' | 'fetch-failed'
}

const defaultTelemetry = (event: WikiLookupTelemetry): void => {
  try { console.error('wiki_lookup_telemetry ' + JSON.stringify(event)) } catch { /* never crash */ }
}

const ALL_TYPES: ReadonlyArray<WikiPageType> = [
  'system-description',
  'tag-catalogue',
  'setpoint-catalogue',
  'tech-spec',
  'lineup',
]

const isValidType = (t: string): t is WikiPageType => (ALL_TYPES as ReadonlyArray<string>).includes(t)

const citationForPage = (binding: WikiSourceBinding, page: WikiManifestPageEntry): string => {
  // page.file looks like `wiki/systems/rcs.md` — strip leading `wiki/` and
  // the trailing `.md`, then resolve against the citationBase's parent.
  const base = new URL(binding.citationBase)
  const stripped = page.file.replace(/^wiki\//, '').replace(/\.md$/, '')
  // citationBase ends in `/procedures/` — we want the site root.
  const siteRoot = base.pathname.replace(/procedures\/?$/, '')
  return `${base.origin}${siteRoot}${stripped}/`
}

const renderPageList = (pages: ReadonlyArray<WikiManifestPageEntry>, wikiName: string, wikiHomepage: string): string => {
  const byType = new Map<WikiPageType, WikiManifestPageEntry[]>()
  for (const p of pages) {
    const arr = byType.get(p.type) ?? []
    arr.push(p)
    byType.set(p.type, arr)
  }
  const lines: string[] = []
  lines.push(`# ${wikiName} — reference pages`)
  lines.push('')
  lines.push(`Source: ${wikiHomepage}`)
  lines.push('')
  for (const type of ALL_TYPES) {
    const arr = byType.get(type)
    if (!arr || arr.length === 0) continue
    lines.push(`## ${type} (${arr.length})`)
    for (const p of arr) lines.push(`  - \`${p.id}\`${p.title ? ' — ' + p.title : ''}`)
    lines.push('')
  }
  lines.push(`Call \`wiki_lookup({ type, id })\` to fetch a page. Tip: try \`type: "system-description"\` + \`id: "rcs"\` for the reactor coolant system overview.`)
  return lines.join('\n')
}

const buildTool = (deps: WikiLookupDeps): Tool => ({
  name: 'wiki_lookup',
  description:
    'Fetches a reference page from the pwr-ops wiki — system descriptions, the tag catalogue, the setpoint catalogue, tech-spec extracts, or lineups. ' +
    'Use this when you need plant-reference context that is not procedure-specific. ' +
    'Call with no arguments to list available pages by type.',
  usage:
    'Pass `type` (one of: system-description, tag-catalogue, setpoint-catalogue, tech-spec, lineup) and `id` (e.g. "rcs", "eccs", "index"). ' +
    'Omit both to list everything. Markdown body is returned verbatim and is paste-ready.',
  returns: 'A markdown string (the page body with frontmatter stripped) or an index listing.',
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: [...ALL_TYPES],
        description: 'Page type. Omit to list everything available.',
      },
      id: {
        type: 'string',
        description: 'Page id (e.g. "rcs" for system-description, "index" for the catalogue pages). Required when `type` is set.',
      },
    },
    additionalProperties: false,
  },
  execute: async (params, context): Promise<ToolResult> => {
    const t0 = Date.now()
    const type = typeof params.type === 'string' ? params.type.trim() : ''
    const id = typeof params.id === 'string' ? params.id.trim() : ''
    const emit = deps.telemetry ?? defaultTelemetry
    const fire = (success: boolean, errorClass?: WikiLookupTelemetry['errorClass']): void => {
      emit({
        tool: 'wiki_lookup',
        ts: new Date().toISOString(),
        callerId: context.callerId,
        callerName: context.callerName,
        type: type || null,
        id: id || null,
        success,
        durationMs: Date.now() - t0,
        ...(errorClass ? { errorClass } : {}),
      })
    }

    const manifest = await deps.source.fetchManifest()
    if (!manifest) {
      fire(false, 'no-manifest')
      return { success: false, error: `${deps.wikiName} manifest is unavailable. Try again in a minute, or use procedure_lookup for procedures.` }
    }
    const pages = manifest.pages ?? []
    if (pages.length === 0) {
      fire(false, 'no-pages')
      return { success: false, error: `${deps.wikiName} has no reference pages in its manifest. Use procedure_lookup for procedures.` }
    }

    if (!type && !id) {
      fire(true)
      return { success: true, data: renderPageList(pages, deps.wikiName, deps.wikiHomepage) }
    }

    if (type && !isValidType(type)) {
      fire(false, 'unknown-type')
      return { success: false, error: `Unknown page type "${type}". Available: ${ALL_TYPES.join(', ')}.` }
    }

    if (type && !id) {
      const filtered = pages.filter(p => p.type === type)
      if (filtered.length === 0) {
        fire(false, 'unknown-type')
        return { success: false, error: `No pages of type "${type}" in ${deps.wikiName}.` }
      }
      fire(true)
      return { success: true, data: renderPageList(filtered, deps.wikiName, deps.wikiHomepage) }
    }

    const match = type
      ? pages.find(p => p.type === type && p.id === id)
      : pages.find(p => p.id === id)
    if (!match) {
      const sameType = type ? pages.filter(p => p.type === type) : pages
      const sample = sameType.slice(0, 8).map(p => p.id).join(', ')
      fire(false, 'unknown-id')
      return { success: false, error: `Page "${id}"${type ? ` (type ${type})` : ''} not found. Available: ${sample}${sameType.length > 8 ? ', ...' : ''}.` }
    }

    let body: string
    try {
      body = await deps.source.fetchPage(match.file)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      fire(false, 'fetch-failed')
      return { success: false, error: `Could not fetch ${match.file}: ${msg}. Try again in a minute.` }
    }
    // Strip frontmatter for paste-ready output; agent doesn't need the YAML header.
    const stripped = body.replace(/^---\n[\s\S]*?\n---\n/, '')
    const citation = citationForPage(deps.source.binding, match)
    fire(true)
    return {
      success: true,
      data: `${stripped.trim()}\n\n---\nSource: [${match.title ?? match.id}](${citation})`,
    }
  },
})

export const createWikiLookupTool = (
  binding: WikiSourceBinding,
  wikiName: string,
  wikiHomepage: string,
  telemetry?: (event: WikiLookupTelemetry) => void,
): Tool => buildTool({
  source: createWikiSource(binding),
  wikiName,
  wikiHomepage,
  ...(telemetry ? { telemetry } : {}),
})
