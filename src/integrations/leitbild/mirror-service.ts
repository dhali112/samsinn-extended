// ============================================================================
// Leitbild mirror service — room-scoped subscription lifecycle.
//
// One MirrorService per Samsinn process. Tracks active mirrors per room.
// Lifecycle hooks:
//   - attach(room, config)   — fetch snapshot, subscribe to WS, absorb routine
//                              events quietly, post only reset/errors
//   - detach(room)           — close subscription
//   - restoreAll(house)      — boot-time reattach for rooms with persisted config
//   - shutdown()             — close every subscription (process exit)
//
// Race-safe attach (per Codex's Leitbild-side guidance):
//   1. Open WS, capture readySeq from realtime.ready
//   2. Buffer subsequent events (do not deliver yet)
//   3. Fetch snapshot
//   4. Anchor at snapshot.seq
//   5. Absorb buffered replay quietly, then keep routine live events quiet
//
// Reset-aware: when Leitbild emits a reset-shaped event, the mirror posts
// a clear boundary message and refreshes the snapshot baseline.
// ============================================================================

import type { House } from '../../core/types/room.ts'
import type { Room, LeitbildMirrorConfig } from '../../core/types/room.ts'
import type { LeitbildClient, } from './client.ts'
import { createLeitbildClient } from './client.ts'
import type { LeitbildEvent, SubscriptionHandle } from './types.ts'
import { formatMirrorError, formatResetBoundary } from './formatter.ts'
import { SYSTEM_SENDER_ID } from '../../core/types/constants.ts'
import type { LimitMetrics } from '../../core/limit-metrics.ts'

interface ActiveMirror {
  readonly room: Room
  readonly config: LeitbildMirrorConfig
  readonly client: LeitbildClient
  handle?: SubscriptionHandle
  lastSeq: number
  // Per-object hash of "meaningful" fields (lifecycle, operational, domain,
  // alerts) — excludes spatial/timestamps. Used to suppress object.upserted
  // events that only carry position telemetry. Real state transitions still
  // post. Cleared on detach. Bounded by the active object population.
  readonly objectSignatures: Map<string, string>
  // Race-safe attach buffer (audit Finding 2.1.1). While `bufferedEvents`
  // is non-null, handleEvent appends to it instead of posting. attach()
  // switches to direct mode (sets to null) only AFTER snapshot is fetched
  // AND lastSeq anchored AND banner posted. The drain re-runs each event
  // through handleEvent — events with seq <= snapshot.seq are naturally
  // dropped by the existing forward-only filter.
  bufferedEvents: LeitbildEvent[] | null
}

// Build a stable signature of the parts of an object.upserted event that
// represent meaningful state change (not high-frequency position telemetry).
// Returns null for non-object.upserted events — caller posts those normally.
const meaningfulSignature = (event: LeitbildEvent): { objectId: string; sig: string } | null => {
  if (event.type !== 'object.upserted') return null
  const obj = (event as { object?: { id?: string; lifecycle?: unknown; operational?: unknown; domainData?: unknown; alerts?: unknown } }).object
  if (!obj?.id) return null
  // Stringify the interesting subset; deterministic key order via explicit
  // object literal. Position lives under obj.spatial which we deliberately
  // omit. Timestamps are also excluded (they tick on every update).
  return {
    objectId: obj.id,
    sig: JSON.stringify({
      lifecycle: obj.lifecycle ?? null,
      operational: obj.operational ?? null,
      domain: obj.domainData ?? null,
      alerts: obj.alerts ?? null,
    }),
  }
}

export interface MirrorStatus {
  readonly baseUrl: string
  readonly instanceId: string
  readonly format: 'summary' | 'full'
  readonly lastSeq: number
  readonly connected: boolean
}

export interface MirrorService {
  // `scope` (typically a per-system instance id) keys the underlying
  // LeitbildClient pool so two tenants binding to the same Leitbild
  // deployment get isolated WS connections + manifest caches. Default
  // scope (omitted) shares a global pool — fine for single-tenant.
  readonly attach: (room: Room, config: LeitbildMirrorConfig, scope?: string) => Promise<void>
  readonly detach: (room: Room) => void
  readonly statusFor: (room: Room) => MirrorStatus | undefined
  // restoreAll iterates a house's rooms; scope is the house's owning system.
  readonly restoreAll: (house: House, scope?: string) => Promise<void>
  readonly shutdown: () => void
}

