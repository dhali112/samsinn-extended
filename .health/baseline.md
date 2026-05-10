# Samsinn health — 2026-05-10 11:29:18

## Summary

- Typecheck: ✅ pass
- Type coverage: 98.61%
- Escape hatches (`as any` / `@ts-ignore` etc): 64
- Dependency-cruiser: x 71 dependency violations (65 errors, 6 warnings). 604 modules, 1434 dependencies cruised.

## 1. Typecheck (bun run check)
```
$ tsc --noEmit && tsc --noEmit -p tsconfig.ui.json
```

## 2. Type coverage
```
Saved lockfile
(84510 / 85695) 98.61%
type-coverage success.
```

## 3. Escape hatches
```
src/ui/lib/nanostores.ts:120:  const $map = atom(initial) as unknown as MapStore<T>
src/ui/lib/nanostores.ts:152:  // @ts-expect-error - reassigning a typed-readonly method on the atom.
src/ui/lib/nanostores.ts:202:  // @ts-expect-error - reassigning a typed-readonly method on the computed atom.
src/ui/modules/app.ts:258:    agents: agents as unknown as Record<string, AgentInfo>,
src/ui/modules/app.ts:357:        agents: $agents.get() as unknown as Record<string, AgentInfo>,
src/ui/modules/app.ts:436:        agents: $agents.get() as unknown as Record<string, AgentInfo>,
src/ui/modules/app.ts:508:  if (health) updateOllamaHealthUI(health as unknown as Record<string, unknown>, ollamaStatusDot)
src/ui/modules/map/api.ts:69:  const existing = (window as unknown as { L?: LeafletApi }).L
src/ui/modules/map/api.ts:77:    const L = (window as unknown as { L?: LeafletApi }).L
src/ui/modules/map/api.ts:88:    const Lwithicon = L as unknown as {
src/ui/modules/map/index.ts:105:  ;(tileLayer as unknown as { on: (e: string, h: () => void) => void }).on('tileerror', () => {
src/tools/built-in/recall-tool.test.ts:31:  return fn as unknown as typeof globalThis.fetch
src/tools/built-in/recall-tool.test.ts:51:  createRoom: () => ({ kind: 'created' as const, room: undefined as unknown as Room }),
src/tools/built-in/recall-tool.test.ts:55:  getRoomConfig: () => undefined as unknown as RoomConfig,
src/tools/built-in/recall-tool.test.ts:64:} as unknown as House)
src/tools/built-in/geo-tools.test.ts:258:      const e = r as unknown as { candidates: Array<{ id: string }> }
src/llm/providers-setup.ts:67:    gateways.ollama = ollama as unknown as ProviderGateway
src/llm/ollama.ts:119:    if ((request as unknown as Record<string, unknown>).keepAlive !== undefined) {
src/llm/ollama.ts:120:      body.keep_alive = (request as unknown as Record<string, unknown>).keepAlive
src/llm/openai-compatible.ts:212:  out[out.length - 1] = tail as unknown as T
src/llm/provider-gateway.test.ts:79:    gw.updateConfig({ maxConcurrent: undefined as unknown as number })
src/llm/system-wiring.test.ts:172:    const houseCallbacks = (system.house as unknown as { /* accessing via llm */ })
src/llm/provider-monitor.test.ts:22:      return id as unknown as ReturnType<typeof setTimeout>
src/core/triggers/scheduler.test.ts:75:      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
src/core/triggers/scheduler.test.ts:77:      house: { getRoom: () => room as any } as any,
src/core/triggers/scheduler.test.ts:97:      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
src/core/triggers/scheduler.test.ts:99:      house: { getRoom: () => room as any } as any,
src/core/triggers/scheduler.test.ts:118:      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
src/core/triggers/scheduler.test.ts:120:      house: { getRoom: () => room as any } as any,
src/core/triggers/scheduler.test.ts:148:      team: { listAgents: () => [agent as any], getAgent: () => agent as any } as any,
... (64 total)
```

