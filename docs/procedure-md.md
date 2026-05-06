# Procedure Markdown (procmd) — structured procedural knowledge in wikis

Procmd is a markdown convention for storing procedural knowledge — emergency
operating procedures, cockpit checklists, conduct-of-operations manuals, IT
runbooks — as wiki pages that are simultaneously **human-readable**,
**LLM-authorable**, and **machine-traversable** as a guardrail.

Single source of truth: the same markdown document is what a human reads,
what an LLM author writes, and what a parser converts into a step graph an
agent can walk one step at a time. There is no separate "logic language."

Procmd lives **inside existing samsinn wikis** as a convention. A wiki page
is a procedure when its frontmatter declares `type: procedure`. Procedures
can cross-reference each other via standard wikilinks; the resulting page
graph is a hypertext of procedures linked to procedures.

## Status

This document specifies **procmd v0.1** — the format. Samsinn-side runtime
support (executor tool, agent guardrail traversal, render integration) is
out of scope for v0.1; see [Deferred](#deferred--out-of-scope-for-v01) at
the bottom.

## Semantic model

Procmd's primitives come from PROforma, a clinical-guideline modeling
language developed at Cancer Research UK. A procedure decomposes into four
task primitives:

| Primitive | What it is | Procmd surface |
|---|---|---|
| **Plan** | Composite container with sub-tasks, ordering, lifecycle conditions | The procedure itself; nested sub-steps |
| **Decision** | Choice point with candidate branches and rationale | A step whose body lists `→` branches |
| **Action** | Effector — does something in the world | A step body using `Action:` |
| **Enquiry** | Gathers data | A step body using `Check:` |

Each step has a **lifecycle**: dormant → in-progress → completed | discarded.
Transitions are driven by `When:` (precondition for entry), `Until:`
(completion condition), and `Abort-if:` (abort condition).

The primitive of a step is **inferred from its keywords**. When inference
is ambiguous — typically when a step both gathers data and decides — an
explicit `[<primitive>]` tag in the step heading disambiguates.

## File format

A procedure page has YAML frontmatter, an H1 title (free-form), and one
or more `## Step` headings. Cross-references between steps and between
procedures use standard `[[wikilinks]]`.

### Frontmatter

```yaml
---
type: procedure
procedure-md: 0.1
procedure-id: E-0
title: Reactor Trip or Safety Injection
profile: nuclear-erg
applies-to: Westinghouse 4-loop PWR
---
```

| Field | Required | Meaning |
|---|---|---|
| `type` | yes | Must be `procedure` (or `procedure-profile` for a profile page) |
| `procedure-md` | yes | Spec version. Validators reject mismatched versions |
| `procedure-id` | yes | Stable identifier for cross-page references. Must match the page filename (without `.md`) |
| `title` | yes | Human-readable title; rendered as the page H1 if no separate H1 is provided |
| `profile` | no | Domain profile name (a `type: procedure-profile` page); enables domain synonyms |
| `applies-to` | no | Free-text scope (model, system, audience). Surfaced to readers/agents as context |

Additional unknown frontmatter fields are preserved as page-level
annotations and not errors.

### Step structure

```markdown
## Step <label> [id: <stable-id>]
```

- `<label>` is presentation only — `1`, `3.a`, `3.b.1`, `Continuous` all valid.
- `[id: <stable-id>]` is the **stable identifier** used by all
  cross-references. IDs must be unique within a page. Required.
- Optional primitive tag: `[id: verify-rx-trip, decision]`. Tags:
  `decision`, `action`, `enquiry`, `plan`. Use only when keyword inference
  is ambiguous.

Sub-steps use `### Step <label> [id: <id>]`. They are part of the parent
step's Plan and inherit its lifecycle.

### Body keywords

Each step body is plain markdown. Specific keyword-prefixed lines have
defined semantics:

| Keyword | Primitive role | Meaning |
|---|---|---|
| `Check:` | Enquiry | Gather or verify state |
| `Action:` | Action | Imperative effect — perform this |
| `When:` | lifecycle | Precondition for entry |
| `Until:` | lifecycle | Completion condition (loop exit, plan done) |
| `Abort-if:` | lifecycle | Abort condition |
| `Within:` | advisory | Time bound. Advisory in v0.1 — logged on miss, not enforced |
| `Concurrent: <name>` | Plan ref | Spawn sub-Plan in parallel. Default lifecycle: scoped to parent (terminates with parent). Use `Concurrent: <name> [independent]` for monitors that outlive the parent (CSF status trees) |
| `Caution:` | annotation | Operator-facing warning. Renders as a `!!! warning` admonition |
| `Note:` | annotation | Operator-facing note. Renders as a `!!! note` admonition |
| `Because:` | argumentation | Argument for the most recent branch (rationale) |
| `Against:` | argumentation | Argument against the most recent branch |

**Open-annotation fallback.** Any unknown `Foo: value` line is preserved
as a step annotation, surfaced to the agent as context, and ignored by
the traversal logic. New domains add metadata without spec changes.

**Admonition equivalence.** `Caution:` and `Note:` may be written as
MkDocs-style admonitions (`!!! warning` / `!!! note` blocks); the parser
recognizes both forms.

### Branches (Decision primitive)

A step that branches lists candidates as markdown list items containing
`→` (Unicode right-arrow, `U+2192`). A `-` list item is a branch *iff* it
contains `→`. Items without `→` are step content.

```markdown
## Step 1 [id: verify-rx-trip]
Check: reactor trip breakers OPEN AND rod bottom lights LIT
- Verified → #verify-turbine-trip
  Because: rapid neutron flux decrease confirmed
- Not verified → manually open breakers, then → [[FR-S.1]]
  Because: must establish subcriticality before any other action
```

Branch target syntax:

| Form | Meaning |
|---|---|
| `→ #<step-id>` | Same-page step (renders as standard markdown anchor) |
| `→ [[<page>#<step-id>]]` | Step in another procedure |
| `→ [[<page>]]` | Other procedure, enter at first step |
| `→ END` | Procedure terminates here |

Wikilinks accept display text: `[[E-3|Establish Heat Sink]]` — the target
is used for resolution, the display text is presentation.

`Because:` and `Against:` lines under a branch attach rationale. Rationale
is *unweighted* in v0.1 — agents reason over it as soft context. Weighted
argumentation (`Because (strong):`) is forward-compatible to v0.2.

### Profiles

A profile is a wiki page with frontmatter `type: procedure-profile` that
declares domain-specific synonyms. Loaded when a procedure sets
`profile: <name>` in its frontmatter.

```markdown
---
type: procedure-profile
procedure-md: 0.1
profile-id: nuclear-erg
title: Nuclear Emergency Response Guidelines profile
---

# Nuclear ERG profile

## Synonyms

- `RNO:` ≡ negative branch of the immediate Decision
  (Westinghouse "Response Not Obtained" two-column convention)
- `CSF:` ≡ `Concurrent: <name> [independent]`
  (Critical Safety Function — runs from event entry through recovery,
   does not terminate with the EOP)
```

Profiles let domains layer vocabulary on top of the core spec without
core changes. The base spec stays small; domains add what they need.

## The single-source-of-truth invariant

Any proposed addition to the spec must pass this test: **a domain expert
who has never seen the parser must be able to write the value naturally
and have it parse**. Keyword names are English; values are prose.

```yaml
When: reactor trip OR safety injection actuated     # ✅ passes — natural
When: { OR: [{ event: "trip" }, { event: "si" }] }  # ❌ fails — code leak
```

The parser cares about structural keywords. Values are prose, semantic
interpretation is the agent's job (or a tool call's, for numeric guards).
This is what keeps procmd from drifting into YAML-in-markdown.

