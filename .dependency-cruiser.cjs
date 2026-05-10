// Dependency-cruiser config for Samsinn — boundary + cycle rules.
//
// Lives at repo root so `bunx dependency-cruiser src` picks it up automatically.
// Boundaries reflect the codebase layering documented in CLAUDE.md.

module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make code hard to reason about and break tree-shaking.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'ui-must-not-import-core-internals',
      severity: 'error',
      comment: 'UI talks to backend via HTTP/WS. Direct imports of core/* runtime modules bypass the API contract. Pure type modules (anything named types.ts or under core/types/) are fine — they cross the boundary as type information only, not runtime code.',
      from: { path: '^src/ui/' },
      to: {
        path: '^src/core/',
        pathNot: ['^src/core/types/', '/types\\.ts$', '/render-validators/', '/scripts/script-md-parser\\.ts$'],
      },
    },
    {
      name: 'core-must-not-import-ui',
      severity: 'error',
      comment: 'Core domain logic must not depend on the UI layer.',
      from: { path: '^src/core/' },
      to: { path: '^src/ui/' },
    },
    {
      name: 'mcp-must-not-import-ui',
      severity: 'error',
      comment: 'MCP server is host-facing; it shares core but never UI.',
      from: { path: '^src/integrations/mcp/' },
      to: { path: '^src/ui/' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Orphaned modules (nothing imports them) are usually dead code. Loaders, entrypoints, and tests are exempt.',
      from: {
        orphan: true,
        pathNot: [
          '\\.test\\.ts$',
          '\\.d\\.ts$',
          '^src/index\\.ts$',
          '^src/main\\.ts$',
          '^src/bootstrap\\.ts$',
          '^src/integrations/mcp/server\\.ts$',
          '^src/integrations/mcp/tools/',
          '^src/tools/built-in/',
          '^src/api/routes/',
          '^src/api/ws-commands/',
          '^src/skills/',
          '^src/packs/',
          '^src/ui/main\\.ts$',
          '^src/ui/dist\\.css',
        ],
      },
      to: {},
    },
  ],
  options: {
    // false → cycle detection ignores type-only imports.
    // We confirmed during the spike (.health/spike-results.md) that cycles
    // remain real even with this off — they're runtime imports through
    // main.ts↔bootstrap.ts↔api/server.ts. Keeping false reduces noise so
    // the report focuses on cycles that actually affect runtime behavior.
    tsPreCompilationDeps: false,
    doNotFollow: {
      path: 'node_modules',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    tsConfig: { fileName: 'tsconfig.json' },
  },
}
