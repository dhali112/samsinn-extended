// Boot-time UI footer wiring — theme toggle + app version + repo link.
// Extracted from app.ts to keep the shell focused on routing and dispatch.
// Self-contained: imports its deps lazily, no closure dependencies on app.ts.

export const wireBootstrapFooter = (): void => {
  void (async () => {
    const { wireThemeToggle, onThemeChange } = await import('./theme.ts')
    wireThemeToggle()
    onThemeChange(async () => {
      try {
        const { reRenderAllMermaid } = await import('./mermaid/index.ts')
        await reRenderAllMermaid()
      } catch { /* mermaid may not be loaded yet */ }
    })
    try {
      const info = await fetch('/api/system/info').then(r => r.ok ? r.json() : null) as { version: string; repoUrl: string } | null
      if (!info) return
      const vEl = document.getElementById('app-version')
      if (vEl) vEl.textContent = `v${info.version}`
      const linkEl = document.getElementById('app-repo-link') as HTMLButtonElement | null
      if (linkEl && info.repoUrl) {
        linkEl.onclick = () => window.open(info.repoUrl, '_blank', 'noopener,noreferrer')
      }
    } catch { /* non-fatal */ }
  })()
}
