// ============================================================================
// Script store — filesystem-backed loader (v3, markdown-native).
//
// Layout:
//   $SAMSINN_HOME/scripts/<name>/script.md      ← preferred
//   $SAMSINN_HOME/scripts/<name>.md             ← flat-form (single file)
//
// The on-disk format is markdown (see docs/scripts.md). Each .md file is
// parsed into a Script via parseScriptMd. The same shape drives runtime
// state and the living-document view.
// ============================================================================

import { readdir, readFile, stat, writeFile, mkdir, rm, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Script } from '../types/script.ts'
import { parseScriptMd, VALID_NAME } from './script-md-parser.ts'

// Hard cap on script source size. Scripts are markdown — the largest realistic
// hand-written one is a few KB. 256 KB is well above that and small enough
// that an agent can't DoS the parser/UI by writing a multi-MB file via
// write_script. Counted in UTF-16 code units (string.length); close enough
// for the purpose.
export const MAX_SCRIPT_SOURCE_BYTES = 256 * 1024

export interface ScriptStore {
  readonly get: (name: string) => Script | undefined
  readonly list: () => ReadonlyArray<Script>
  readonly reload: () => Promise<ReadonlyArray<string>>
  readonly upsert: (name: string, source: string) => Promise<Script>
  readonly remove: (name: string) => Promise<boolean>
  readonly onChange: (fn: () => void) => () => void
}

export const createScriptStore = (baseDir: string): ScriptStore => {
  const scripts = new Map<string, Script>()
  const listeners = new Set<() => void>()

  const fireChange = (): void => {
    for (const fn of listeners) {
      try { fn() } catch { /* listener errors must not break the store */ }
    }
  }

  const reload = async (): Promise<ReadonlyArray<string>> => {
    scripts.clear()
    const loaded = await scanScriptDir(baseDir)
    for (const s of loaded) scripts.set(s.name, s)
    fireChange()
    return loaded.map(s => s.name)
  }

  const upsert = async (name: string, source: string): Promise<Script> => {
    if (!VALID_NAME.test(name)) {
      throw new Error(`script name must match ${VALID_NAME} (got "${name}")`)
    }
    if (source.length > MAX_SCRIPT_SOURCE_BYTES) {
      throw new Error(`script source too large: ${source.length} bytes (max ${MAX_SCRIPT_SOURCE_BYTES})`)
    }
    parseScriptMd(name, source)   // validate before write
    const dir = join(baseDir, name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'script.md'), source, 'utf-8')
    await reload()
    const reloaded = scripts.get(name)
    if (!reloaded) throw new Error(`upsert: script "${name}" did not reload`)
    return reloaded
  }

  const remove = async (name: string): Promise<boolean> => {
    if (!VALID_NAME.test(name)) return false
    const dir = join(baseDir, name)
    const flat = join(baseDir, `${name}.md`)
    let removed = false
    try { await rm(dir, { recursive: true, force: true }); removed = true } catch { /* may not exist */ }
    try { await rm(flat, { force: true }); removed = removed || true } catch { /* may not exist */ }
    if (removed) await reload()
    return scripts.get(name) === undefined && removed
  }

  const onChange = (fn: () => void): (() => void) => {
    listeners.add(fn)
    return () => { listeners.delete(fn) }
  }

  return {
    get: (name) => scripts.get(name),
    list: () => [...scripts.values()],
    reload,
    upsert,
    remove,
    onChange,
  }
}

// === Filesystem scan ===

const scanScriptDir = async (baseDir: string): Promise<ReadonlyArray<Script>> => {
  let entries: string[]
  try {
    entries = await readdir(baseDir)
  } catch {
    return []
  }

  const out: Script[] = []
  for (const entry of entries) {
    const full = join(baseDir, entry)
    let info
    try { info = await stat(full) } catch { continue }

    let name: string
    let raw: string
    if (info.isDirectory()) {
      if (!VALID_NAME.test(entry)) {
        console.warn(`[scripts] "${entry}": directory name not a valid script name — skipping`)
        continue
      }
      try {
        raw = await readFile(join(full, 'script.md'), 'utf-8')
      } catch {
        continue
      }
      name = entry
    } else if (info.isFile() && entry.endsWith('.md')) {
      const stem = entry.slice(0, -'.md'.length)
      if (!VALID_NAME.test(stem)) {
        console.warn(`[scripts] "${entry}": filename not a valid script name — skipping`)
        continue
      }
      try {
        raw = await readFile(full, 'utf-8')
      } catch (err) {
        console.warn(`[scripts] "${entry}": read failed — ${err instanceof Error ? err.message : err}`)
        continue
      }
      name = stem
    } else {
      continue
    }

    try {
      const parsed = parseScriptMd(name, raw)
      out.push(parsed)
    } catch (err) {
      console.warn(`[scripts] "${name}": invalid — ${err instanceof Error ? err.message : err}`)
    }
  }

  console.log(`[scripts] ${baseDir}: ${out.length} loaded`)
  return out
}

// === Seed-on-startup: copy bundled example scripts into the user's scripts
// directory if no copy already exists. Idempotent — never overwrites a
// user-edited file. Each example is parsed before copy so we never seed a
// broken file. Called once per process from bootstrap. ===
export const seedExampleScripts = async (
  examplesDir: string,
  scriptsDir: string,
): Promise<{ readonly seeded: ReadonlyArray<string>; readonly skipped: ReadonlyArray<string> }> => {
  let entries: string[]
  try {
    entries = await readdir(examplesDir)
  } catch {
    return { seeded: [], skipped: [] }
  }

  await mkdir(scriptsDir, { recursive: true })
  const seeded: string[] = []
  const skipped: string[] = []

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const stem = entry.slice(0, -'.md'.length)
    if (!VALID_NAME.test(stem)) continue
    const src = join(examplesDir, entry)
    const dstFlat = join(scriptsDir, entry)
    const dstDir = join(scriptsDir, stem, 'script.md')

    // Already present in either layout — leave it alone.
    let exists = false
    try { await stat(dstFlat); exists = true } catch { /* not present */ }
    if (!exists) { try { await stat(dstDir); exists = true } catch { /* not present */ } }
    if (exists) { skipped.push(stem); continue }

    // Validate the example before copying so we never seed a broken file.
    try {
      const raw = await readFile(src, 'utf-8')
      parseScriptMd(stem, raw)
    } catch (err) {
      console.warn(`[scripts] example "${entry}": skipped — ${err instanceof Error ? err.message : err}`)
      continue
    }

    try {
      await copyFile(src, dstFlat)
      seeded.push(stem)
    } catch (err) {
      console.warn(`[scripts] example "${entry}": copy failed — ${err instanceof Error ? err.message : err}`)
    }
  }
  return { seeded, skipped }
}