export interface MirrorServiceDeps {
  // Optional: process-global anomaly counter sink. When provided, attach
  // failures bump `leitbildAttachErrors` so /api/system/health surfaces
  // them without journalctl grep. Boot wires this from shared.limitMetrics.
  readonly limitMetrics?: LimitMetrics
}

export const createMirrorService = (deps: MirrorServiceDeps = {}): MirrorService => {
  const active = new Map<string, ActiveMirror>() // roomId → ActiveMirror

  const post = (room: Room, content: string, mirror: ActiveMirror, event?: LeitbildEvent): void => {
    room.post({
      senderId: SYSTEM_SENDER_ID,
      senderName: 'Leitbild',
      content,
      type: 'system',
      cause: {
        kind: 'external-mirror',
        name: `${mirror.config.baseUrl}:${mirror.config.instanceId}:${event?.seq ?? mirror.lastSeq}${event?.id ? `:${event.id}` : ''}`,
      },
    })
  }

  const rememberMeaningfulState = (mirror: ActiveMirror, event: LeitbildEvent): boolean => {
    const meaningful = meaningfulSignature(event)
    if (!meaningful) return true
    const prev = mirror.objectSignatures.get(meaningful.objectId)
    if (prev === meaningful.sig) return false
    mirror.objectSignatures.set(meaningful.objectId, meaningful.sig)
    return true
  }

  const absorbBufferedEvent = (mirror: ActiveMirror, event: LeitbildEvent): void => {
    if (isResetSignal(event, mirror)) {
      void handleEvent(mirror)(event)
      return
    }
    if (typeof event.seq === 'number' && event.seq <= mirror.lastSeq) return
    if (typeof event.seq === 'number') mirror.lastSeq = event.seq
    rememberMeaningfulState(mirror, event)
  }

  // Detect Leitbild Control Instance reset. Two signals:
  //   1. Explicit `controlInstance.reset` event from Leitbild (preferred,
  //      requires Leitbild V1.1+ — see leitbild docs/discovery.md).
  //   2. Seq regression (event.seq < mirror.lastSeq) — defensive fallback
  //      for older Leitbild deployments where reset wipes the journal and
  //      restarts seq from 0 without emitting an explicit marker.
  // Both trigger the same re-anchor flow: refetch snapshot, post boundary
  // message, reset mirror.lastSeq to the new snapshot's seq.
  const isResetSignal = (event: LeitbildEvent, mirror: ActiveMirror): boolean => {
    if (event.type === 'controlInstance.reset') return true
    if (typeof event.seq === 'number' && event.seq < mirror.lastSeq && mirror.lastSeq > 0) return true
    return false
  }

  const handleEvent = (mirror: ActiveMirror) => async (event: LeitbildEvent): Promise<void> => {
    // Buffer mode (during attach): hold events until snapshot is anchored.
    // Drain happens at the end of attach() with this same handler, so the
    // forward-only filter and reset detection apply consistently to both
    // buffered + live events. See ActiveMirror.bufferedEvents.
    if (mirror.bufferedEvents !== null) {
      mirror.bufferedEvents.push(event)
      return
    }

    if (isResetSignal(event, mirror)) {
      // Re-anchor: refetch snapshot, post boundary message with NEW seq.
      // Note: the post-reset seq may be lower than mirror.lastSeq.
      try {
        const snapshot = await mirror.client.getSnapshot(mirror.config.instanceId)
        mirror.lastSeq = snapshot.seq
        mirror.room.post({
          senderId: SYSTEM_SENDER_ID,
          senderName: 'Leitbild',
          content: formatResetBoundary(snapshot.seq),
          type: 'system',
          cause: {
            kind: 'external-mirror',
            name: `${mirror.config.baseUrl}:${mirror.config.instanceId}:${snapshot.seq}:reset-boundary`,
          },
        })
        return
      } catch (err) {
        post(mirror.room, formatMirrorError(`reset detected but snapshot refresh failed: ${(err as Error).message}`), mirror, event)
        return
      }
    }

    // Forward-only delivery for non-reset events.
    if (typeof event.seq === 'number' && event.seq <= mirror.lastSeq) return
    if (typeof event.seq === 'number') mirror.lastSeq = event.seq

    // Routine mirror events stay out of chat/history. The current Leitbild
    // state is available through lb_* tools and the iframe; chat is reserved
    // for human/agent conversation plus reset/error boundaries.
    rememberMeaningfulState(mirror, event)
  }

  const attach = async (room: Room, config: LeitbildMirrorConfig, scope?: string): Promise<void> => {
    // Detach any prior mirror on this room first — single binding per room.
    detachRoom(room.profile.id)

    // scope keys the LeitbildClient pool so cross-tenant lifecycles stay
    // isolated (audit Finding 2.1.3). Single-tenant / tests pass undefined
    // and share the global pool.
    const client = createLeitbildClient(config.baseUrl, scope ? { scope } : {})
    // bufferedEvents starts as [] so events arriving between subscribe and
    // snapshot-anchor are captured. Switched to null after drain → live mode.
    const mirror: ActiveMirror = {
      room, config, client,
      lastSeq: 0,
      objectSignatures: new Map(),
      bufferedEvents: [],
    }

    // Subscribe IMMEDIATELY so the WS opens in parallel with manifest +
    // snapshot fetch. Events arriving before snapshot is anchored land in
    // mirror.bufferedEvents (see handleEvent's buffer-mode guard). Audit
    // Finding 2.1.1 — closes the documented-but-unimplemented race window.
    // startSeq=0 is intentional: we don't yet know the real anchor; the
    // forward-only filter applied during drain will drop events <= snapshot.seq.
    mirror.handle = client.subscribe(config.instanceId, (event) => { void handleEvent(mirror)(event) }, 0)
    active.set(room.profile.id, mirror)

    try {
      const snapshot = await client.getSnapshot(config.instanceId)
      mirror.lastSeq = snapshot.seq

      // Persist the binding on the room (in case attach was triggered
      // outside the route handler, e.g. by restoreAll).
      room.setLeitbildMirror(config)

      // Drain the buffer. Switch to live mode FIRST (clear bufferedEvents)
      // so events arriving DURING the drain go straight to handleEvent's
      // direct path — otherwise a slow drain could let live events queue
      // behind already-stale buffered ones. Routine replay is absorbed
      // quietly to avoid chat spam on page load/restore; object signatures
      // are still recorded so the next position-only update stays quiet.
      // Reset events buffered during attach pass through normally — if a
      // real reset happened mid-attach, the re-anchor is the correct response.
      const buffered = mirror.bufferedEvents
      mirror.bufferedEvents = null
      if (buffered !== null) {
        for (const event of buffered) {
          absorbBufferedEvent(mirror, event)
        }
      }
    } catch (err) {
      // Setup failed (manifest/snapshot/etc). Tear down the subscription
      // and the active entry to avoid a leaked WS + leaked buffer entry.
      try { mirror.handle?.close() } catch { /* close may throw if WS already terminal; we're tearing down anyway */ }
      active.delete(room.profile.id)
      deps.limitMetrics?.inc('leitbildAttachErrors')
      // Fail loud, leave the room field set so the user knows what they
      // asked for; mirror just isn't running.
      room.post({
        senderId: SYSTEM_SENDER_ID,
        senderName: 'Leitbild',
        content: formatMirrorError((err as Error).message),
        type: 'system',
      })
      throw err
    }
  }

  const detachRoom = (roomId: string): void => {
    const mirror = active.get(roomId)
    if (!mirror) return
    try { mirror.handle?.close() } catch { /* subscription handle.close() may throw if WS already terminal; we're detaching anyway */ }
    active.delete(roomId)
  }

  const detach = (room: Room): void => {
    detachRoom(room.profile.id)
    room.setLeitbildMirror(undefined)
  }

  const statusFor = (room: Room): MirrorStatus | undefined => {
    const mirror = active.get(room.profile.id)
    if (!mirror) {
      const cfg = room.getLeitbildMirror()
      if (!cfg) return undefined
      return { baseUrl: cfg.baseUrl, instanceId: cfg.instanceId, format: cfg.format, lastSeq: 0, connected: false }
    }
    return {
      baseUrl: mirror.config.baseUrl,
      instanceId: mirror.config.instanceId,
      format: mirror.config.format,
      lastSeq: mirror.lastSeq,
      connected: !!mirror.handle,
    }
  }

  const restoreAll = async (house: House, scope?: string): Promise<void> => {
    for (const profile of house.listAllRooms()) {
      const room = house.getRoom(profile.id)
      const cfg = room?.getLeitbildMirror()
      if (room && cfg) {
        try { await attach(room, cfg, scope) }
        catch (err) { console.warn(`[leitbild] restoreAll failed for room "${profile.name}": ${(err as Error).message}`) }
      }
    }
  }

  const shutdown = (): void => {
    for (const id of [...active.keys()]) detachRoom(id)
  }

  return { attach, detach, statusFor, restoreAll, shutdown }
}
