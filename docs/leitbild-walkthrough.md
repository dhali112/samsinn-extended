# Leitbild integration — end-to-end walkthrough

A concrete, copy-pasteable session showing how to bind a Samsinn room to a Leitbild Control Instance and put an AI agent in front of it. The commands below were used to verify V2 against live `https://leitbild.samsinn.app` and produced the exact outputs shown.

Pre-requisites:
- Samsinn ≥ v0.14.0 running locally on `:4444` (`PORT=4444 bun run start`)
- An OpenAI key in env (`OPENAI_API_KEY=...`) — used by the agent for the LLM call; replace with whatever provider you prefer
- `jq` for output formatting

## 1. Open a session cookie jar

```bash
JAR=/tmp/samsinn-walkthrough.cookies && rm -f $JAR
BASE=http://127.0.0.1:4444
curl -sS -c $JAR -o /dev/null $BASE/api/system/info   # seeds the samsinn_instance cookie
```

The first request mints the per-visitor `samsinn_instance` cookie. Reuse the jar on every subsequent request so you stay in the same Samsinn instance.

## 2. Create a Leitbild Control Instance

```bash
CI=$(curl -sS -X POST https://leitbild.samsinn.app/api/control-instances \
  -H 'Content-Type: application/json' \
  -d '{"scenarioId":"oslo-ambulance"}' | jq -r .id)
echo "CI=$CI"
```

Typical output: `CI=oslo-ambulance:run-9beb515e-8125-468e-bfbe-ee0098b9d6a8`.

The `oslo-ambulance` scenario is the tutorial scenario shipped in Leitbild. It populates the CI with 11 ambulance-domain objects (ambulances, hospitals, incidents), 2 weather-domain objects, and 1 traffic-domain object.

## 3. Create a Samsinn room

```bash
curl -sS -b $JAR -c $JAR -X POST $BASE/api/rooms \
  -H 'Content-Type: application/json' \
  -d '{"name":"agent-test","createdBy":"system"}' | jq '.value.profile.name'
```

Output: `"agent-test"`.

## 4. Create an AI agent bound to the Leitbild CI

This is the V2.A flow: an AI agent with `leitbildBinding` and the `lb_*` read tools in its allowlist.

```bash
cat > /tmp/agent.json <<EOF
{
  "name": "DispatchSpecialist",
  "model": "gpt-4o-mini",
  "persona": "Dispatch specialist.",
  "tools": ["lb_state", "lb_scenario", "pass"],
  "leitbildBinding": {
    "baseUrl": "https://leitbild.samsinn.app",
    "instanceId": "$CI",
    "role": "observer"
  }
}
EOF
curl -sS -b $JAR -X POST $BASE/api/agents \
  -H 'Content-Type: application/json' \
  --data @/tmp/agent.json | jq .
```

Output:
```json
{ "id": "57386fd7-…", "name": "DispatchSpecialist", "modelStatus": "unavailable" }
```

