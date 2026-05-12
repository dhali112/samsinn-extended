// ============================================================================
// Showcase prompt chips — one-click demos that don't need the scenarios
// runner. Each chip posts a natural-language prompt into the user's current
// room as if they'd typed it. The room's existing AI sees the message,
// calls the relevant bundled tool, and renders the result.
//
// Why this isn't a scenario:
//   - No pack install, no agent spawn, no persona engineering, no wait
//     ops, no abandonment timer. Just "post this message."
//   - The scenarios subsystem is the right tool for multi-step orchestration
//     (Watch Me's pack install + biometrics-tool agent + consent flow).
//     It's the WRONG tool for "post a prompt and see what happens" —
//     forcing one-shot demos through it was the source of cascading bugs
//     (auto-switch-to-manual heuristic, __DEFAULT_HUMAN__ resolution,
//     persona-vs-system-trailer fights, etc.).
//
// The chips render in the empty-state strip (scenario-strip.ts) when a
// room has no chat yet. They share the same room-id / sender-id resolution
// logic the chat input uses (see app.ts:547 chatForm.onsubmit), exposed
// here as sendAsCurrentHuman().
// ============================================================================

import { send } from './ws-send.ts'
import { $selectedRoomId, $rooms, $agents, $roomMembers, $selectedHumanByRoom } from './stores.ts'
import { showToast } from './toast.ts'

export interface ShowcasePrompt {
  readonly label: string
  readonly description: string
  // The natural-language prompt sent verbatim as a chat message into the
  // current room. The room's existing AI is expected to handle it. Mention
  // the tool by name in the prompt — modern models are reliable at "call
  // tool X" tool selection when explicitly named.
  readonly prompt: string
}

export const SHOWCASE_PROMPTS: ReadonlyArray<ShowcasePrompt> = [
  {
    label: 'Norwegian oil platforms',
    description: 'Agent renders all major NCS platforms on a map.',
    prompt: 'Use the norway_platforms tool and show me all major Norwegian Continental Shelf oil & gas platforms on a map.',
  },
  {
    label: 'VATSIM into Heathrow',
    description: 'Live VATSIM arrivals to London Heathrow.',
    prompt: 'Use the vatsim_arrivals tool with ICAO EGLL and show live arrivals to London Heathrow on a map.',
  },
  {
    label: 'Draw a flowchart',
    description: 'Agent renders a mermaid flowchart inline.',
    prompt: 'Draw a flowchart in mermaid of an offshore oil/gas separation train (well stream → separator → oil/gas/water outlets → downstream destinations).',
  },
  {
    label: 'PWR EOP procedure (E-0)',
    description: 'Fetch a nuclear EOP and render as step list + diagram.',
    prompt: 'Use the procedure_lookup tool to fetch procedure E-0 and show me a numbered step list plus a mermaid flowchart of the decision flow.',
  },
]

// Post the prompt as if the user had typed it in the chat input. Mirrors
// the resolution logic in app.ts's chatForm.onsubmit:
//   1. current room must be selected
//   2. sender is the user's last-picked human for this room, OR the single
//      human if there's only one, OR opens the picker if multiple.
// On success, the prompt is the next chat message in the room.
//
// Returns false if the post couldn't be sent (no room open, no human in
// room) so the caller can surface a toast.
export const sendAsCurrentHuman = (content: string): boolean => {
  const roomId = $selectedRoomId.get()
  if (!roomId) {
    showToast(document.body, 'Open a room first to try a demo prompt.', { type: 'error', position: 'fixed' })
    return false
  }
  const roomName = $rooms.get()[roomId]?.name
  if (!roomName) return false

  const posterMap = $selectedHumanByRoom.get()
  let senderId = posterMap[roomId]

  if (!senderId) {
    const agents = $agents.get()
    const members = $roomMembers.get()[roomId] ?? []
    const humansInRoom = members
      .map(id => agents[id])
      .filter((a): a is NonNullable<typeof a> => !!a && a.kind === 'human')
    if (humansInRoom.length === 1) {
      senderId = humansInRoom[0]!.id
      $selectedHumanByRoom.setKey(roomId, senderId)
    } else if (humansInRoom.length === 0) {
      showToast(document.body, 'This room has no human member to post as.', { type: 'error', position: 'fixed' })
      return false
    } else {
      // Multiple humans — defer to the existing picker via the chat input.
      // Falling back to a toast keeps the chip simple; users with multi-
      // human rooms can paste the prompt manually.
      showToast(document.body, 'Multiple humans in this room — pick one with the send-as control, then paste the prompt manually.', { type: 'error', position: 'fixed', durationMs: 8000 })
      return false
    }
  }

  send({ type: 'post_message', target: { rooms: [roomName] }, content, senderId })
  return true
}
