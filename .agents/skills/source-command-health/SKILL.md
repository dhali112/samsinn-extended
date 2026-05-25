---
name: "source-command-health"
description: "Run the Samsinn codebase health audit (delta vs baseline, suppressions applied, finding-disposition table)"
---

# source-command-health

Use this skill when the user asks to run the migrated source command `health`.

## Command Template

Invoke the `health-audit` skill on the current state of the codebase. Follow its full flow: read state, decide whether to re-run `bun run health`, compute delta vs baseline, filter against `.health/suppressed.md`, cross-check `AGENTS.md` rejected-refactors, present the finding-disposition table, and ask the user via AskUserQuestion which findings to act on this session.
