// Settings > Wikis modal — read-only list of pack-bundled wikis.
//
// Post-prune (commit M): wikis come exclusively from packs. Add / edit /
// delete / discovery-refresh affordances are gone. The modal is a thin
// shell around renderWikisInto; install/uninstall happens via the
// Settings → Packs flow, which re-fires the WS `packs_changed` event
// that this modal listens for.

import { createModal } from '../modals/detail-modal.ts'
import { renderWikisInto } from '../panels/wikis-panel.ts'

export const openWikisModal = async (): Promise<void> => {
  const modal = createModal({ title: 'Wikis', width: 'max-w-2xl' })
  document.body.appendChild(modal.overlay)

  const listEl = document.createElement('div')
  listEl.className = '-mx-6 -my-4'
  modal.scrollBody.appendChild(listEl)

  await renderWikisInto(listEl)

  // Wikis change as a side effect of pack install / uninstall — listen on
  // packs_changed (the only remaining wiki-affecting WS event post-prune).
  const listener = (): void => { if (listEl.isConnected) void renderWikisInto(listEl) }
  window.addEventListener('packs-changed', listener)
  const removalObserver = new MutationObserver(() => {
    if (!modal.overlay.isConnected) {
      window.removeEventListener('packs-changed', listener)
      removalObserver.disconnect()
    }
  })
  removalObserver.observe(document.body, { childList: true })
}
