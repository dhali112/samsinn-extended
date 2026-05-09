import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, stat, utimes, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureCssBuilt } from './ensure-css-built.ts'

// Stub build command — writes a marker file so the test can verify the
// helper actually invoked it. Real tailwind isn't shelled out from a unit
// test (slow + would need network for the bunx download in CI).
const STUB_OUTPUT = '/* stub build */'
const stubCommand = (uiPath: string, marker: string): ReadonlyArray<string> => [
  'bash', '-c',
  `printf '%s' '${STUB_OUTPUT}' > '${uiPath}/dist.css' && touch '${marker}'`,
]

describe('ensureCssBuilt', () => {
  let uiPath: string
  let markerPath: string

  beforeEach(async () => {
    uiPath = await mkdtemp(join(tmpdir(), 'samsinn-css-'))
    markerPath = `${uiPath}/built.marker`
    await writeFile(`${uiPath}/input.css`, '/* input */')
  })

  afterEach(async () => {
    await rm(uiPath, { recursive: true, force: true })
  })

  test('builds when dist.css is missing', async () => {
    const built = await ensureCssBuilt({
      uiPath,
      buildCommand: stubCommand(uiPath, markerPath),
    })
    expect(built).toBe(true)
    await expect(stat(markerPath)).resolves.toBeDefined()
    const dist = await Bun.file(`${uiPath}/dist.css`).text()
    expect(dist).toBe(STUB_OUTPUT)
  })

  test('skips when dist.css is fresh (newer than input.css)', async () => {
    await writeFile(`${uiPath}/dist.css`, '/* existing */')
    // Bump dist.css mtime past input.css so isStale returns false.
    const future = new Date(Date.now() + 60_000)
    await utimes(`${uiPath}/dist.css`, future, future)
    const built = await ensureCssBuilt({
      uiPath,
      buildCommand: stubCommand(uiPath, markerPath),
    })
    expect(built).toBe(false)
    // Marker must not exist — build was skipped.
    await expect(stat(markerPath)).rejects.toThrow()
  })

  test('rebuilds when dist.css is stale (older than input.css)', async () => {
    await writeFile(`${uiPath}/dist.css`, '/* stale */')
    // Bump input.css mtime so isStale returns true.
    const future = new Date(Date.now() + 60_000)
    await utimes(`${uiPath}/input.css`, future, future)
    const built = await ensureCssBuilt({
      uiPath,
      buildCommand: stubCommand(uiPath, markerPath),
    })
    expect(built).toBe(true)
    await expect(stat(markerPath)).resolves.toBeDefined()
    const dist = await Bun.file(`${uiPath}/dist.css`).text()
    expect(dist).toBe(STUB_OUTPUT)
  })

  test('does not throw when build command fails', async () => {
    const built = await ensureCssBuilt({
      uiPath,
      buildCommand: ['bash', '-c', 'exit 1'],
    })
    // Build was attempted (returns true) even though exit code was non-zero —
    // the runtime banner takes over from there.
    expect(built).toBe(true)
  })

  test('rebuilds when ANY .ts file under modules/ is newer than dist.css', async () => {
    // The original staleness check missed this case: a fresh class added
    // to a .ts file made dist.css functionally stale even though input.css
    // had not changed. This regression test pins the broader scan.
    await writeFile(`${uiPath}/dist.css`, '/* stale */')
    await mkdir(`${uiPath}/modules/foo`, { recursive: true })
    await writeFile(`${uiPath}/modules/foo/bar.ts`, '/* new module with new tailwind classes */')
    const future = new Date(Date.now() + 60_000)
    await utimes(`${uiPath}/modules/foo/bar.ts`, future, future)
    const built = await ensureCssBuilt({
      uiPath,
      buildCommand: stubCommand(uiPath, markerPath),
    })
    expect(built).toBe(true)
    await expect(stat(markerPath)).resolves.toBeDefined()
  })

  test('rebuilds when .html is newer than dist.css', async () => {
    await writeFile(`${uiPath}/dist.css`, '/* stale */')
    await writeFile(`${uiPath}/index.html`, '<html><body>new class="bg-foo"</body></html>')
    const future = new Date(Date.now() + 60_000)
    await utimes(`${uiPath}/index.html`, future, future)
    const built = await ensureCssBuilt({
      uiPath,
      buildCommand: stubCommand(uiPath, markerPath),
    })
    expect(built).toBe(true)
  })

  test('skips dist.css\'s OWN mtime in the staleness check (no feedback loop)', async () => {
    // dist.css is the OUTPUT — including it in the source-mtime max would
    // make every fresh build look "as up-to-date as itself" and never
    // detect new changes elsewhere. This test would fail if dist.css were
    // not excluded from the walk.
    await writeFile(`${uiPath}/dist.css`, '/* fresh */')
    const future = new Date(Date.now() + 60_000)
    await utimes(`${uiPath}/dist.css`, future, future)
    // Source files all OLDER than dist.css — no rebuild expected.
    const built = await ensureCssBuilt({
      uiPath,
      buildCommand: stubCommand(uiPath, markerPath),
    })
    expect(built).toBe(false)
  })

  test('ignores files in node_modules and hidden dirs', async () => {
    await writeFile(`${uiPath}/dist.css`, '/* fresh */')
    const future = new Date(Date.now() + 60_000)
    await utimes(`${uiPath}/dist.css`, future, future)
    await mkdir(`${uiPath}/node_modules/foo`, { recursive: true })
    await writeFile(`${uiPath}/node_modules/foo/bad.ts`, '/* should not trigger rebuild */')
    await mkdir(`${uiPath}/.cache`, { recursive: true })
    await writeFile(`${uiPath}/.cache/bad.ts`, '/* should not trigger rebuild */')
    const veryFuture = new Date(Date.now() + 120_000)
    await utimes(`${uiPath}/node_modules/foo/bad.ts`, veryFuture, veryFuture)
    await utimes(`${uiPath}/.cache/bad.ts`, veryFuture, veryFuture)
    const built = await ensureCssBuilt({
      uiPath,
      buildCommand: stubCommand(uiPath, markerPath),
    })
    expect(built).toBe(false)
  })
})
