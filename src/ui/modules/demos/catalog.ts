// ============================================================================
// Demo catalog — static data driving the empty-room demo strip and the
// demo modal. Each demo is a small bundle of click-to-send prompts plus the
// packs the prompts depend on (merged into the room's active set on launch).
//
// Adding a new demo: add an entry below. The strip/modal/header-icon all
// derive from this array — no other edits needed.
// ============================================================================

export interface DemoPrompt {
  readonly label: string
  readonly description: string
  // Sent verbatim as a chat message in the current room when clicked.
  // Mention any required tool by name explicitly; modern models pick tools
  // reliably when named.
  readonly prompt: string
}

export type DemoId = 'procedures' | 'biometrics' | 'aviation' | 'leitbild'

export interface Demo {
  readonly id: DemoId
  readonly title: string
  readonly blurb: string                       // shown in the modal; mentions the 🪄 icon
  readonly requiredPacks: ReadonlyArray<string>
  // Tool names the prompts call. A boot-time test (catalog.test.ts) asserts
  // each is registered so silent demo-breakage from tool renames is caught.
  readonly requiredTools: ReadonlyArray<string>
  readonly prompts: ReadonlyArray<DemoPrompt>
}

export const DEMO_CATALOG: ReadonlyArray<Demo> = [
  {
    id: 'procedures',
    title: 'Procedure Demo',
    blurb:
      'Pull real nuclear-plant emergency operating procedures from the wiki, search across them by keyword, and classify scenarios against NEI 99-01 emergency action levels. Click any prompt below to try it. You can re-open this list any time from the 🪄 icon in the room header.',
    requiredPacks: ['pwr-ops'],
    requiredTools: ['procedure_lookup', 'procedure_search', 'wiki_lookup', 'eal_classify'],
    prompts: [
      {
        label: 'E-0 → E-3 transition criteria',
        description: 'Decision points and criteria for the transfer from E-0 (reactor trip) to E-3 (SGTR), as a diagram.',
        prompt: 'Use procedure_lookup to fetch E-0 then E-3. Explain the decision points and decision criteria for the transfer from E-0 to E-3 — which step in E-0 triggers the branch, what symptoms qualify, what disqualifies it (faulted SG vs. ruptured SG), and what E-3 does first. Show the relevant steps as a mermaid flowchart.',
      },
      {
        label: 'SGTR recovery: pick ECA-3.1 vs 3.2 vs 3.3',
        description: 'Cross-procedure: how the operator chooses between the three SGTR recovery paths.',
        prompt: 'Use procedure_lookup with mode=summary to fetch E-3, then ECA-3.1, then ECA-3.2, then ECA-3.3 (four calls). Then produce a mermaid flowchart showing how an operator decides between the three recovery procedures once an SGTR is confirmed in E-3. Label each branch with the actual entry criterion (subcooling margin state, pressurizer pressure control, etc.) drawn from the procedures.',
      },
      {
        label: 'Diagnose E-1 vs E-2 vs E-3 from E-0',
        description: 'How E-0 distinguishes a LOCA, a faulted SG, and a ruptured SG.',
        prompt: 'Use procedure_lookup to fetch E-0, E-1, E-2, and E-3 (mode=summary is fine). Then explain how an operator in E-0 distinguishes between transitioning to E-1 (LOCA), E-2 (faulted SG), and E-3 (SGTR) — which symptoms point to which procedure, and what the disambiguation order is. Render the decision tree as a mermaid flowchart.',
      },
      {
        label: 'Station-blackout vs E-0',
        description: 'What in E-0 becomes unavailable under ECA-0.0, and how the procedure copes.',
        prompt: 'Use procedure_lookup to fetch E-0 and ECA-0.0. Identify the E-0 verification steps that cannot be performed once both AC trains are de-energized (e.g. ECCS, Phase-A isolation, charging pumps), and explain what ECA-0.0 substitutes (TDAFW, natural circulation, DC load shedding, RCP seal-LOCA risk). Summarise as a side-by-side table plus a short mermaid diagram of the SBO coping timeline.',
      },
      {
        label: 'CSF red-path priority',
        description: 'Compare the five red-path Function Restoration procedures.',
        prompt: 'Use procedure_lookup to fetch FR-S.1, FR-C.1, FR-H.1, FR-P.1, and FR-Z.1 (mode=summary). Build a comparison table with columns: CSF, entry trigger, first immediate action, and the EOP it would override. Then explain in 2-3 sentences why CSF status trees take priority over the active EOP, and render a mermaid diagram showing how a red-path CSF interrupts the running E-procedure.',
      },
      {
        label: 'EAL classify SGTR scenario',
        description: 'Classify a steam-generator-tube-rupture scenario against NEI 99-01 EALs.',
        prompt: 'Use the eal_classify tool to classify a scenario where a steam generator tube rupture is detected with primary-to-secondary leakage of 50 gpm and rising secondary-side radiation on SG-B. What EAL class does this map to, and why?',
      },
      {
        label: 'Reference: Tag catalogue index',
        description: 'Fetch a wiki reference page (not a procedure) — the tag-catalogue index.',
        prompt: 'Use the wiki_lookup tool with type "tag-catalogue" and id "index" to fetch the tag-catalogue index, then summarise what systems are covered and what each entry represents.',
      },
    ],
  },
  {
    id: 'biometrics',
    title: 'Biometrics Demo',
    blurb:
      'Webcam-based attention tracking. The agent observes your face for a moment, narrates what it sees, then releases the camera. You\'ll be asked to consent to webcam access the first time. Re-open this list any time from the 🪄 icon in the room header.',
    requiredPacks: ['biometrics'],
    requiredTools: ['biometrics_start', 'biometrics_read', 'biometrics_stop'],
    prompts: [
      {
        label: 'Watch me',
        description: 'Agent starts the camera, reads one frame, narrates, and stops.',
        prompt: 'Watch me for a moment using the biometrics tools, then tell me what you see — attention level, dominant expression, anything notable. Use biometrics_start, then biometrics_read with the captureId you got, then biometrics_stop with the same captureId.',
      },
      {
        label: 'Coach my focus',
        description: 'Agent observes and offers one piece of concrete focus advice.',
        prompt: 'Use the biometrics tools to observe me for a moment, then give me one concrete piece of advice for staying focused based on what you see. One reading, one observation, one tip.',
      },
      {
        label: 'Quick check',
        description: 'Just a quick glance — am I still here?',
        prompt: 'Use biometrics_start, biometrics_read, then biometrics_stop to quickly check whether I\'m still at my desk and looking attentive. One sentence reply.',
      },
    ],
  },
  {
    id: 'aviation',
    title: 'Aviation Demo',
    blurb:
      'Live VATSIM network data — real human pilots flying simulators right now — plus offshore platform geodata, rendered on an inline map. Re-open this list any time from the 🪄 icon in the room header.',
    requiredPacks: ['demos'],
    requiredTools: ['vatsim_arrivals', 'norway_platforms'],
    prompts: [
      {
        label: 'Arrivals into Heathrow',
        description: 'Live VATSIM arrivals to EGLL on a map.',
        prompt: 'Use the vatsim_arrivals tool with ICAO EGLL and show me live arrivals to London Heathrow on a map.',
      },
      {
        label: 'Arrivals into JFK',
        description: 'Live VATSIM arrivals to KJFK on a map.',
        prompt: 'Use the vatsim_arrivals tool with ICAO KJFK and show me live arrivals to New York JFK on a map.',
      },
      {
        label: 'Norwegian oil platforms',
        description: 'Every major NCS platform plotted on a map.',
        prompt: 'Use the norway_platforms tool and show me all major Norwegian Continental Shelf oil & gas platforms on a map.',
      },
      {
        label: 'Arrivals into Oslo',
        description: 'Live VATSIM arrivals to ENGM on a map.',
        prompt: 'Use the vatsim_arrivals tool with ICAO ENGM and show me live arrivals to Oslo Gardermoen on a map.',
      },
    ],
  },
]

