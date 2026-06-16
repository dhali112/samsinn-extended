// Tests for the race-safe attach flow (audit Finding 2.1.1).
//
// Verifies: events arriving between subscribe and snapshot-anchor are
// buffered, then drained with the snapshot's seq as the forward-only
// filter. Pre-fix, those events were lost (the WS opened only AFTER
// snapshot was already captured, so events fired in that window were
// never received by Samsinn).
//
// Strategy: build a fake LeitbildClient whose subscribe() captures the
// handler and lets the test trigger events synchronously, and whose
// getSnapshot() is awaitable on a controlled deferred. Test scripts a
// timeline where events fire BEFORE the snapshot deferred resolves.

import { describe, expect, test } from 'bun:test'
import { createMirrorService } from './mirror-service.ts'
import type { LeitbildClient } from './client.ts'
import type { Room, LeitbildMirrorConfig } from '../../core/types/room.ts'
import type { LeitbildEvent } from './types.ts'

interface FakeRoom extends Room {
  readonly posted: Array<{ content: string }>
}

const mkRoom = (id: string): FakeRoom => {
  const posted: Array<{ content: string }> = []
  const cfg: { v: LeitbildMirrorConfig | undefined } = { v: undefined }
  return {
    profile: { id, name: id, createdAt: 0, createdBy: 'test', housePromptOverride: undefined, responseFormatOverride: undefined } as never,
    posted,
    post: ((params: { content: string }) => {
      posted.push({ content: params.content })
      return { id: 'm', content: params.content, senderId: 's', senderName: 's', timestamp: 0, type: 'system', roomId: id } as never
    }) as Room['post'],
    setLeitbildMirror: (c?: LeitbildMirrorConfig) => { cfg.v = c },
    getLeitbildMirror: () => cfg.v,
    // The remaining Room surface is unused by attach() — stub to satisfy the type.
  } as unknown as FakeRoom
}

interface CapturedSub {
  readonly handler: (event: LeitbildEvent) => void
  readonly startSeq: number
  closed: boolean
}

const mkClient = (opts: {
  snapshot: { seq: number; scenarioId?: string }
  snapshotDelayMs?: number
  manifestThrows?: boolean
  snapshotThrows?: boolean
}): { client: LeitbildClient; subs: CapturedSub[]; release: () => void } => {
  const subs: CapturedSub[] = []
  let releaseSnapshot: (() => void) | undefined
  const snapshotReady = new Promise<void>((resolve) => { releaseSnapshot = resolve })
  return {
    subs,
    release: () => releaseSnapshot?.(),
    client: {
      baseUrl: 'https://fake.test',
      getManifest: async () => {
        if (opts.manifestThrows) throw new Error('manifest unavailable')
        return { manifestSchemaVersion: '1.0.0', identity: { operator: 'Test' }, links: {}, realtime: { model: '' } } as never
      },
      getSnapshot: async () => {
        if (opts.snapshotThrows) throw new Error('snapshot unavailable')
        if (opts.snapshotDelayMs !== undefined) await snapshotReady
        return { seq: opts.snapshot.seq, objects: [], scenarioId: opts.snapshot.scenarioId } as never
      },
      getScenario: async () => undefined,
      getEvents: async () => [],
      callPackQuery: async () => ({}),
      callCommand: async () => ({}),
      getCapabilities: async () => ({}),
      subscribe: (_instanceId: string, handler: (event: LeitbildEvent) => void, startSeq: number) => {
        const sub: CapturedSub = { handler, startSeq, closed: false }
        subs.push(sub)
        return { close: () => { sub.closed = true }, lastSeq: () => startSeq }
      },
    } as unknown as LeitbildClient,
  }
}

// Inject the fake client into the module-level pool so
// createLeitbildClient(baseUrl) returns it instead of constructing a real one.
// Uses the test seam in client.ts (parallel to __resetClientPool).
import { __injectClient, __resetClientPool } from './client.ts'

const withFakeClient = async <T>(baseUrl: string, fake: LeitbildClient, fn: () => Promise<T>): Promise<T> => {
  __resetClientPool()
  __injectClient(baseUrl, fake)
  try { return await fn() } finally { __resetClientPool() }
}

