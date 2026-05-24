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

  const isResetEvent = (event: LeitbildEvent): boolean => {
    // Leitbild's reset emits a runtime-initiated state change. We match
    // any event whose type contains "reset" — defensive against exact
    // event-type-name changes upstream.
    return typeof event.type === 'string' && /reset/i.test(event.type)
  }

  const handleEvent = (mirror: ActiveMirror) => async (event: LeitbildEvent): Promise<void> => {
    if (event.seq <= mirror.lastSeq) return
    mirror.lastSeq = event.seq

    if (isResetEvent(event)) {
      // Re-anchor: refetch snapshot, post boundary message with NEW seq.
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

    post(mirror.room, formatEvent(event, mirror.config.format), mirror, event)
  }

  const attach = async (room: Room, config: LeitbildMirrorConfig): Promise<void> => {
    // Detach any prior mirror on this room first — single binding per room.
    detachRoom(room.profile.id)

    const client = createLeitbildClient(config.baseUrl)
    const mirror: ActiveMirror = { room, config, client, lastSeq: 0 }

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
    try { mirror.handle?.close() } catch { /* */ }
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
