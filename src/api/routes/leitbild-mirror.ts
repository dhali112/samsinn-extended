// ============================================================================
// Routes for the Leitbild mirror binding on a Samsinn room.
//
// V1: read-only mirror — bind a room to a Leitbild Control Instance.
// Three endpoints:
//   PUT    /api/rooms/:name/leitbild-mirror   set/replace config + attach
//   DELETE /api/rooms/:name/leitbild-mirror   clear + detach
//   GET    /api/rooms/:name/leitbild-mirror   introspect current state
// ============================================================================

import { errorResponse, json, parseBody } from './helpers.ts'
import type { RouteEntry } from './types.ts'
import type { LeitbildMirrorConfig } from '../../core/types/room.ts'

const parseMirrorConfig = (body: Record<string, unknown>): LeitbildMirrorConfig | { error: string } => {
  if (typeof body.baseUrl !== 'string' || body.baseUrl.trim() === '') return { error: 'baseUrl is required' }
  if (typeof body.instanceId !== 'string' || body.instanceId.trim() === '') return { error: 'instanceId is required' }
  const format = body.format ?? 'summary'
  if (format !== 'summary' && format !== 'full') return { error: 'format must be "summary" or "full"' }
  try { new URL(body.baseUrl) } catch { return { error: 'baseUrl must be a valid URL' } }
  return { baseUrl: body.baseUrl, instanceId: body.instanceId, format }
}

// Server-side proxy for creating Leitbild Control Instances from the
// Samsinn UI without hitting CORS. The Leitbild deployment doesn't
// publish CORS headers (manifest declares browserDirectAccess: false),
// so browser-origin fetches against leitbild.samsinn.app fail. The demo
// modal needs to spin up a fresh CI on demand; this route does it
// server-to-server (no CORS) and returns the new instance id.
//
// SSRF guard: the route is auth-gated (cookie required via http-routes.ts
// F5), but the baseUrl is user-controlled — without further restriction an
// authenticated client could probe arbitrary hosts including internal
// networks. We enforce TWO checks:
//   1. Host must appear in the allowlist (default: leitbild.samsinn.app;
//      override via SAMSINN_LEITBILD_HOSTS=host1.example.com,host2.example.com)
//   2. Host must NOT resolve to a private/loopback/link-local range
//      (denied unconditionally — separate from the host check because an
//      attacker could host a public DNS record pointing at 127.0.0.1)
const DEFAULT_LEITBILD_HOSTS = ['leitbild.samsinn.app']

const getAllowedLeitbildHosts = (): ReadonlySet<string> => {
  const raw = process.env.SAMSINN_LEITBILD_HOSTS
  if (!raw || raw.trim() === '') return new Set(DEFAULT_LEITBILD_HOSTS)
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
}

const isPrivateOrLoopbackHost = (host: string): boolean => {
  // Hostname-shaped tests first (don't fail on names).
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  // IPv4 dotted-quad: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16,
  // 169.254.0.0/16 (link-local), 100.64.0.0/10 (CGNAT).
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) {
    const a = Number(ipv4[1]); const b = Number(ipv4[2])
    if (a === 127 || a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 0) return true
  }
  // IPv6 loopback / link-local / unique-local. Coarse.
  if (host === '::1' || host === '[::1]') return true
  if (host.startsWith('fe80:') || host.startsWith('[fe80:')) return true
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('[fc') || host.startsWith('[fd')) return true
  return false
}

const validateProxyBaseUrl = (raw: string): { ok: true; url: URL } | { ok: false; error: string } => {
  let url: URL
  try { url = new URL(raw) } catch { return { ok: false, error: 'baseUrl must be a valid URL' } }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'baseUrl protocol must be http or https' }
  }
  const allowed = getAllowedLeitbildHosts()
  if (!allowed.has(url.hostname)) {
    return { ok: false, error: `baseUrl host "${url.hostname}" is not in the Leitbild allowlist (configure via SAMSINN_LEITBILD_HOSTS)` }
  }
  if (isPrivateOrLoopbackHost(url.hostname)) {
    return { ok: false, error: 'baseUrl resolves to a private/loopback address' }
  }
  return { ok: true, url }
}

const proxyCreateControlInstance: RouteEntry = {
  method: 'POST',
  pattern: /^\/api\/leitbild-proxy\/control-instances$/,
  handler: async (req) => {
    const body = await parseBody(req)
    if (typeof body.baseUrl !== 'string') return errorResponse('baseUrl is required', 400)
    if (typeof body.scenarioId !== 'string') return errorResponse('scenarioId is required', 400)
    const guarded = validateProxyBaseUrl(body.baseUrl)
    if (!guarded.ok) return errorResponse(guarded.error, 400)
    try {
      const res = await fetch(`${guarded.url.toString().replace(/\/$/, '')}/api/control-instances`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Leitbild-Client': 'samsinn-ui; version="0.1.0"' },
        body: JSON.stringify({ scenarioId: body.scenarioId }),
      })
      if (!res.ok) return errorResponse(`Leitbild returned HTTP ${res.status}`, 502)
      const data = await res.json() as { id?: string }
      return json({ id: data.id })
    } catch (err) {
      return errorResponse(`Could not reach Leitbild: ${(err as Error).message}`, 502)
    }
  },
}

export const leitbildMirrorRoutes: RouteEntry[] = [
  proxyCreateControlInstance,
  {
    method: 'GET',
    pattern: /^\/api\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: async (_req, match, { system, leitbildMirror }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      // Lazy self-heal: if room has persisted config but service has no
      // record (Samsinn was restarted), reattach silently. Idempotent —
      // attach() detaches any prior mirror first.
      const persisted = room.getLeitbildMirror()
      const status = leitbildMirror?.statusFor(room)
      if (persisted && leitbildMirror && (!status || !status.connected)) {
        try { await leitbildMirror.attach(room, persisted) } catch {
          // attach() catches its own error and posts a formatMirrorError chat
          // message into the room — the user sees the failure inline. We
          // don't re-throw because this is a lazy self-heal; the GET still
          // returns the current status with connected:false. If attach()
          // ever throws BEFORE its own room.post (e.g. snapshot fetch throws
          // synchronously), the user gets no signal — flagged in audit
          // Finding 2.2.4 for a follow-up that surfaces lastAttachError.
        }
      }
      return json({ status: leitbildMirror?.statusFor(room) ?? null })
    },
  },
  {
    method: 'PUT',
    pattern: /^\/api\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: async (req, match, { system, leitbildMirror }) => {
      if (!leitbildMirror) return errorResponse('Leitbild integration not initialized', 503)
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      const body = await parseBody(req)
      const parsed = parseMirrorConfig(body)
      if ('error' in parsed) return errorResponse(parsed.error, 400)
      try {
        await leitbildMirror.attach(room, parsed)
        return json({ status: leitbildMirror.statusFor(room) ?? null }, 200)
      } catch (err) {
        return errorResponse(`attach failed: ${(err as Error).message}`, 502)
      }
    },
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/rooms\/([^/]+)\/leitbild-mirror$/,
    handler: (_req, match, { system, leitbildMirror }) => {
      const name = decodeURIComponent(match[1]!)
      const room = system.house.getRoom(name)
      if (!room) return errorResponse(`Room "${name}" not found`, 404)
      leitbildMirror?.detach(room)
      return json({ status: null })
    },
  },
]