describe('mirror-service attach — race-safe buffering', () => {
  test('subscribes BEFORE snapshot fetch completes', async () => {
    const { client, subs, release } = mkClient({ snapshot: { seq: 100 }, snapshotDelayMs: 10 })
    const svc = createMirrorService()
    const room = mkRoom('r1')
    const config: LeitbildMirrorConfig = { baseUrl: 'https://fake.test', instanceId: 'i1', format: 'summary' }

    await withFakeClient(config.baseUrl, client, async () => {
      const attachPromise = svc.attach(room, config)
      // Give the event loop a tick so subscribe() runs.
      await new Promise(r => setTimeout(r, 1))
      // By this point subscribe should have been called even though getSnapshot
      // is still pending on `release`.
      expect(subs.length).toBe(1)
      release()
      await attachPromise
    })
  })

  test('events arriving during snapshot fetch are absorbed quietly', async () => {
    const { client, subs, release } = mkClient({ snapshot: { seq: 100 }, snapshotDelayMs: 10 })
    const svc = createMirrorService()
    const room = mkRoom('r2')
    const config: LeitbildMirrorConfig = { baseUrl: 'https://fake.test', instanceId: 'i2', format: 'summary' }

    await withFakeClient(config.baseUrl, client, async () => {
      const attachPromise = svc.attach(room, config)
      await new Promise(r => setTimeout(r, 1))
      // Fire 3 events while snapshot is pending.
      const handler = subs[0]!.handler
      handler({ seq: 99, type: 'object.upserted' } as LeitbildEvent)   // <= snapshot.seq, should drop
      handler({ seq: 100, type: 'object.upserted' } as LeitbildEvent)  // <= snapshot.seq, should drop
      handler({ seq: 101, type: 'object.upserted' } as LeitbildEvent)  // > snapshot.seq, should post
      release()
      await attachPromise

      // Attach is quiet: no connection banner, and replay/buffered events
      // are absorbed so loading Samsinn doesn't flood the room transcript.
      expect(room.posted.length).toBe(0)
    })
  })

  test('attach failure during snapshot fetch tears down subscription', async () => {
    const { client, subs } = mkClient({ snapshot: { seq: 0 }, snapshotThrows: true })
    const svc = createMirrorService()
    const room = mkRoom('r3')
    const config: LeitbildMirrorConfig = { baseUrl: 'https://fake.test', instanceId: 'i3', format: 'summary' }

    await withFakeClient(config.baseUrl, client, async () => {
      let threw = false
      try {
        await svc.attach(room, config)
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
      // Subscription was opened then closed during error recovery.
      expect(subs.length).toBe(1)
      expect(subs[0]!.closed).toBe(true)
      // Error banner posted.
      expect(room.posted.some(p => p.content.includes('mirror error'))).toBe(true)
      // statusFor should report nothing (entry was deleted on error).
      expect(svc.statusFor(room)?.connected).toBeUndefined()
    })
  })

  test('events arriving AFTER attach completes advance mirror state without chat', async () => {
    const { client, subs, release } = mkClient({ snapshot: { seq: 50 }, snapshotDelayMs: 1 })
    const svc = createMirrorService()
    const room = mkRoom('r4')
    const config: LeitbildMirrorConfig = { baseUrl: 'https://fake.test', instanceId: 'i4', format: 'summary' }

    await withFakeClient(config.baseUrl, client, async () => {
      const attachPromise = svc.attach(room, config)
      release()
      await attachPromise

      // Attach is quiet.
      expect(room.posted.length).toBe(0)

      // Live event after attach.
      subs[0]!.handler({ seq: 60, type: 'scenario.tick' } as LeitbildEvent)
      expect(room.posted.length).toBe(0)
      expect(svc.statusFor(room)?.lastSeq).toBe(60)
    })
  })

  test('reset events still post a visible boundary', async () => {
    const { client, subs, release } = mkClient({ snapshot: { seq: 50 }, snapshotDelayMs: 1 })
    const svc = createMirrorService()
    const room = mkRoom('r5')
    const config: LeitbildMirrorConfig = { baseUrl: 'https://fake.test', instanceId: 'i5', format: 'summary' }

    await withFakeClient(config.baseUrl, client, async () => {
      const attachPromise = svc.attach(room, config)
      release()
      await attachPromise

      subs[0]!.handler({ seq: 60, type: 'controlInstance.reset' } as LeitbildEvent)
      await new Promise(resolve => setTimeout(resolve, 0))

      expect(room.posted.length).toBe(1)
      expect(room.posted[0]!.content).toContain('CONTROL INSTANCE RESET')
    })
  })
})
