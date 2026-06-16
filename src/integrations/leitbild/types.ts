// ============================================================================
// Leitbild integration — shared types.
//
// Consumed by client.ts, mirror-service.ts, formatter.ts, and the API
// routes module. Keeps cross-file contracts in one place.
//
// LeitbildMirrorConfig itself lives in core/types/room.ts because Room
// state owns it; this module re-exports for convenience.
// ============================================================================

export type { LeitbildMirrorConfig } from '../../core/types/room.ts'

// Minimal projection of Leitbild's discovery manifest — we only care
// about the fields the client actually uses. The full manifest carries
// more (planned/, wikiRefs/, etc.) which we ignore.
export interface LeitbildManifestSummary {
  readonly manifestSchemaVersion: string
  readonly identity: {
    readonly implementation: string
    readonly implementationVersion: string
    readonly title: string
    readonly operator: string
    readonly deploymentId: string
  }
  readonly links: Readonly<Record<string, { readonly href?: string; readonly hrefTemplate?: string }>>
  readonly realtime: {
    readonly model: string
  }
}

// Required link rels for a V1 mirror to attach. Validated at manifest
// fetch time; missing any → attach fails loud.
export const REQUIRED_LINK_RELS = [
  'self',
  'scenarios',
  'controlInstances',
  'controlInstance',
  'controlInstanceSnapshot',
  'controlInstanceEvents',
  'realtime',
] as const

// Shape of a single event delivered to subscribers. We don't enforce
// Leitbild's full domain event schema here — the mirror passes events
// through to the formatter, which renders whatever it gets. Seq is the
// only field the client itself depends on (for dedup + replay).
export interface LeitbildEvent {
  readonly seq: number
  readonly type: string
  readonly id?: string
  readonly [k: string]: unknown
}

// What the client's subscribe() callback receives.
export type LeitbildEventHandler = (event: LeitbildEvent) => void

// Returned by subscribe() — call .close() to unsubscribe and (if last
// subscriber for that instance) drop the underlying WS connection.
export interface SubscriptionHandle {
  readonly close: () => void
  readonly lastSeq: () => number
}

// Snapshot envelope returned by GET /api/control-instances/{id} —
// minimal projection. `seq` is the field we anchor the mirror on.
export interface ControlInstanceSnapshot {
  readonly seq: number
  readonly clock?: {
    readonly currentTime?: string
    readonly paused?: boolean
    readonly speed?: number
  }
  readonly objects?: ReadonlyArray<unknown>
  readonly scenarioId?: string
  readonly [k: string]: unknown
}

export interface ControlInstanceSummary {
  readonly id: string
  readonly scenarioId?: string
  readonly loaded?: boolean
  readonly seq?: number
  readonly snapshotSeq?: number
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly [k: string]: unknown
}

// Scenario summary projection — banner uses title/description.
export interface ScenarioSummary {
  readonly id: string
  readonly title?: string
  readonly description?: string
  readonly [k: string]: unknown
}
