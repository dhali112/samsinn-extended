// ============================================================================
// House — Room collection.
//
// Creates, stores, and retrieves rooms. Holds the system-wide bookmark list,
// the house prompt, and the response format.
//
// Names are unique (case-insensitive). createRoom throws on collision.
// createRoomSafe auto-renames on collision and returns CreateResult.
// ============================================================================

import type { Bookmark, CreateResult, House, HouseCallbacks, Room, RoomConfig } from './types/room.ts'
import type { RoomProfile } from './types/messaging.ts'
import { createRoom, type RoomCallbacks } from './rooms/room.ts'
import { ensureUniqueName, validateName } from './names.ts'

// Exported so snapshot persistence can omit serialised values that match
// the default (keeps snapshots small + lets restoreFromSnapshot leave the
// in-memory default in place when no override was set).
export const DEFAULT_HOUSE_PROMPT = `You are part of samsinn, a collaborative multi-agent system. Be respectful and constructive. When uncertain, say so rather than guessing. Prioritise responding to new messages and direct questions. Use the pass tool when the conversation genuinely does not need your input.`

export const DEFAULT_RESPONSE_FORMAT = `- Write your message as natural text. Your response IS the message other participants will read.
- You may use Markdown formatting (headings, bold, lists, code blocks, etc.).
- To direct a message to a specific agent, use [[AgentName]] in your response.
  Example: [[Analyst-1]] can you elaborate on that point?
- To address all agents with a given tag, use [[tag:TagName]].
  Example: [[tag:Reviewer]] please review this before we proceed.
- Never wrap your response in JSON or data structures.`


export const createHouse = (callbacks: HouseCallbacks = {}): House => {
  const {
    deliver, resolveAgentName, resolveTag, resolveKind, onMessagePosted, onTurnChanged,
    onDeliveryModeChanged, onRoomCreated, onRoomDeleted,
    onBookmarksChanged, onManualModeEntered, onModeAutoSwitched,
    onSummaryConfigChanged, onSummaryUpdated, callSystemLLM, onScriptMessage,
  } = callbacks

  const rooms = new Map<string, Room>()
  const nameIndex = new Map<string, string>()  // lowercase name → room ID
  let housePrompt = DEFAULT_HOUSE_PROMPT
  let responseFormat = DEFAULT_RESPONSE_FORMAT

  // --- Rooms ---

  const getExistingNames = (): ReadonlyArray<string> =>
    [...rooms.values()].map(r => r.profile.name)

  const isNameTaken = (name: string): boolean =>
    nameIndex.has(name.toLowerCase())

  const makeRoomCallbacks = (): RoomCallbacks => ({
    deliver, resolveAgentName, resolveTag, resolveKind, onMessagePosted, onTurnChanged, onDeliveryModeChanged, onManualModeEntered, onModeAutoSwitched, onSummaryConfigChanged, onSummaryUpdated, onScriptMessage,
  })

  const storeRoom = (config: RoomConfig, name: string): Room => {
    validateName(name, 'Room')
    const id = crypto.randomUUID()
    const profile: RoomProfile = {
      id,
      name,
      roomPrompt: config.roomPrompt,
      createdBy: config.createdBy,
      createdAt: Date.now(),
    }
    const room = createRoom(profile, makeRoomCallbacks())
    rooms.set(id, room)
    nameIndex.set(name.toLowerCase(), id)
    onRoomCreated?.(profile)
    return room
  }

  const createRoomInHouse = (config: RoomConfig): Room => {
    if (isNameTaken(config.name)) {
      throw new Error(`Room name "${config.name}" is already taken`)
    }
    return storeRoom(config, config.name)
  }

  const createRoomSafe = (config: RoomConfig): CreateResult<Room> => {
    const assignedName = ensureUniqueName(config.name, getExistingNames())
    const room = storeRoom(config, assignedName)
    return { value: room, requestedName: config.name, assignedName }
  }

  const getRoom = (idOrName: string): Room | undefined => {
    const byId = rooms.get(idOrName)
    if (byId) return byId
    const idByName = nameIndex.get(idOrName.toLowerCase())
    return idByName ? rooms.get(idByName) : undefined
  }

  const listAllRooms = (): ReadonlyArray<RoomProfile> =>
    [...rooms.values()].map(r => r.profile)

  const getRoomsForAgent = (agentId: string): ReadonlyArray<Room> =>
    [...rooms.values()].filter(r => r.hasMember(agentId))

  // --- Bookmarks (system-wide, newest-first) ---

  const bookmarks: Bookmark[] = []

  const notifyBookmarks = (): void => { onBookmarksChanged?.() }

  const listBookmarks = (): ReadonlyArray<Bookmark> => bookmarks.slice()

  const addBookmark = (content: string): Bookmark => {
    const entry: Bookmark = { id: crypto.randomUUID(), content }
    bookmarks.unshift(entry)
    notifyBookmarks()
    return entry
  }

  const updateBookmark = (id: string, content: string): Bookmark | undefined => {
    const idx = bookmarks.findIndex(b => b.id === id)
    if (idx < 0) return undefined
    const updated: Bookmark = { id, content }
    bookmarks[idx] = updated
    notifyBookmarks()
    return updated
  }

  const deleteBookmark = (id: string): boolean => {
    const idx = bookmarks.findIndex(b => b.id === id)
    if (idx < 0) return false
    bookmarks.splice(idx, 1)
    notifyBookmarks()
    return true
  }

  const restoreBookmarks = (entries: ReadonlyArray<Bookmark>): void => {
    bookmarks.length = 0
    for (const b of entries) bookmarks.push({ id: b.id, content: b.content })
  }

  const removeRoom = (id: string): boolean => {
    const room = rooms.get(id)
    if (!room) return false
    const { name } = room.profile
    nameIndex.delete(name.toLowerCase())
    rooms.delete(id)
    onRoomDeleted?.(id, name)
    return true
  }

  return {
    createRoom: createRoomInHouse,
    createRoomSafe,
    getRoom,
    getRoomsForAgent,
    listAllRooms,
    removeRoom,
    getHousePrompt: () => housePrompt,
    setHousePrompt: (prompt: string) => { housePrompt = prompt },
    getResponseFormat: () => responseFormat,
    setResponseFormat: (format: string) => { responseFormat = format },

    restoreRoom: (existingProfile: RoomProfile): Room => {
      const room = createRoom(existingProfile, makeRoomCallbacks())
      rooms.set(existingProfile.id, room)
      nameIndex.set(existingProfile.name.toLowerCase(), existingProfile.id)
      return room
    },

    listBookmarks,
    addBookmark,
    updateBookmark,
    deleteBookmark,
    restoreBookmarks,
    callSystemLLM,
  }
}