// Append Leitbild demo. Keeps the array shape; setup work lives in
// demo-modal.ts's openDemoModal special case (same pattern as biometrics
// pack install).
;(DEMO_CATALOG as Demo[]).push({
  id: 'leitbild',
  title: 'Leitbild Integration',
  blurb:
    'Connect this room to a live Leitbild ambulance-dispatch scenario. A fresh Control Instance is created at leitbild.samsinn.app, mirrored events flow into this chat, and a Leitbild dashboard becomes available bottom-right. If an AI agent is in the room it gets a leitbildBinding plus lb_* tools automatically. Re-open this list any time from the 🪄 icon in the room header.',
  requiredPacks: [],
  requiredTools: ['lb_state', 'lb_scenario', 'lb_query', 'lb_object', 'lb_dispatch_context'],
  prompts: [
    {
      label: 'Summarize the scenario',
      description: 'Use lb_dispatch_context to pull state + scenario + all pack queries in one call, then summarize.',
      prompt: 'Use lb_dispatch_context (one tool call gives you the full picture: state, scenario, capabilities, all pack queries). Then in 3-4 sentences tell me: what scenario are we in, what packs are active, how many objects by domain, and any notable incidents or ambulance dispatch state.',
    },
    {
      label: 'Where are the ambulances?',
      description: 'Use lb_query to read ambulance dispatch state.',
      prompt: 'Use lb_query with packId="ambulance" kind="ambulance.dispatchState" to read the current ambulance fleet. Then list each ambulance with its label, status (idle / dispatched / en-route / etc), and current location. Be concise — one line per ambulance.',
    },
    {
      label: 'Active incidents — what needs attention?',
      description: 'Identify incidents and prioritize.',
      prompt: 'Use lb_query("ambulance", "ambulance.objects", {}) and filter for incident-type objects. For each unresolved incident, give its label, severity, and location. Then suggest which one a dispatcher should respond to first and why.',
    },
    {
      label: 'Weather conditions',
      description: 'Query the weather pack.',
      prompt: 'Use lb_query with packId="weather" kind="weather.fieldStats" to read current weather field stats. Summarize what the agent sees and whether it would affect ambulance response time.',
    },
  ],
})

export const getDemo = (id: string): Demo | undefined =>
  DEMO_CATALOG.find(d => d.id === id)
