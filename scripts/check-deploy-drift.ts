// ============================================================================
// check-deploy-drift — diff prod's hand-edited config against the repo template.
//
// Usage:
//   bun run drift                     # check Caddyfile + systemd unit
//   bun run drift caddy               # just Caddyfile
//   bun run drift systemd             # just systemd unit
//
// Exit codes:
//   0 = no drift (templates match prod modulo known-divergent lines)
//   1 = drift detected (diff printed to stdout)
//   2 = couldn't check (ssh failure, file missing, etc. — stderr explains)
//
// Why this exists:
//   `deploy/Caddyfile` and `deploy/samsinn.service` are TEMPLATES. CLAUDE.md
//   policy says never `cp` over prod — operator hand-edits prod (e.g. adding
//   frame-src for Leitbild iframe). Over time the template drifts and a
//   fresh deploy on a new box would silently lose hand-applied directives.
//   This script makes drift visible without auto-merging.
//
// Known-divergent lines that should NOT be flagged as real drift:
//   - Caddyfile: `samsinn.example.com` placeholder vs actual hostname
//   - systemd: ExecStart path (template `/home/samsinn/.bun/bin/bun` vs
//     whatever the operator chose)
// These get pre-normalized; remaining diff is real.
// ============================================================================

import { $ } from 'bun'

const HOST = process.env.HETZNER_HOST ?? '178.104.229.113'
const USER = process.env.HETZNER_USER ?? 'root'
const PORT = process.env.HETZNER_PORT ?? '22'
const PROD_HOSTNAME = process.env.SAMSINN_PROD_HOSTNAME ?? 'samsinn.app'
const target = `${USER}@${HOST}`

// === Per-file specs ===
//
// Each spec defines:
//   - what to check (label)
//   - remote path (where prod has it)
//   - local template path (in this repo)
//   - normalizers (functions that mangle BOTH sides equally so known-
//     divergent lines don't trigger drift)

interface FileSpec {
  readonly label: string
  readonly remotePath: string
  readonly localPath: string
  readonly normalizers: ReadonlyArray<(s: string) => string>
}

// Normalize Caddyfile hostname so the template's `samsinn.example.com`
// matches prod's actual hostname. Both sides get rewritten to `HOST`.
const normalizeHostname = (s: string): string =>
  s.replace(/\bsamsinn\.example\.com\b/g, 'HOST').replace(new RegExp(`\\b${PROD_HOSTNAME.replace(/\./g, '\\.')}\\b`, 'g'), 'HOST')

// Normalize systemd ExecStart bun-path: any absolute path ending in `/bin/bun` becomes `BUN`.
const normalizeBunPath = (s: string): string =>
  s.replace(/(^|=|\s)\/[\w./-]+\/bin\/bun\b/g, '$1BUN')

// Normalize trailing whitespace + CRLF — common diff noise.
const normalizeLineEndings = (s: string): string =>
  s.replace(/\r\n/g, '\n').split('\n').map(l => l.replace(/\s+$/, '')).join('\n')

const SPECS: ReadonlyArray<FileSpec> = [
  {
    label: 'Caddyfile',
    remotePath: '/etc/caddy/Caddyfile',
    localPath: 'deploy/Caddyfile',
    normalizers: [normalizeLineEndings, normalizeHostname],
  },
  {
    label: 'systemd unit',
    remotePath: '/etc/systemd/system/samsinn.service',
    localPath: 'deploy/samsinn.service',
    normalizers: [normalizeLineEndings, normalizeBunPath],
  },
]

// === Diff helpers ===

interface DiffResult {
  readonly clean: boolean
  readonly diff: string                   // empty if clean
  readonly missingRemote?: boolean
  readonly missingLocal?: boolean
  readonly fetchError?: string
}

const fetchRemote = async (path: string): Promise<{ ok: true; text: string } | { ok: false; missing: boolean; error: string }> => {
  try {
    // `cat` on a missing file produces stderr + non-zero exit; we catch both.
    const text = await $`ssh -p ${PORT} ${target} cat ${path}`.text()
    return { ok: true, text }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Heuristic: "No such file" indicates the file's gone; everything else
    // is an ssh/connectivity error.
    const missing = /no such file/i.test(msg)
    return { ok: false, missing, error: msg }
  }
}

const readLocal = async (path: string): Promise<string | null> => {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  return file.text()
}

