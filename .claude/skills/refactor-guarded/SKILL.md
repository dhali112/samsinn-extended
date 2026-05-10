---
name: refactor-guarded
description: Lightweight speed-bump for refactors that match the rejected-refactors list in CLAUDE.md (Samsinn project). Greps for known-rejected patterns; on match, prints a one-line warning with line-pointer into CLAUDE.md. NOT a gate — does not block, does not require justification. Just a friction reminder so future Claude sessions don't silently re-propose rejected work. Trigger keywords:/refactor, "refactor", "extract", "split createSystem", "replace lateBinding", "event bus", "consolidate", "MCP/REST parity", "artifact system".
---

# Refactor Speed-Bump

> **First-time setup:** project-local skills are loaded at Claude Code session start. If this skill doesn't fire on rejected-pattern keywords right after pulling this repo, **restart Claude Code** to register.

Lightweight pattern check before proposing or implementing a refactor. Encodes the discipline of CLAUDE.md's `## Rejected refactors` section so it survives across sessions.

## What this skill does

1. Match the user's refactor request against rejected patterns. The patterns:
   - "replace lateBinding" / "event bus" / "pub/sub for system"
   - "extract createSystem" / "split createSystem into phases" / "boot phase functions"
   - "MCP/REST parity" / "tool surface unification" / "audit MCP vs REST tools"
   - "revive artifacts" / "artifact system" / "workspace pane" / "task list pane" / "polls" / "shared documents"
2. On match, print a one-line warning with the file/line of the rejection in CLAUDE.md.
3. Suggest: "If you have new evidence (a real bug, a second consumer, a measurable benefit), invoke `claude-toolbox:stress-test` to evaluate. Otherwise, leave it alone."

## What this skill does NOT do

- Does NOT block the refactor. The user can override.
- Does NOT require written justification.
- Does NOT log the override.
- Does NOT critique the refactor on its merits (that's stress-test's job).
- Does NOT cover refactors not on the rejected list (those proceed normally).

## Implementation

Read `CLAUDE.md`, locate the `## Rejected refactors` section. For each bullet:
- Extract the headline phrase (e.g. "Replacing `lateBinding` in `main.ts` with an event bus").
- Match the user's request against the headline + body keywords.

Print:

```
⚠️  This refactor matches a rejected pattern in CLAUDE.md:36+

   "<headline of the matched bullet>"

   Per CLAUDE.md: revisit only if you can demonstrate a *significant* new
   benefit (a bug traced to the pattern, a second-consumer use case, a
   measurable performance/correctness gain).

   If you have such evidence: run `claude-toolbox:stress-test` next.
   Otherwise: leave this alone.
```

Then continue with normal flow. The user decides whether to proceed.

## Why a speed-bump and not a gate

The rejected list is human judgment, not algorithmic. A gate that demanded written justification would either:
- get rubber-stamped (everyone clicks "yes I have evidence" without thinking), or
- become bureaucracy that gets bypassed.

A one-line warning with a CLAUDE.md pointer forces a 5-second pause and re-read. That's enough for an honest "oh right, that's why" without becoming friction theater.
