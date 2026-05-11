// Themed confirm dialog — replaces native confirm() across the UI.
//
// Why: native confirm() is browser-blockable (Firefox/Zen's "Prevent this
// page from creating additional dialogs" checkbox turns every later
// confirm() into a silent `false`), can't be styled to match the rest of
// the UI, and is mobile-hostile. confirmModal() is a Promise<boolean>
// wrapper around createModal that fixes all three.
//
// Defaults are tuned for the destructive case (11 of 12 call sites are
// delete/uninstall/stop/clear/purge):
//   - variant defaults to 'danger' (red Confirm button)
//   - Confirm button focused on open
//   - Enter resolves true, Escape resolves false, backdrop click resolves false
//
// Stacking + re-entrancy:
//   - Overlay sits at z-index 60 so it stacks above any parent modal
//     (createModal sets z:50). Escape uses capture-phase +
//     stopImmediatePropagation so it doesn't close the parent.
//   - Module-level `pending` ensures double-click doesn't open two modals;
//     the second call returns the same Promise as the first.
//
// Focus restoration:
//   - The element focused at open-time is captured and refocused on close.
//     Without this, focus would land on document.body after the modal
//     unmounted — bad for keyboard-only users and confusing on screen
//     readers.

import { createModal, createButton } from './detail-modal.ts'

export interface ConfirmOptions {
  readonly title: string
  readonly body: string
  readonly confirmLabel: string                          // verb: 'Delete', 'Uninstall', etc.
  readonly variant?: 'danger' | 'normal'                 // default 'danger'
}

let pending: Promise<boolean> | null = null

export const confirmModal = (opts: ConfirmOptions): Promise<boolean> => {
  // Re-entrancy: second call while a modal is open returns the same
  // Promise. Matches the existing UX of confirm() (one dialog at a time).
  if (pending) return pending

  const variant = opts.variant ?? 'danger'

  pending = new Promise<boolean>((resolve) => {
    const modal = createModal({ title: opts.title, width: 'max-w-md' })
    modal.overlay.style.zIndex = '60'
    modal.card.setAttribute('role', 'alertdialog')

    // Body — short copy describing what's about to happen.
    const bodyP = document.createElement('p')
    bodyP.className = 'text-sm text-text'
    bodyP.textContent = opts.body
    modal.scrollBody.appendChild(bodyP)

    let settled = false
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      modal.overlay.removeEventListener('keydown', onKey, true)
      modal.close()
      pending = null
      // Refocus the trigger so keyboard users land back where they were.
      // try/catch because the previous element may have been detached
      // (e.g. a list row that re-rendered while the modal was open).
      try { previousFocus?.focus() } catch { /* ignore */ }
      resolve(value)
    }

    const cancelBtn = createButton({
      variant: 'ghost',
      label: 'Cancel',
      onClick: () => settle(false),
    })
    const confirmBtn = createButton({
      variant: variant === 'danger' ? 'danger' : 'primary',
      label: opts.confirmLabel,
      onClick: () => settle(true),
    })

    const btnRow = document.createElement('div')
    btnRow.className = 'flex justify-end gap-2'
    btnRow.appendChild(cancelBtn)
    btnRow.appendChild(confirmBtn)
    modal.footer.appendChild(btnRow)

    // Enter = confirm, Escape = cancel. Capture phase + stopImmediatePropagation
    // so the parent modal's Escape listener (also registered by createModal)
    // doesn't fire as well. Without this, Escape on a confirmModal that's
    // stacked over a parent modal would close BOTH.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        settle(false)
      } else if (e.key === 'Enter') {
        e.stopImmediatePropagation()
        settle(true)
      }
    }
    modal.overlay.addEventListener('keydown', onKey, { capture: true })

    // Override createModal's default backdrop-close (which doesn't resolve
    // our Promise) so backdrop click resolves false instead of leaking
    // the Promise.
    modal.overlay.onclick = (e) => { if (e.target === modal.overlay) settle(false) }

    document.body.appendChild(modal.overlay)
    // Defer focus to the next paint so the button is mounted and visible.
    requestAnimationFrame(() => {
      try { confirmBtn.focus() } catch { /* node detached */ }
    })
  })

  return pending
}