// Unified-diff-like output. Doesn't need to match GNU diff exactly — just
// has to be readable. We do line-by-line with - / + markers.
const lineDiff = (left: string, right: string): string => {
  const a = left.split('\n')
  const b = right.split('\n')
  // Naive longest-common-subsequence-free diff: walk both, emit chunks of
  // additions/deletions. Works for small files (Caddyfile + systemd unit
  // are <200 LOC each). For something larger we'd want LCS proper.
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++; j++
      continue
    }
    // Look ahead a few lines on each side to find a re-sync point.
    const LOOKAHEAD = 5
    let resyncA = -1
    let resyncB = -1
    for (let k = 1; k <= LOOKAHEAD; k++) {
      if (i + k < a.length && j < b.length && a[i + k] === b[j]) { resyncA = k; break }
      if (j + k < b.length && i < a.length && a[i] === b[j + k]) { resyncB = k; break }
    }
    if (resyncA > 0) {
      for (let k = 0; k < resyncA; k++) out.push(`- ${a[i + k]}`)
      i += resyncA
    } else if (resyncB > 0) {
      for (let k = 0; k < resyncB; k++) out.push(`+ ${b[j + k]}`)
      j += resyncB
    } else {
      // No re-sync within window: emit one of each and advance.
      if (i < a.length) { out.push(`- ${a[i]}`); i++ }
      if (j < b.length) { out.push(`+ ${b[j]}`); j++ }
    }
  }
  return out.join('\n')
}

const checkOne = async (spec: FileSpec): Promise<DiffResult> => {
  const localRaw = await readLocal(spec.localPath)
  if (localRaw === null) return { clean: false, diff: '', missingLocal: true }

  const remoteResult = await fetchRemote(spec.remotePath)
  if (!remoteResult.ok) {
    if (remoteResult.missing) return { clean: false, diff: '', missingRemote: true }
    return { clean: false, diff: '', fetchError: remoteResult.error }
  }

  const apply = (s: string): string => spec.normalizers.reduce((acc, fn) => fn(acc), s)
  const left = apply(localRaw)
  const right = apply(remoteResult.text)

  if (left === right) return { clean: true, diff: '' }
  return { clean: false, diff: lineDiff(left, right) }
}

// === Main ===

const args = process.argv.slice(2)
const which = args[0]                                  // 'caddy' | 'systemd' | undefined

const filter = which
  ? SPECS.filter(s => s.label.toLowerCase().includes(which.toLowerCase()))
  : SPECS

if (filter.length === 0) {
  console.error(`[drift] no spec matches "${which}" (have: ${SPECS.map(s => s.label).join(', ')})`)
  process.exit(2)
}

console.log(`[drift] checking ${target} (${HOST}:${PORT}) for ${filter.map(s => s.label).join(' + ')}`)
console.log(`[drift] hostname normalized: ${PROD_HOSTNAME} ↔ template's samsinn.example.com`)

let anyDrift = false
let anyError = false

for (const spec of filter) {
  console.log(`\n--- ${spec.label} (${spec.remotePath} ↔ ${spec.localPath}) ---`)
  const result = await checkOne(spec)
  if (result.missingLocal) {
    console.error(`  ✗ local template missing at ${spec.localPath}`)
    anyError = true
    continue
  }
  if (result.missingRemote) {
    console.error(`  ✗ remote file missing at ${spec.remotePath}`)
    anyError = true
    continue
  }
  if (result.fetchError !== undefined) {
    console.error(`  ✗ fetch failed: ${result.fetchError}`)
    anyError = true
    continue
  }
  if (result.clean) {
    console.log('  ✓ no drift (after normalization)')
  } else {
    console.log('  ⚠ DRIFT — prod differs from template:')
    console.log(result.diff.split('\n').map(l => `    ${l}`).join('\n'))
    anyDrift = true
  }
}

console.log('')
if (anyError) {
  console.error('[drift] one or more checks could not complete — see errors above')
  process.exit(2)
}
if (anyDrift) {
  console.log('[drift] drift detected. Decide: update the template (recommended) OR accept the operator hand-edit as transient.')
  console.log('[drift] never `cp` template over /etc/* directly (CLAUDE.md policy: prod is hand-edited; template is the source of intent).')
  process.exit(1)
}
console.log('[drift] ✓ all checks clean')
process.exit(0)
