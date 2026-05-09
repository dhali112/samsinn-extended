# Scenarios — security model and known debt

## Threat model summary

Scenarios are markdown documents that drive setup ops + UI guidance against
a live System. Two attack surfaces matter:

1. **Share-link → run**: any visitor can land on `?scenario=<id>` and the
   scenario will execute against their cookie-bound instance.
2. **`install-pack` op**: a scenario can install a pack from a remote git
   source — which dynamically `import()`s the pack's tools/*.ts. That is
   remote code execution under the server process's privileges.

## Mitigations in v1

- **Per-instance isolation.** Scenario runs operate on the cookie-bound
  House. They cannot create or mutate other tenants' rooms / agents.
- **One run per instance.** The runner refuses concurrent runs in the same
  instance with `another scenario is running…`. This prevents two share-
  links from interleaving.
- **Pack-install consent gate.** The `install-pack` op throws unless the
  caller passed `allowInstall: true` on `POST /api/scenarios/:pack/:name/run`.
  The UI sets this flag only after the user has explicitly accepted a
  consent dialog showing the source URL of the pack to be installed.
  Anonymous visitors that just want to RUN a scenario referencing already-
  installed packs do NOT need to accept any install consent — only the
  install side-effect is gated.
- **Scenario discovery only from already-installed packs.** The catalog
  endpoint `GET /api/scenarios` lists scenarios from installed packs +
  bundled synthetic packs (welcome). Discovery does not fetch the remote
  pack registry — pack discovery is a separate, user-driven flow under
  `/api/packs/registry`.
- **Abandonment timeout.** Awaiting runs (`guide-tooltip` with `waitFor`)
  are auto-stopped after 30 minutes of inactivity. Tab-close also drops
  the run via instance eviction (`stopAll()` in scenario-runner is called
  from `system-registry.evictOne`).
- **Parse-time name resolution.** Every `room:` / `as:` reference is
  validated against earlier `create-room` / `spawn-agent` declarations.
  Typos surface at scenario load, not mid-run.
- **Size cap.** Scenario source is rejected above 256 KB
  (`MAX_SCENARIO_SOURCE_BYTES` in `store.ts`).

## What v1 explicitly does NOT cover

These are known limits — flagged here so they're visible to a future
hardening pass.

### Host-global pack install

Packs live under `~/.samsinn/packs/` (process-wide). When visitor A's
scenario installs `aviation`, visitor B and every other tenant gain that
pack on disk. The pack-install consent dialog gates the *install*; it
cannot make the install per-tenant. If you need per-tenant pack scoping,
that's a packs-system change, not a scenarios-system change.

### Scenario versioning

A share-link `?scenario=aviation/vatsim-tour` resolves to whatever the
locally-installed `aviation` pack ships today. If the pack repo updates
the scenario, every share-link silently uses the new version. There is
no `?scenario=aviation/vatsim-tour@v1` pinning.

Acceptable for v1 because pack repos under the canonical `samsinn-packs`
org are operator-curated and updates are expected to be backwards-
preserving. Revisit when third-party pack distribution becomes common.

### Trust boundary on pack contents

Once a pack is installed (with consent), every tool .ts file under its
`tools/` directory is dynamically imported at module-load time. A
malicious pack can run arbitrary code in the server process. The same
threat exists today for direct `POST /api/packs/install` — scenarios
don't expand the surface, they just give it a more discoverable
entry point. Mitigation is operator discipline (only allow-list trusted
pack registries via `SAMSINN_PACK_SOURCES`).

### `start-script` polling

The `start-script` op blocks the scenario until the script ends, polled
at 250 ms intervals with a 30 min hard ceiling. A long-running script
that never reports `script_completed` will pin the scenario run for the
full window. Future: subscribe to `script_completed` event directly.

## Quick reference

| Risk | Mitigation |
|---|---|
| Anonymous visitor runs a scenario | Cookie-bound instance isolation |
| Anonymous visitor installs a pack | Consent dialog (UI sets `allowInstall: true`) |
| Two scenarios race in one tenant | One-run-per-instance refusal |
| Awaiting run leaks on tab close | Instance eviction triggers `stopAll()` |
| Awaiting run leaks on tab idle | 30 min abandonment timer |
| Typo in scenario .md | Parse-time name resolution |
| Oversized .md DoS | 256 KB cap |
