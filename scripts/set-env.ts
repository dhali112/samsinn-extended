// ============================================================================
// set-env — interactive helper to update a single variable in the prod
// /etc/samsinn/env file and restart the samsinn service.
//
// Usage:
//   bun run set-env                       # prompts for variable name + value
//   bun run set-env OPENAI_API_KEY        # prompts for value (hidden input)
//
// Mechanics:
//   1. ssh's to the prod host (HETZNER_HOST env, default 178.104.229.113)
//   2. reads /etc/samsinn/env, updates one key, writes it back via stdin
//   3. systemctl restart samsinn
//   4. verifies the service came back active
//
// Secret-hygiene:
//   - Value is read with raw-mode tty (not echoed, not in shell history)
//   - Value passes to remote via ssh stdin (not as command-line argument,
//     so it doesn't appear in remote ps listings)
//   - Value is never logged
// ============================================================================

import { $ } from 'bun'

const HOST = process.env.HETZNER_HOST ?? '178.104.229.113'
const USER = process.env.HETZNER_USER ?? 'root'
const PORT = process.env.HETZNER_PORT ?? '22'
const ENV_PATH = '/etc/samsinn/env'
const target = `${USER}@${HOST}`

const promptVisible = async (question: string): Promise<string> => {
  process.stdout.write(question)
  for await (const line of console) return line.toString().trim()
  return ''
}

const promptHidden = (question: string): Promise<string> =>
  new Promise((resolve, reject) => {
    process.stdout.write(question)
    const stdin = process.stdin
    if (!stdin.isTTY) {
      reject(new Error('Hidden input requires a TTY (no piped input)'))
      return
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let buf = ''
    const onData = (chunk: string | Buffer): void => {
      const c = chunk.toString()
      for (const ch of c) {
        if (ch === '') {  // Ctrl-C
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          reject(new Error('Cancelled'))
          return
        }
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(buf)
          return
        }
        if (ch === '' || ch === '\b') {
          if (buf.length > 0) buf = buf.slice(0, -1)
          continue
        }
        buf += ch
      }
    }
    stdin.on('data', onData)
  })

const args = process.argv.slice(2)
let keyName = args[0]
if (!keyName) {
  keyName = await promptVisible('Variable name (e.g. OPENAI_API_KEY): ')
}
if (!keyName) {
  console.error('[set-env] no variable name; exiting.')
  process.exit(1)
}
if (!/^[A-Z_][A-Z0-9_]*$/.test(keyName)) {
  console.error(`[set-env] invalid variable name: ${keyName} (expect SHOUTY_SNAKE_CASE).`)
  process.exit(1)
}

const value = await promptHidden('New value (hidden — paste, then Enter): ')
if (!value) {
  console.error('[set-env] empty value; exiting.')
  process.exit(1)
}

console.log(`[set-env] connecting to ${target}…`)

let currentEnv = ''
try {
  currentEnv = await $`ssh -p ${PORT} ${target} cat ${ENV_PATH}`.text()
} catch (err) {
  console.error(`[set-env] failed to read ${ENV_PATH}: ${(err as Error).message}`)
  process.exit(1)
}

const lines = currentEnv.split('\n')
let found = false
const updated = lines.map(line => {
  if (line.startsWith(`${keyName}=`)) {
    found = true
    return `${keyName}=${value}`
  }
  return line
})
if (!found) {
  // Append; tolerate trailing-newline absence/presence
  while (updated.length > 0 && updated[updated.length - 1] === '') updated.pop()
  updated.push(`${keyName}=${value}`, '')
}
const newEnv = updated.join('\n')

console.log(`[set-env] ${ENV_PATH}: ${keyName} ${found ? 'updated' : 'added'}`)

// Write back via stdin so the value never appears as a command-line argument.
{
  const proc = Bun.spawn(['ssh', '-p', PORT, target, `cat > ${ENV_PATH}`], {
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  proc.stdin.write(newEnv)
  await proc.stdin.end()
  const code = await proc.exited
  if (code !== 0) {
    console.error(`[set-env] write failed (ssh exit ${code})`)
    process.exit(1)
  }
}

console.log('[set-env] restarting samsinn service…')
try {
  await $`ssh -p ${PORT} ${target} systemctl restart samsinn`
} catch (err) {
  console.error(`[set-env] restart failed: ${(err as Error).message}`)
  process.exit(1)
}

console.log('[set-env] verifying…')
await new Promise(r => setTimeout(r, 2000))
try {
  const status = (await $`ssh -p ${PORT} ${target} systemctl is-active samsinn`.text()).trim()
  if (status === 'active') {
    console.log('[set-env] ✓ samsinn active; new env applied')
  } else {
    console.error(`[set-env] ⚠ samsinn status after restart: ${status}`)
    process.exit(1)
  }
} catch (err) {
  console.error(`[set-env] verify failed: ${(err as Error).message}`)
  process.exit(1)
}
