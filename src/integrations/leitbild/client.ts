// ============================================================================
// Leitbild client — talks to a Leitbild deployment via its discovery manifest.
//
// One factory per process. Module-level pool keyed by baseUrl so multiple
// rooms (or, in V2, multiple agents) sharing the same deployment share
// one underlying WS connection per Control Instance.
//
// Walks the manifest's `links` to resolve every endpoint. Never hardcodes
// /api/... paths. Required link rels are validated on first manifest fetch;
// missing rels = loud failure (the deployment is too old to mirror).
//
// Always sends Leitbild-Client header. Always encodeURIComponent's {id}
// substitutions. Caches the manifest per Cache-Control max-age + ETag.
//
// V1 scope: read-only. No commands, no lifecycle actions, no clock control.
// ============================================================================

import type {
  ControlInstanceSnapshot,
  LeitbildEvent,
  LeitbildEventHandler,
  LeitbildManifestSummary,
  ScenarioSummary,
  SubscriptionHandle,
} from './types.ts'
import { REQUIRED_LINK_RELS } from './types.ts'

// === Client identity ===

const CLIENT_NAME = 'samsinn'
const CLIENT_VERSION = '0.1.0' // pinned to the integration's own version
const CLIENT_HEADER = `${CLIENT_NAME}; version="${CLIENT_VERSION}"`

// === URI template expansion (RFC 6570 subset) ===
// We only need {id} (path) and {?afterSeq} (query). Tiny inline impl.

const expandTemplate = (template: string, vars: Record<string, string | number | undefined>): string => {
  return template.replace(/\{([?]?)(\w+)\}/g, (_match, prefix, name) => {
    const value = vars[name]
    if (value === undefined || value === null || value === '') return ''
    const encoded = encodeURIComponent(String(value))
    return prefix === '?' ? `?${name}=${encoded}` : encoded
  })
}

// === Manifest cache entry ===

interface ManifestCacheEntry {
  readonly manifest: LeitbildManifestSummary
  readonly etag: string | null
  readonly expiresAtMs: number
}

// === Per-instance subscription pool ===

interface SubscriberRecord {
  readonly handler: LeitbildEventHandler
  lastSeq: number
}

interface InstanceSubscription {
  ws: WebSocket | null
  readonly subscribers: Set<SubscriberRecord>
  lastSeq: number
  readonly url: string
  reconnectDelayMs: number
  closed: boolean
  reconnectTimer?: ReturnType<typeof setTimeout>
}

// === Client interface ===

export interface LeitbildClient {
  readonly getManifest: () => Promise<LeitbildManifestSummary>
  readonly getSnapshot: (instanceId: string) => Promise<ControlInstanceSnapshot>
  readonly getScenario: (scenarioId: string) => Promise<ScenarioSummary | undefined>
  readonly getEvents: (instanceId: string, afterSeq: number) => Promise<ReadonlyArray<LeitbildEvent>>
  readonly subscribe: (instanceId: string, onEvent: LeitbildEventHandler, startSeq: number) => SubscriptionHandle
  readonly baseUrl: string
}

// === Module-level pool ===

const clientPool = new Map<string, LeitbildClient>()

