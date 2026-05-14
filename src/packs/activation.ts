// Pack activation resolver — single source of truth for "which packs are
// active in room X."
//
// As of v24: room.activePacks is the COMPLETE list. There is no implicit
// augmentation at read time. Default-active packs (see src/packs/bundled.ts)
// are seeded into room.activePacks at room creation; from then on the
// user's explicit list is authoritative.
//
// System packs ('core', 'local') are guaranteed to be in every room's
// activePacks by the seed/restore paths and by the activation route, which
// refuses requests that would remove them. See src/api/routes/rooms.ts and
// src/packs/bundled.ts for the system-pack list.

export interface RoomActivation {
  readonly getActivePacks: () => ReadonlyArray<string>
}

// Effective active packs for a room — exactly what the room reports.
// Kept as a wrapper (rather than inlining room.getActivePacks() at call
// sites) so that any future indirection (e.g. tenant-level overrides)
// has a single hook to extend.
//
// NOTE: this list is an ALLOWLIST for tool/skill/script visibility per room.
// It does NOT govern resolution order for collisions. Pack-bundled geodata
// category metadata (see src/geo/pack-source.ts:reload) is built once at
// boot across ALL installed packs in filesystem-scan order — first-feature-
// wins per category id, regardless of which packs are active in a given
// room. Pack authors must namespace their category ids to avoid collisions.
export const effectiveActivePacks = (room: RoomActivation): ReadonlyArray<string> =>
  room.getActivePacks()

// Set membership form for hot-path filters (e.g. tool surface filter on
// every agent spawn).
export const effectiveActivePackSet = (room: RoomActivation): ReadonlySet<string> =>
  new Set(effectiveActivePacks(room))

// True if a pack identified by `packNamespace` is active in the room.
// Tools without a pack (kind: 'built-in', 'external') are mapped to
// 'core' / 'local' by packNameFor and gated through this same path.
export const isPackActiveInRoom = (
  room: RoomActivation,
  packNamespace: string,
): boolean => effectiveActivePackSet(room).has(packNamespace)
