// ============================================================================
// Leitbild mirror service — room-scoped subscription lifecycle.
//
// One MirrorService per Samsinn process. Tracks active mirrors per room.
// Lifecycle hooks:
//   - attach(room, config)   — fetch manifest+snapshot+scenario, post overview
//                              banner, subscribe to WS, format and post events
//   - detach(room)           — close subscription
//   - restoreAll(house)      — boot-time reattach for rooms with persisted config
//   - shutdown()             — close every subscription (process exit)
//
// Race-safe attach (per Codex's Leitbild-side guidance):
//   1. Open WS, capture readySeq from realtime.ready
//   2. Buffer subsequent events (do not deliver yet)
//   3. Fetch snapshot
//   4. Post overview banner anchored at snapshot.seq
//   5. Deliver buffered/live events with seq > snapshot.seq
//
// Reset-aware: when Leitbild emits a reset-shaped event, the mirror posts
// a clear boundary message and refreshes the snapshot baseline.
// ============================================================================

import type { House } from '../../core/types/room.ts'
import type { Room, LeitbildMirrorConfig } from '../../core/types/room.ts'
import type { LeitbildClient, } from './client.ts'
import { createLeitbildClient } from './client.ts'
import type { LeitbildEvent, SubscriptionHandle } from './types.ts'
import { formatBanner, formatEvent, formatMirrorError, formatResetBoundary } from './formatter.ts'
import { SYSTEM_SENDER_ID } from '../../core/types/constants.ts'

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
  readonly attach: (room: Room, config: LeitbildMirrorConfig) => Promise<void>
  readonly detach: (room: Room) => void
  readonly statusFor: (room: Room) => MirrorStatus | undefined
  readonly restoreAll: (house: House) => Promise<void>
  readonly shutdown: () => void
}

export const createMirrorService = (): MirrorService => {
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

    // Suppress position-only object.upserted events: only post when the
    // meaningful signature (lifecycle, operational status, domain payload,
    // alerts) changes. Filters the firehose of ambulance position updates
    // while preserving real state transitions (new incidents, status
    // changes, capacity changes). Other event types (command.issued,
    // command.result, scenario.* events, etc.) always post.
    const meaningful = meaningfulSignature(event)
    if (meaningful) {
      const prev = mirror.objectSignatures.get(meaningful.objectId)
      if (prev === meaningful.sig) return  // same meaningful state — skip
      mirror.objectSignatures.set(meaningful.objectId, meaningful.sig)
    }

    post(mirror.room, formatEvent(event, mirror.config.format), mirror, event)
  }

  const attach = async (room: Room, config: LeitbildMirrorConfig): Promise<void> => {
    // Detach any prior mirror on this room first — single binding per room.
    detachRoom(room.profile.id)

    const client = createLeitbildClient(config.baseUrl)
    const mirror: ActiveMirror = { room, config, client, lastSeq: 0, objectSignatures: new Map() }

    try {
      const manifest = await client.getManifest()
      const snapshot = await client.getSnapshot(config.instanceId)
      mirror.lastSeq = snapshot.seq

      const scenarioId = snapshot.scenarioId
      const scenario = scenarioId ? await client.getScenario(scenarioId) : undefined
      const objects = (snapshot.objects as ReadonlyArray<unknown> | undefined)?.length

      // Persist the binding on the room (in case attach was triggered
      // outside the route handler, e.g. by restoreAll).
      room.setLeitbildMirror(config)

      room.post({
        senderId: SYSTEM_SENDER_ID,
        senderName: 'Leitbild',
        content: formatBanner({
          baseUrl: config.baseUrl,
          instanceId: config.instanceId,
          scenarioTitle: scenario?.title,
          scenarioDescription: scenario?.description,
          objectCount: objects,
          operator: manifest.identity?.operator,
          authPosture: 'open',
          clockPaused: snapshot.clock?.paused,
          clockSpeed: snapshot.clock?.speed,
          clockCurrentTime: snapshot.clock?.currentTime,
          snapshotSeq: snapshot.seq,
        }),
        type: 'system',
        cause: {
          kind: 'external-mirror',
          name: `${config.baseUrl}:${config.instanceId}:${snapshot.seq}:banner`,
        },
      })

      mirror.handle = client.subscribe(config.instanceId, (event) => { void handleEvent(mirror)(event) }, snapshot.seq)
      active.set(room.profile.id, mirror)
    } catch (err) {
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

  const restoreAll = async (house: House): Promise<void> => {
    for (const profile of house.listAllRooms()) {
      const room = house.getRoom(profile.id)
      const cfg = room?.getLeitbildMirror()
      if (room && cfg) {
        try { await attach(room, cfg) }
        catch (err) { console.warn(`[leitbild] restoreAll failed for room "${profile.name}": ${(err as Error).message}`) }
      }
    }
  }

  const shutdown = (): void => {
    for (const id of [...active.keys()]) detachRoom(id)
  }

  return { attach, detach, statusFor, restoreAll, shutdown }
}