const normalizeBaseUrl = (raw: string): string => {
  const u = new URL(raw)
  u.search = ''
  u.hash = ''
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`
}

// === Factory ===

export const createLeitbildClient = (baseUrlRaw: string): LeitbildClient => {
  const baseUrl = normalizeBaseUrl(baseUrlRaw)
  const cached = clientPool.get(baseUrl)
  if (cached) return cached

  let manifestCache: ManifestCacheEntry | null = null
  const instanceSubs = new Map<string, InstanceSubscription>()

  const defaultHeaders = (): Record<string, string> => ({
    'Leitbild-Client': CLIENT_HEADER,
    Accept: 'application/json',
  })

  const fetchManifest = async (): Promise<LeitbildManifestSummary> => {
    const now = Date.now()
    if (manifestCache && manifestCache.expiresAtMs > now) return manifestCache.manifest

    const headers: Record<string, string> = defaultHeaders()
    if (manifestCache?.etag) headers['If-None-Match'] = manifestCache.etag

    const url = `${baseUrl}/.well-known/leitbild`
    const res = await fetch(url, { headers })

    if (res.status === 304 && manifestCache) {
      // Extend TTL using new Cache-Control.
      const ttl = parseMaxAgeMs(res.headers.get('Cache-Control')) ?? 60_000
      manifestCache = { ...manifestCache, expiresAtMs: Date.now() + ttl }
      return manifestCache.manifest
    }
    if (!res.ok) throw new Error(`Leitbild discovery manifest fetch failed: ${res.status} ${res.statusText}`)

    const body = (await res.json()) as LeitbildManifestSummary
    validateManifest(body)

    const ttl = parseMaxAgeMs(res.headers.get('Cache-Control')) ?? 60_000
    manifestCache = { manifest: body, etag: res.headers.get('ETag'), expiresAtMs: Date.now() + ttl }
    return body
  }

  const resolveLink = async (rel: string, vars: Record<string, string | number | undefined> = {}): Promise<string> => {
    const manifest = await fetchManifest()
    const link = manifest.links[rel]
    if (!link) throw new Error(`Leitbild manifest missing required link rel: ${rel}`)
    const template = link.hrefTemplate ?? link.href
    if (!template) throw new Error(`Leitbild manifest link "${rel}" has neither href nor hrefTemplate`)
    return expandTemplate(template, vars)
  }

  const getSnapshot = async (instanceId: string): Promise<ControlInstanceSnapshot> => {
    const url = await resolveLink('controlInstanceSnapshot', { id: instanceId })
    const res = await fetch(url, { headers: defaultHeaders() })
    if (!res.ok) throw new Error(`Leitbild snapshot fetch failed for ${instanceId}: ${res.status}`)
    const raw = (await res.json()) as Record<string, unknown>
    // Leitbild wraps the snapshot under a `snapshot` key alongside `id`.
    // Tolerant of both shapes: nested under .snapshot, or top-level.
    const body = (raw.snapshot && typeof raw.snapshot === 'object'
      ? raw.snapshot
      : raw) as ControlInstanceSnapshot & { scenario?: { scenarioId?: string } }
    const seq = (body as { seq?: number; snapshotSeq?: number }).seq
      ?? (body as { snapshotSeq?: number }).snapshotSeq ?? 0
    // Surface scenarioId either at top level or nested under .scenario.
    const scenarioId = body.scenarioId ?? body.scenario?.scenarioId
    return { ...body, seq, ...(scenarioId ? { scenarioId } : {}) }
  }

  const getScenario = async (scenarioId: string): Promise<ScenarioSummary | undefined> => {
    const url = await resolveLink('scenarios')
    const res = await fetch(url, { headers: defaultHeaders() })
    if (!res.ok) return undefined
    const body = (await res.json()) as { scenarios?: ReadonlyArray<ScenarioSummary> }
    return body.scenarios?.find(s => s.id === scenarioId)
  }

  const getEvents = async (instanceId: string, afterSeq: number): Promise<ReadonlyArray<LeitbildEvent>> => {
    const url = await resolveLink('controlInstanceEvents', { id: instanceId, afterSeq })
    const res = await fetch(url, { headers: defaultHeaders() })
    if (!res.ok) throw new Error(`Leitbild events fetch failed for ${instanceId}: ${res.status}`)
    const body = (await res.json()) as { events?: ReadonlyArray<LeitbildEvent> } | ReadonlyArray<LeitbildEvent>
    if (Array.isArray(body)) return body
    return (body as { events?: ReadonlyArray<LeitbildEvent> }).events ?? []
  }

  // --- WS subscription management ---

  const openWs = async (instanceId: string, sub: InstanceSubscription): Promise<void> => {
    const url = await resolveLink('realtime', { id: instanceId })
    // Bun's WebSocket constructor accepts (url, protocols?, options?). Headers
    // on WS are awkward across runtimes; Leitbild-Client carried via query
    // is also planned-but-not-enforced. For V1 we skip header for WS and
    // rely on the URL identifying the client by connection.
    const ws = new WebSocket(url)
    sub.ws = ws

    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
        if (msg.type === 'realtime.ready') {
          // No subscriber-affecting action — mirror service handles
          // race-safe attach by buffering until snapshot is fetched.
          return
        }
        if (msg.type === 'events' && Array.isArray(msg.events)) {
          for (const event of msg.events as LeitbildEvent[]) {
            if (typeof event.seq !== 'number') continue
            // Detect epoch boundary (Leitbild's reset wipes the journal
            // and restarts seq from 0; the new epoch isn't a duplicate
            // of the old one). Reset internal dedup state so the new
            // events pass through; subscribers handle re-anchoring.
            if (event.seq < sub.lastSeq && sub.lastSeq > 0) {
              sub.lastSeq = 0
              for (const r of sub.subscribers) r.lastSeq = 0
            }
            if (event.seq <= sub.lastSeq) continue
            sub.lastSeq = event.seq
            for (const record of sub.subscribers) {
              if (event.seq > record.lastSeq) {
                record.lastSeq = event.seq
                try { record.handler(event) } catch { /* subscriber error: don't kill the feed */ }
              }
            }
          }
        }
      } catch { /* malformed message: drop silently */ }
    })

    ws.addEventListener('close', () => { scheduleReconnect(instanceId, sub) })
    ws.addEventListener('error', () => { try { ws.close() } catch { /* */ } })
  }

  const scheduleReconnect = (instanceId: string, sub: InstanceSubscription): void => {
    if (sub.closed) return
    if (sub.subscribers.size === 0) return
    const delay = sub.reconnectDelayMs
    sub.reconnectDelayMs = Math.min(sub.reconnectDelayMs * 2, 30_000)
    sub.reconnectTimer = setTimeout(async () => {
      try {
        const missed = await getEvents(instanceId, sub.lastSeq)
        for (const event of missed) {
          if (event.seq <= sub.lastSeq) continue
          sub.lastSeq = event.seq
          for (const record of sub.subscribers) {
            if (event.seq > record.lastSeq) {
              record.lastSeq = event.seq
              try { record.handler(event) } catch { /* */ }
            }
          }
        }
        await openWs(instanceId, sub)
        sub.reconnectDelayMs = 1_000 // reset on success
      } catch {
        scheduleReconnect(instanceId, sub) // retry chain
      }
    }, delay)
  }

  const subscribe = (instanceId: string, onEvent: LeitbildEventHandler, startSeq: number): SubscriptionHandle => {
    let sub = instanceSubs.get(instanceId)
    if (!sub) {
      sub = {
        ws: null,
        subscribers: new Set(),
        lastSeq: startSeq,
        url: '',
        reconnectDelayMs: 1_000,
        closed: false,
      }
      instanceSubs.set(instanceId, sub)
      void openWs(instanceId, sub)
    }
    const record: SubscriberRecord = { handler: onEvent, lastSeq: startSeq }
    sub.subscribers.add(record)
    return {
      close: () => {
        const s = instanceSubs.get(instanceId)
        if (!s) return
        s.subscribers.delete(record)
        if (s.subscribers.size === 0) {
          s.closed = true
          if (s.reconnectTimer) clearTimeout(s.reconnectTimer)
          try { s.ws?.close() } catch { /* */ }
          instanceSubs.delete(instanceId)
        }
      },
      lastSeq: () => record.lastSeq,
    }
  }

  const client: LeitbildClient = {
    getManifest: fetchManifest,
    getSnapshot,
    getScenario,
    getEvents,
    subscribe,
    baseUrl,
  }
  clientPool.set(baseUrl, client)
  return client
}

// === Internal helpers ===

const validateManifest = (m: LeitbildManifestSummary): void => {
  if (!m.manifestSchemaVersion?.startsWith('1.')) {
    throw new Error(`Unsupported Leitbild manifestSchemaVersion: ${m.manifestSchemaVersion}`)
  }
  if (!m.links) throw new Error('Leitbild manifest missing links block')
  const missing: string[] = []
  for (const rel of REQUIRED_LINK_RELS) {
    if (!m.links[rel]) missing.push(rel)
  }
  if (missing.length > 0) {
    throw new Error(`Leitbild manifest missing required link rels: ${missing.join(', ')}`)
  }
}

const parseMaxAgeMs = (cacheControl: string | null): number | null => {
  if (!cacheControl) return null
  const match = cacheControl.match(/max-age=(\d+)/)
  if (!match) return null
  return Number(match[1]) * 1_000
}

// === Test/diagnostic helper ===

export const __resetClientPool = (): void => {
  for (const client of clientPool.values()) {
    // No close() on LeitbildClient itself; subs auto-close when count==0.
    void client
  }
  clientPool.clear()
}