## Validation

A procmd validator checks **structural** correctness, not semantic
correctness. Semantic checks ("does this step actually handle the case
the source branch claims") are LLM-driven and out of scope for v0.1
validation gates — they may exist as advisory passes but never block.

A v0.1 validator must check:

- Frontmatter shape and required fields
- `procedure-md:` version matches the validator's `SUPPORTED_SPEC_VERSION`
- Step heading shape; stable IDs unique within a page
- Body keyword recognition (unknown keywords → annotations, not errors)
- Branch syntax: every `→` resolves to bare fragment, wikilink, or `END`
- Cross-page link resolution: target page exists in the corpus; target
  step ID exists in the target page
- Reachability: orphan steps (no branch reaches them); branches whose
  targets are unreachable in their own page
- Profile resolution: declared synonyms are recognized

A reference validator for the `pwr-eops` corpus lives in that repo as
`validate.ts` (~400–500 LOC, single file, no dependencies, runs under
Bun).

## Versioning

Every procedure page declares its spec version in frontmatter. Validators
declare `SUPPORTED_SPEC_VERSION` as a constant.

| Mismatch | Behavior |
|---|---|
| Page version `<` validator | Validator may accept with migration warning, or reject. Implementation choice |
| Page version `>` validator | Validator must reject. Newer spec features may be unrecognized |
| Page version `==` validator | Validator processes the page |

v0.1 → v0.2 migration is planned to be **lossless** for documents authored
against v0.1 — additions are additive (e.g. `Because (strong):` parenthetical
weights), and v0.1 documents remain valid v0.2 documents.

## Authoring guidance

- **Stable IDs are forever.** Once a step has `[id: verify-rx-trip]`,
  renaming it breaks every cross-reference. Use kebab-case slugs that
  describe the step's purpose, not its position.
- **Step labels are presentation.** `## Step 3.a` is fine; the label is
  not the identity. Cross-references never use the label.
- **Branches need conditions.** `- Verified → #step-2` reads naturally;
  `- → #step-2` is malformed (no condition). The condition is what an
  agent or operator evaluates.
- **`Because:` and `Against:` belong under the branch they justify.** They
  attach to the most recent branch list item.
- **Concurrent is for monitoring, not parallelism.** Use `Concurrent: <name>`
  to spawn a status-tree-style background Plan. Do not use it to decompose
  one logical step into fan-out work — that's just sub-steps.
- **Don't pre-flatten branches into prose.** "If X then go to step 4,
  otherwise step 5" is a Decision in prose — author it as a branch list
  so the parser sees the structure.
- **Profile or no profile.** Procedures without a `profile:` field are
  fully valid; profiles are for domain-specific synonyms only.

## Example: a minimal procedure

```markdown
---
type: procedure
procedure-md: 0.1
procedure-id: example-engine-restart
title: Engine Restart After In-Flight Shutdown
profile: aviation-qrh
---

# Engine Restart After In-Flight Shutdown

## Step 1 [id: confirm-shutdown]
Check: affected engine N1 < 10% AND throttle at IDLE
Caution: confirm correct engine before any action
- Confirmed → #attempt-restart
- Not confirmed → identify correct engine; if uncertain → [[engine-fire-checklist]]

## Step 2 [id: attempt-restart]
Action: ENGINE START switch — IGN/START
Within: 30s of stable airspeed
- Started (N1 increasing, EGT rising within limits) → #stabilize
- Not started → #abandon-restart
  Because: continued attempts risk hot start damage

## Step 3 [id: stabilize]
Action: monitor N1 to idle, EGT within limits
Until: stable idle for 60s
- Stable → END
- Unstable → #abandon-restart

## Step 4 [id: abandon-restart]
Action: ENGINE START switch — OFF
Note: continue single-engine operations
→ END
```

## Deferred / Out of scope for v0.1

The following are deferred to v0.2 or later. They are listed here so the
spec doc is the single source of truth for "what's next":

### Samsinn-side runtime
- **Procedure executor as agent tool.** `procedure_start(name)` /
  `procedure_step(branch)` API. Agent only sees current step + valid
  branches (the actual guardrail).
- **Procedure parse cache.** In-memory, event-driven invalidation on
  `wiki_changed` (avoids the b660b3e cache-of-derived-state bug class).
- **Render integration.** Samsinn UI rendering of `[[wikilinks]]` and
  same-page anchors when displaying a procedure page in chat or panel.
- **`samsinn-handbook` wiki.** A wiki holding the rendered procmd spec
  (generated from this doc) plus general samsinn introspection content,
  linked at agent startup so agents can look up procmd semantics.

### Validation enhancements
- **Graph-level semantic checks.** Does the target step actually handle
  the case the source branch claims? LLM-driven, advisory only — never
  a blocking validation gate.
- **Multi-version corpus validation.** Validating a corpus where some
  pages are at v0.1 and others at v0.2.

### Spec extensions
- **Weighted argumentation (level c).** `Because (strong):` /
  `Because (weak):` parenthetical weights, with a defined recommendation
  rule. Lossless promotion from v0.1 — v0.1 `Because:` lines remain
  valid as "unweighted."
- **Hard time-bound enforcement.** `Within:` becomes enforceable rather
  than advisory. Requires a clock source the agent can query.
- **`By: <role>` role assignment.** Operator vs supervisor vs agent —
  needed for ATC ConOps and CRM-style procedures. Available now via
  open-annotation fallback if a domain needs it.
- **Enquiry keyword synonyms.** `Observe:` / `Ask:` as core variants of
  `Check:`. v0.1 has `Check:` only; profiles can add synonyms.
- **Mermaid auto-generation.** Render the step graph of a procedure as
  a Mermaid flowchart for visual review.

### Tooling and ecosystem
- **`llm-wiki-skills` extension.** A new `wiki-procedure` skill in
  [llm-wiki-skills](https://github.com/michaelhil/llm-wiki-skills) that
  authors a procedure page from a `raw/` source. Quality-rule extension
  in `wiki-check.ts` to invoke the procmd validator. Page-type recipe
  registry in `wiki-init` so procedures are first-class at init.
- **Profile mechanism generalization.** Cross-wiki shared profiles
  (e.g. a `aviation-qrh` profile reused across multiple aviation-domain
  wikis). Currently each wiki carries its own profile pages.
- **Validator distribution.** The reference validator currently lives
  per-wiki. If samsinn ships a procedure executor, the same parser must
  serve both — distribution model TBD (npm/jsr package, copied file with
  CI sync, or shell-out to samsinn).

### Acknowledged debt
- **LLM-authored procedure correctness.** Structural validation (parser
  green) does not imply operational correctness. For high-stakes
  domains, a human-review workflow on top of the validator is needed.
  The pwr-eops demo wiki ships disclaimer-only; future production
  procedural wikis will need more.

---

*procmd v0.1 — last reviewed 2026-05-06.*
