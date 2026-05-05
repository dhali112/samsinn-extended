// ============================================================================
// Wikis panel — read-only list of pack-bundled wikis.
//
// Post-prune (commit M): wikis come exclusively from packs. Add/edit/
// delete affordances are gone — operator manages wiki content by editing
// the pack's repo and reinstalling. The panel just lists what's currently
// loaded plus the per-wiki refresh button (forces a re-warm of pages).
// ============================================================================

import { showToast } from '../toast.ts'
import { icon } from '../icon.ts'

// Kept exported for the existing wikis-panel.test.ts which verifies the
// id format. Same regex the server uses for wiki ids.
export const validateWikiId = (id: string): string | null => {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) && !/^[a-z0-9][a-z0-9-]{0,62}:[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    return 'Lowercase letters, digits, dashes; pack-namespaced ids use `<pack>:<slug>`.'
  }
  return null
}

interface WikiEntry {
  id: string
  displayName: string
  enabled: boolean
  pack: string
  pageCount: number
  lastWarmAt: number | null
  lastError: string | null
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c))

const formatLastWarm = (ts: number | null): string => {
  if (!ts) return 'never'
  const dt = Date.now() - ts
  if (dt < 60_000) return 'just now'
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`
  return `${Math.floor(dt / 86_400_000)}d ago`
}

const fetchWikis = async (): Promise<WikiEntry[]> => {
  try {
    const res = await fetch('/api/wikis')
    if (!res.ok) return []
    const data = await res.json() as { wikis?: WikiEntry[] }
    return data.wikis ?? []
  } catch { return [] }
}

const refreshWiki = async (id: string): Promise<{ ok: boolean; pageCount?: number; error?: string }> => {
  const res = await fetch(`/api/wikis/${encodeURIComponent(id)}/refresh`, { method: 'POST' })
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'refresh failed' })) as { error?: string }
    return { ok: false, error: body.error ?? 'refresh failed' }
  }
  const body = await res.json() as { pageCount: number }
  return { ok: true, pageCount: body.pageCount }
}

export const renderWikisInto = async (container: HTMLElement): Promise<void> => {
  container.innerHTML = '<div class="text-xs text-text-muted px-3 py-2 italic">Loading…</div>'
  const wikis = await fetchWikis()
  container.innerHTML = ''

  const header = document.createElement('div')
  header.className = 'px-3 py-2 text-[11px] uppercase tracking-wide text-text-subtle border-b border-border bg-surface-muted flex items-center justify-between'
  header.innerHTML = `<span>Wikis (${wikis.length})</span><span class="text-[10px] normal-case tracking-normal text-text-muted">all from packs</span>`
  container.appendChild(header)

  if (wikis.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'text-xs text-text-muted px-3 py-3 italic'
    empty.textContent = 'No wikis available. Install a pack with wikis from Settings → Packs.'
    container.appendChild(empty)
    return
  }

  for (const w of wikis) {
    const row = document.createElement('div')
    row.className = 'px-3 py-2 text-xs hover:bg-surface-muted flex items-center gap-2 border-b border-border'
    const status = w.lastError
      ? `<span class="text-warning">⚠ ${escapeHtml(w.lastError)}</span>`
      : `<span class="text-text-muted">${w.pageCount} pages · warmed ${formatLastWarm(w.lastWarmAt)}</span>`
    row.innerHTML = `
      <div class="flex-1 min-w-0">
        <div class="text-text-strong font-medium truncate">${escapeHtml(w.displayName)}</div>
        <div class="text-text-muted truncate text-[10px]">id: <code>${escapeHtml(w.id)}</code> · pack: <code>${escapeHtml(w.pack)}</code></div>
        <div class="text-[10px]">${status}</div>
      </div>
    `
    const refreshBtn = document.createElement('button')
    refreshBtn.className = 'text-text-subtle hover:text-text px-2 py-1'
    refreshBtn.title = 'Refresh — re-walk the pack dir and re-cache pages'
    refreshBtn.appendChild(icon('refresh-cw', { size: 14 }))
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true
      const result = await refreshWiki(w.id)
      refreshBtn.disabled = false
      if (result.ok) {
        showToast(document.body, `${w.id}: ${result.pageCount} pages`, { type: 'success', position: 'fixed' })
      } else {
        showToast(document.body, `${w.id}: ${result.error}`, { type: 'error', position: 'fixed' })
      }
    })
    row.appendChild(refreshBtn)
    container.appendChild(row)
  }
}