## 4. Dependency cycles + boundaries (dependency-cruiser)
```
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/house.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/geodata.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/documents.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/bugs.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/bookmarks.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/agents.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/http-routes.ts → 
      src/api/routes/agents-memory.ts →
      src/api/routes/types.ts →
      src/main.ts →
      src/bootstrap.ts →
      src/api/server.ts →
      src/api/http-routes.ts
  error no-circular: src/api/agent-tracking.ts → 
      src/main.ts →
      src/bootstrap.ts →
      src/api/agent-tracking.ts

x 71 dependency violations (65 errors, 6 warnings). 604 modules, 1434 dependencies cruised.

```

## 5. Dead exports (knip)
```
Resolving dependencies
Resolved, downloaded and extracted [2]
Saved lockfile
Unused files (103)
.dependency-cruiser.cjs: .dependency-cruiser.cjs
experiments/cli.ts: experiments/cli.ts
experiments/examples/ablation.ts: experiments/examples/ablation.ts
experiments/examples/hello-world.ts: experiments/examples/hello-world.ts
experiments/examples/two-agent-debate.ts: experiments/examples/two-agent-debate.ts
experiments/examples/zero-agent-reset.ts: experiments/examples/zero-agent-reset.ts
experiments/examples/zero-agent-subprocess.ts: experiments/examples/zero-agent-subprocess.ts
experiments/examples/zero-agent.ts: experiments/examples/zero-agent.ts
scripts/streaming-probe.ts: scripts/streaming-probe.ts
skills/knowledge-base/tools/kb_ingest.ts: skills/knowledge-base/tools/kb_ingest.ts
skills/knowledge-base/tools/kb_lint.ts: skills/knowledge-base/tools/kb_lint.ts
skills/knowledge-base/tools/kb_query.ts: skills/knowledge-base/tools/kb_query.ts
skills/skill-builder/tools/generate_tool_code.ts: skills/skill-builder/tools/generate_tool_code.ts
src/tools/__fixtures__/_helper.ts: src/tools/__fixtures__/_helper.ts
src/tools/__fixtures__/invalid-bad-name.ts: src/tools/__fixtures__/invalid-bad-name.ts
src/tools/__fixtures__/invalid-no-execute.ts: src/tools/__fixtures__/invalid-no-execute.ts
src/tools/__fixtures__/multi-tool.ts: src/tools/__fixtures__/multi-tool.ts
src/tools/__fixtures__/single-tool.ts: src/tools/__fixtures__/single-tool.ts
src/tools/__fixtures__/throws-on-import.ts: src/tools/__fixtures__/throws-on-import.ts
src/ui/input.css: src/ui/input.css
src/ui/lib/format-retry.ts: src/ui/lib/format-retry.ts
src/ui/modules/agent-inspector.ts: src/ui/modules/agent-inspector.ts
src/ui/modules/agent-selection.ts: src/ui/modules/agent-selection.ts
src/ui/modules/app-dom.ts: src/ui/modules/app-dom.ts
src/ui/modules/app-thinking.ts: src/ui/modules/app-thinking.ts
src/ui/modules/app.ts: src/ui/modules/app.ts
src/ui/modules/auth.ts: src/ui/modules/auth.ts
src/ui/modules/icon.ts: src/ui/modules/icon.ts
src/ui/modules/identity-lookups.ts: src/ui/modules/identity-lookups.ts
src/ui/modules/inline-number.ts: src/ui/modules/inline-number.ts
src/ui/modules/map/api.ts: src/ui/modules/map/api.ts
src/ui/modules/map/fallback.ts: src/ui/modules/map/fallback.ts
src/ui/modules/map/icons.ts: src/ui/modules/map/icons.ts
src/ui/modules/map/index.ts: src/ui/modules/map/index.ts
src/ui/modules/mermaid/api.ts: src/ui/modules/mermaid/api.ts
src/ui/modules/mermaid/fallback.ts: src/ui/modules/mermaid/fallback.ts
src/ui/modules/mermaid/index.ts: src/ui/modules/mermaid/index.ts
src/ui/modules/message-header-prefs.ts: src/ui/modules/message-header-prefs.ts
src/ui/modules/modals/agent-detail-modal.ts: src/ui/modules/modals/agent-detail-modal.ts
src/ui/modules/modals/bug-modal.ts: src/ui/modules/modals/bug-modal.ts
src/ui/modules/modals/context-modal.ts: src/ui/modules/modals/context-modal.ts
src/ui/modules/modals/detail-modal.ts: src/ui/modules/modals/detail-modal.ts
src/ui/modules/modals/geodata-import-modal.ts: src/ui/modules/modals/geodata-import-modal.ts
src/ui/modules/modals/geodata-modal.ts: src/ui/modules/modals/geodata-modal.ts
src/ui/modules/modals/instances-modal.ts: src/ui/modules/modals/instances-modal.ts
src/ui/modules/modals/logging-modal.ts: src/ui/modules/modals/logging-modal.ts
src/ui/modules/modals/packs-modal.ts: src/ui/modules/modals/packs-modal.ts
src/ui/modules/modals/providers-modal.ts: src/ui/modules/modals/providers-modal.ts
src/ui/modules/modals/scenarios-list-modal.ts: src/ui/modules/modals/scenarios-list-modal.ts
src/ui/modules/modals/scripts-list-modal.ts: src/ui/modules/modals/scripts-list-modal.ts
src/ui/modules/modals/skill-detail-modal.ts: src/ui/modules/modals/skill-detail-modal.ts
src/ui/modules/modals/skills-list-modal.ts: src/ui/modules/modals/skills-list-modal.ts
src/ui/modules/modals/system-prompt-modal.ts: src/ui/modules/modals/system-prompt-modal.ts
src/ui/modules/modals/tool-detail-modal.ts: src/ui/modules/modals/tool-detail-modal.ts
src/ui/modules/modals/tools-list-modal.ts: src/ui/modules/modals/tools-list-modal.ts
src/ui/modules/model-select.ts: src/ui/modules/model-select.ts
src/ui/modules/models-popover.ts: src/ui/modules/models-popover.ts
src/ui/modules/ollama-dashboard.ts: src/ui/modules/ollama-dashboard.ts
src/ui/modules/panels/bookmarks-panel.ts: src/ui/modules/panels/bookmarks-panel.ts
src/ui/modules/panels/geodata-panel.ts: src/ui/modules/panels/geodata-panel.ts
src/ui/modules/panels/logging-panel.ts: src/ui/modules/panels/logging-panel.ts
src/ui/modules/panels/packs-panel.ts: src/ui/modules/panels/packs-panel.ts
src/ui/modules/panels/providers/api.ts: src/ui/modules/panels/providers/api.ts
src/ui/modules/panels/providers/index.ts: src/ui/modules/panels/providers/index.ts
src/ui/modules/panels/providers/row.ts: src/ui/modules/panels/providers/row.ts
src/ui/modules/panels/script-doc-panel.ts: src/ui/modules/panels/script-doc-panel.ts
src/ui/modules/panels/script-panel.ts: src/ui/modules/panels/script-panel.ts
src/ui/modules/panels/summary-panel.ts: src/ui/modules/panels/summary-panel.ts
src/ui/modules/panels/triggers-panel.ts: src/ui/modules/panels/triggers-panel.ts
src/ui/modules/prompt-model-editors.ts: src/ui/modules/prompt-model-editors.ts
src/ui/modules/prompt-toggles.ts: src/ui/modules/prompt-toggles.ts
src/ui/modules/prompt-toggles/context-group.ts: src/ui/modules/prompt-toggles/context-group.ts
src/ui/modules/prompt-toggles/index.ts: src/ui/modules/prompt-toggles/index.ts
src/ui/modules/prompt-toggles/model-group.ts: src/ui/modules/prompt-toggles/model-group.ts
src/ui/modules/prompt-toggles/prompts-group.ts: src/ui/modules/prompt-toggles/prompts-group.ts
src/ui/modules/prompt-toggles/shared.ts: src/ui/modules/prompt-toggles/shared.ts
```

## 6. Largest source files
```
   45889 total
     982 src/main.ts
     876 src/ui/modules/app.ts
     798 src/bootstrap.ts
     793 src/llm/router.ts
     740 src/agents/ai-agent.ts
     679 src/llm/openai-compatible.ts
     674 src/tools/built-in/pack-tools.ts
     656 src/agents/context-builder.ts
     609 src/core/storage/snapshot.ts
     601 src/core/instances/system-registry.ts
     559 src/core/scripts/script-runner.ts
     504 src/llm/provider-monitor.ts
     478 src/agents/evaluation.ts
     476 src/core/render-validators/map-schema.ts
     455 src/ui/modules/agent-inspector.ts
```
