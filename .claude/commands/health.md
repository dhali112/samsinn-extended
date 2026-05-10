---
description: Run the Samsinn codebase health audit (delta vs baseline, suppressions applied, finding-disposition table)
---

Invoke the `health-audit` skill on the current state of the codebase. Follow its full flow: read state, decide whether to re-run `bun run health`, compute delta vs baseline, filter against `.health/suppressed.md`, cross-check `CLAUDE.md` rejected-refactors, present the finding-disposition table, and ask the user via AskUserQuestion which findings to act on this session.
