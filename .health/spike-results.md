# Tool spike results

Run: $(initial)

| Tool | Verdict | Notes |
|---|---|---|
| **type-coverage** | ✅ keep | strict + ignore-catch → 98.61% (84510/85695). Threshold set to 98.0% in health.sh (small headroom). |
| **dependency-cruiser** | ✅ keep | Glob pattern required: `src/**/*.ts` (directory `src` cruises 0 modules — known dep-cruiser quirk with TS-only directories). With config: 604 modules, 74 violations on first run (68 circular through main.ts↔bootstrap.ts↔api/server.ts; 6 orphan warns). Cycles look like type-only imports flagged because tsPreCompilationDeps=true; will tune in baseline. |
| **knip** | ✅ keep, noisy | ~50 unused type exports + 1 duplicate-export pair (createOllamaGateway/createLLMGateway in gateway.ts — they're aliases). Most type unused-exports are part of public-shape type modules; expect to add to suppression. |
| **escape-hatch grep** | ✅ keep | Trivial baseline check. |
| **eslint sonarjs cognitive-complexity** | ⏸ deferred | Requires eslint config/parser bootstrap. Two-tool overlap with dep-cruiser orphan + knip dead-code reports already covers the "what's heavy" question for now. Revisit if drift signal emerges. |

## Working invocations

```bash
bunx -y type-coverage@latest --strict --ignore-catch --at-least 98
bunx -y dependency-cruiser@latest "src/**/*.ts" --output-type err
bunx -y knip@latest --reporter compact
grep -rnE '@ts-(ignore|expect-error|nocheck)|\bas any\b|as unknown as' src/
```

## Findings to fold into baseline (NOT to fix in Phase 1)

- **74 dep-cruiser cycles**: most appear to route through main.ts↔bootstrap.ts. May be artifacts of tsPreCompilationDeps=true picking up type-only imports as cycles. Worth re-running with `tsPreCompilationDeps: false` to confirm. If real, that's a future structural finding for a separate audit pass.
- **~50 knip unused exports**: largely public-shape types. Suppress in `.health/suppressed.md` after first review.
- **Duplicate export gateway.ts**: `createLLMGateway` is documented as an alias for `createOllamaGateway` in CLAUDE.md ("createLLMGateway kept as alias"). Suppress.

Phase 1A: PASSED. Moving to 1B.
