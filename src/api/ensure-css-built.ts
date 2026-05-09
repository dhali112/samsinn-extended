// ============================================================================
// CSS bootstrap — build src/ui/dist.css if missing OR stale before the HTTP
// server starts serving. Lives here (not in scripts/dev.ts) so every launch
// path (bun run start, bun --watch, preview tool, prod systemd, fresh
// checkout) gets a built CSS regardless of how the server was started.
//
// Staleness: dist.css is stale iff any Tailwind-scannable source file under
// src/ui is newer. We walk recursively rather than parsing @source patterns
// in input.css — broader by design so the check survives @source additions.
// ============================================================================

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface EnsureCssOptions {
  // Path to the UI tree (typically derived from import.meta or process.cwd).
  readonly uiPath: string
  // Override the CLI invocation. Tests can stub; production uses the default.
  readonly buildCommand?: ReadonlyArray<string>
}

const DEFAULT_BUILD_COMMAND: ReadonlyArray<string> = [
  'bunx', '@tailwindcss/cli',
  '-i', 'src/ui/input.css',
  '-o', 'src/ui/dist.css',
  '--minify',
]

// File extensions that can contain Tailwind utility classes. Walking with
// this filter covers every @source directive samsinn currently uses (and
// any reasonable future addition under src/ui).
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.html', '.css'])

// dist.css itself is excluded — it's the OUTPUT, including its mtime in
// the max would create a feedback loop where every fresh build immediately
// looks "up to date with itself" only because of itself.
const DIST_CSS_FILENAME = 'dist.css'

// Recursive walk under uiPath; returns max mtime of every file matching
// SCANNED_EXTENSIONS, excluding dist.css. Returns 0 if nothing matched.
const maxScannedMtime = async (uiPath: string): Promise<number> => {
  let maxMs = 0
  const walk = async (dir: string): Promise<void> => {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) }
    catch { return }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        // Skip node_modules and hidden dirs — neither contains Tailwind sources.
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (entry.name === DIST_CSS_FILENAME) continue
      const dot = entry.name.lastIndexOf('.')
      if (dot < 0) continue
      const ext = entry.name.slice(dot)
      if (!SCANNED_EXTENSIONS.has(ext)) continue
      try {
        const st = await stat(full)
        if (st.mtimeMs > maxMs) maxMs = st.mtimeMs
      } catch { /* file vanished mid-walk — fine */ }
    }
  }
  await walk(uiPath)
  return maxMs
}

// Returns true iff a build was performed (whether successful or not).
export const ensureCssBuilt = async (opts: EnsureCssOptions): Promise<boolean> => {
  const distPath = `${opts.uiPath}/${DIST_CSS_FILENAME}`

  let needBuild = false
  let reason = ''
  let distMtime = 0
  try {
    const st = await stat(distPath)
    distMtime = st.mtimeMs
  } catch {
    needBuild = true
    reason = 'dist.css missing'
  }

  if (!needBuild) {
    const sourceMtime = await maxScannedMtime(opts.uiPath)
    if (sourceMtime > distMtime) {
      needBuild = true
      reason = 'a Tailwind-scanned source file is newer than dist.css'
    }
  }

  if (!needBuild) return false

  console.log(`[css] ${reason} — running one-shot tailwind build...`)
  const cmd = opts.buildCommand ?? DEFAULT_BUILD_COMMAND
  const child = Bun.spawn([...cmd], {
    stdout: 'inherit',
    stderr: 'inherit',
    env: process.env,
  })
  const code = await child.exited
  if (code !== 0) {
    console.error(`[css] ⚠  tailwind build failed (exit ${code}). The page will show the runtime "CSS build missing" banner until the issue is fixed.`)
  } else {
    console.log('[css] dist.css built.')
  }
  return true
}
