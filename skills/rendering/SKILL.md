---
name: rendering
description: Use when the user asks for a diagram, flowchart, sequence, map, or "show me" a visualization. Produce the fenced block directly — the UI renders it inline. Do not say "I can't show diagrams here" — you can.
---

samsinn renders certain fenced code blocks inline as visualizations. When
the user asks for any of these, emit the fence directly in your reply.
Don't apologize, don't describe what you'd draw — just draw it.

## Mermaid diagrams (flowchart, sequence, class, state, ER, gantt, mindmap)

Use a ```mermaid fence:

```mermaid
flowchart LR
  A[Start] --> B{Decision}
  B -->|yes| C[Path 1]
  B -->|no| D[Path 2]
```

Tips:
- Keep diagrams 6–15 nodes for readability.
- Mermaid v10 syntax. `flowchart` (not `graph`) is preferred for new diagrams.
- For sequence diagrams use `sequenceDiagram`. For state machines use `stateDiagram-v2`.

## Maps (geographic visualizations with markers, lines, polygons)

Use a ```map fence containing a JSON envelope:

```map
{
  "view": { "center": [60.193, 11.100], "zoom": 8 },
  "features": [
    { "type": "marker", "position": [60.193, 11.100], "title": "Oslo Airport" },
    { "type": "marker", "position": [59.913, 10.752], "title": "Oslo center" },
    { "type": "line", "points": [[60.193, 11.100], [59.913, 10.752]], "color": "#1d4ed8" }
  ]
}
```

Schema:
- `view.center: [lat, lng]` — initial center. `lat` -90..90, `lng` -180..180.
- `view.zoom: number` — typical 3 (continent) to 15 (street). Default ~10.
- `features[]` — each is one of:
  - `{ type: "marker", position: [lat, lng], title?: string, icon?: string }`
  - `{ type: "line", points: [[lat,lng], ...], color?: string, weight?: number }`
  - `{ type: "polygon", points: [[lat,lng], ...], color?: string, fillOpacity?: number }`
- Coordinate aliases the renderer accepts: `lat`/`latitude`, `lng`/`lon`/`longitude`. Stick to `lat`/`lng` when generating.

## Common refusal you must NOT emit

These are wrong — the UI does render diagrams and maps. Don't say:
- "I can't directly show a diagram here."
- "I can describe it but can't draw it."
- "Would you like me to outline the steps instead?"

Instead, just emit the fence and a one-sentence caption.

## When the request is ambiguous

If the user says "show me X on a map" and you don't have coordinates, either:
- Use approximate coordinates from your knowledge (and say so in one line below the fence)
- OR ask one specific question ("Which city — Oslo or Bergen?") then produce the map next turn

If the user says "diagram of X" without specifying the kind, default to `flowchart LR` for processes / decisions, `sequenceDiagram` for interactions over time.