(`modelStatus: "unavailable"` is a soft warning from Samsinn's pre-flight check — the agent will still run; the model resolver tries the requested model at call time and falls back if needed.)

Verify the binding stuck:

```bash
curl -sS -b $JAR $BASE/api/agents/DispatchSpecialist | jq '{leitbildBinding, tools}'
```

Expected:
```json
{
  "leitbildBinding": {
    "baseUrl": "https://leitbild.samsinn.app",
    "instanceId": "oslo-ambulance:run-9beb515e-…",
    "role": "observer"
  },
  "tools": ["lb_state", "lb_scenario", "pass"]
}
```

## 5. Add the agent to the room

```bash
curl -sS -b $JAR -X POST $BASE/api/rooms/agent-test/members \
  -H 'Content-Type: application/json' \
  -d '{"agentName":"DispatchSpecialist"}'
```

Output: `{"added":true,"agentName":"DispatchSpecialist","roomName":"agent-test"}`.

## 6. Post a message asking the agent to reason about scenario state

```bash
curl -sS -b $JAR -X POST $BASE/api/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "senderId":"system",
    "content":"Hi DispatchSpecialist - please call lb_scenario and lb_state then in 2 sentences tell me what scenario we are in and the object breakdown by domain.",
    "messageType":"chat",
    "target":{"rooms":["agent-test"]}
  }'
```

(`target.rooms` takes room *names* over HTTP, room *ids* via WS.)

## 7. Watch the agent execute the tool chain

```bash
sleep 15   # let the LLM call complete (gpt-4o-mini typically <10s)
curl -sS -b $JAR "$BASE/api/rooms/agent-test?limit=20" | jq '
  [.messages[] | {
    sender: .senderName,
    type,
    content: (.content | .[0:300]),
    tools: (.toolTrace // [] | map(.tool))
  }]
'
```

Real output from the V2 verification run:

```json
[
  { "sender": "DispatchSpecialist", "type": "join", "content": "[DispatchSpecialist] has joined", "tools": [] },
  { "sender": null, "type": "chat", "content": "Hi DispatchSpecialist - please call lb_scenario and lb_state then in 2 sentences tell me what scenario we are in and the object breakdown by domain.", "tools": [] },
  {
    "sender": "DispatchSpecialist",
    "type": "chat",
    "content": "We are currently in the scenario titled \"Oslo ambulance tutorial,\" which involves a timed ambulance dispatch scenario with existing transports, unresolved incidents, traffic conditions, and tutorial guidance. The object breakdown by domain includes 11 objects related to ambulance dispatch, 2 related…",
    "tools": ["lb_scenario", "lb_state"]
  }
]
```

The `tools` field on the agent's response is the `toolTrace` — proof that both `lb_scenario` and `lb_state` were actually called during evaluation. The agent's text was generated from the real tool results, not hallucinated.

## What's happening under the hood

1. The agent's evaluation loop sees `tools: ["lb_state", "lb_scenario", "pass"]` in its config and `leitbildBinding` set → both tools are eligible.
2. The LLM (`gpt-4o-mini`) emits a tool-use response calling `lb_scenario` (no args), then `lb_state` (no args).
3. Each tool execution resolves the binding via the caller's agent id → looks up `leitbildBinding.baseUrl` → uses the shared process-level `LeitbildClient` to fetch.
4. `lb_state` hits the per-(agent, instance) snapshot cache; first call roundtrips to `https://leitbild.samsinn.app/api/control-instances/{id}/snapshot`, subsequent calls within 5s return cached.
5. Tool results are injected back into the LLM context as `tool_result` messages.
6. LLM emits a final response (no tool calls) → posted to the room as the agent's chat message with the toolTrace stamped on it.

## Optional next steps

- **Add `lb_query`** to read pack-specific state (`ambulance.dispatchState`, `weather.summarizeArea`, etc.). Discover valid `(packId, kind)` pairs from `GET https://leitbild.samsinn.app/api/control-instances/{$CI}/capabilities`.
- **Add `lb_object`** to read individual objects by id (use ids surfaced by `lb_state` or `lb_query`).
- **Upgrade to operator role** by PATCHing `leitbildBinding.role` to `"operator"` and adding `lb_command` to the tools list. The agent can then issue commands like `lb_command('ambulance.assign_to_incident', [], {ambulanceId: 'amb:a12', incidentId: 'incident:gronland-unattended'})`. Other room participants see the command + result via the room mirror; the issuing agent doesn't see its own echo (V2.A's `suppressLeitbildMirror` filter handles that).
- **Add a room mirror** in parallel (`PUT /api/rooms/agent-test/leitbild-mirror`) so non-agent room members (humans, other agents) get the live event narration the bound agent already pulls via tools.

## Cleanup

```bash
curl -sS -b $JAR -X DELETE $BASE/api/agents/DispatchSpecialist
curl -sS -X DELETE "https://leitbild.samsinn.app/api/control-instances/$CI"
```
