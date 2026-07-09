---
name: doc-maintenance
description: >-
  The repeatable process for CREATING or UPDATING this codebase's tiered docs (docs/ — L0 LLM_MAP, L1
  READMEs, L2 deep-dives, domain docs). Invoke to write or update the docs for a SPECIFIC area/module after
  its code changed, to document a newly-added area, or to run a per-area drift/audit fix. (For first-time
  setup of an UNDOCUMENTED project, or a whole-repo stale-docs cleanup/consistency pass, start with the
  `docs-init-or-improve` skill — it assesses state and bootstraps the convention, then hands back to this
  process.) You act as an ORCHESTRATOR: dispatch sub-agents (cheap model explores → mid model
  verifies+writes → strong model audits), never read/edit doc or code files yourself, pass file PATHS
  between agents, verify every claim against the codebase (the code is the source of truth), then lint,
  commit, and push. Pair with the `codebase-context` skill (wayfinding/drift detection) — that one tells
  you WHERE things are; this one is HOW to write the docs about them.
---

# Doc Maintenance — orchestrator process

This is the process used to build out `docs/` to full L0/L1/L2 coverage. Re-use it to keep docs current
or to document a new surface. **The codebase is always the source of truth (L3); when a doc disagrees
with code, the code wins and the doc is corrected.**

Read `docs/STRUCTURE.md` (the tier scope contract) and start at `docs/LLM_MAP.md` (L0). Tier folders
mirror the **codebase's own structure** — follow the code's own `repo → project → subfolder` layout, not
an imposed backend/frontend split (do not invent `Backend_docs`/`Frontend_docs`). **Mirror substantive
folders only** — skip `Properties`/`bin`/`obj`/`Log`/generated/vendored/static-asset dirs. Mirror **where
the structure carries meaning**: a code folder earns its own `README.md` (an L1) only when there is real
cross-cutting synthesis to write across its children. Do **NOT** spawn a synthesis-less stub README for a
tiny leaf folder just to complete the mirror — that regresses into the file inventory an L1 must not be
(see the Tier contract). A deep, namespace-mirroring tree wants nested per-subfolder L1s; a flat or
shallow tree wants fewer, higher L1s.

## You are the ORCHESTRATOR (hard rules)

The point is to **conserve your own context** so the work can run for many iterations.

1. **Do NOT read or edit codebase or doc files yourself.** Plan, dispatch agents, pass paths, run version
   control and the linter. That is your whole job. (Small allowed exception: ticking a checklist line.)
2. **All sub-agents write working output to `./temp/docwork/<area>/<aspect>.md`** (gitignored scratch).
   **You NEVER read agent-generated files** — not in `temp/`, not in `docs/`. You pass PATHS only.
3. **Agent roles & model tiers** (use the cheapest model that can do each job):
   - **Cheap/fast model → explore.** Cheap, broad. Inventory a folder/module, trace a pattern, map consumers.
   - **Mid model → verify + write.** Verify explorer notes against code, resolve conflicts, write the
     L1/L2 docs into the correct `docs/` location, update L0 links, tick the checklist, refresh memory.
   - **Strong model → audit, sparingly.** Drift-detect finished docs against code; reserve for high-stakes
     or security-sensitive surfaces, or a final pass. Have the mid model fix whatever the audit flags.
4. **Fan out explorers IN PARALLEL** (one message, multiple Agent calls): typically one for the
   inventory, one for the dominant pattern/abstraction, one for cross-module consumers/data-lineage.
   Richer raw material → better synthesis at the write step.
5. **Surface INTRICATE CROSS-CUTTING knowledge**, not just per-folder inventories: multi-store flows,
   shared contracts, data lineage across modules/integrations.
6. **Tell every agent to consult the existing docs first** (`docs/LLM_MAP.md` + any already-written
   L1/L2 for the area and adjacent areas). The docs are a mature navigation aid now — they orient
   agents faster, let new docs cross-link, and surface doc↔code drift. The code still wins on conflict.
7. **When explorers report conflicting facts** (e.g. differing counts), the writer MUST resolve
   the conflict against code and report the resolution. Multiple agents agreeing is NOT proof.
8. **Writers run SEQUENTIALLY by default; only readers fan out in parallel.** Disjoint *file* ownership
   stops two writers clobbering the same file, but **not** two writers documenting the same cross-cutting
   concept from different angles. So dispatch writer/integrator agents **one at a time**, each told to read
   what prior writers just published and **LINK rather than re-document**; let the agent that owns
   `docs/LLM_MAP.md` and `docs/STRUCTURE.md` go **LAST** so its links resolve to docs that already exist.
   (Rule 4 parallelizes *explorers/verifiers* — they only read code / write disjoint scratch, so they
   can't concept-clobber.) **Only if speed forces it** should you parallelize writers — and then enforce
   strictly **disjoint** file/subtree ownership (exactly one owner for `LLM_MAP.md`/`STRUCTURE.md`),
   accepting the residual concept-overlap risk that sequencing would have removed.
9. **When control returns to you, the sub-agent is DONE — nothing further is coming.** A dispatch has no
   follow-up "finished" message; twice-observed failure: the orchestrator stalled mid-flow "waiting for
   the writer/auditor to confirm" after that agent had already completed. Never wait. Confirm the output
   exists at the expected path cheaply (a file listing, the linter, `git status` — not by reading
   contents, per rule 2) and dispatch the next step immediately.
10. **All agent↔agent communication routes through YOU.** Sub-agents cannot reply to each other —
   peer-to-peer messages fail (no agent ID to address) and the reply dead-ends. A writer answering an
   auditor's finding (or vice versa) does it by writing to its temp/doc files; you dispatch the
   counterpart with the PATHS. Brief every agent accordingly: output goes to files plus a short summary
   back to you — never "reply to the auditor/writer".

## Per-iteration recipe

1. **Pick the next area** — one L1 area, or a batch of L2s within it. (When building from scratch, work
   down the module list; when maintaining, pick what the code change touched — see STRUCTURE.md's
   "you touched … → update …" table.)
2. **Explore** — dispatch parallel explorers (per rule 4) → `temp/docwork/<area>/*.md`.
3. **Verify + write** — dispatch writer agent(s) that read the explorers' temp paths, verify against
   code, write the L1 README and/or L2 docs into the correct tier location, and fold in any relevant
   legacy/scattered content. Pass the temp PATHS; never paste contents.
4. **Audit (occasionally)** — dispatch a strong-model auditor (→ temp) for drift; the writer fixes flagged items.
5. **Wire it up** — a sub-agent updates `docs/LLM_MAP.md` L0 links, ticks the `CLAUDE.md` checklist
   (adding any newly-discovered modules/sources/surfaces as new items), and refreshes `MEMORY.md`.
6. **Lint, commit, push** — run the link linter, then commit the `docs/` changes and push the branch.

> **Optional power-tool.** For a deterministic, repeatable version of this explore → verify → integrate →
> audit loop, a reference **Workflow** script ships with this skill at
> `workflows/document-tiered-docs.workflow.js` (next to this `SKILL.md`; see `workflows/README.md`) —
> run one cycle per invocation (1 = inventory, 2 = deepen, 3 = mirror-restructure, 4 = audit) and review
> the digest between runs. The prose process here is the canonical description; the Workflow is an
> adapt-don't-run-blind reference (it is harness-specific — read and adapt it, don't run it unmodified).

## Small-update path (lean mode)

For a SMALL, localized docs update — a handful of lines across one or two existing docs, no new surface,
no cross-cutting flow change (e.g. a status flip, a renamed field, a corrected count) — the full
explorer→writer→auditor chain costs more than it protects, and skipping the skill entirely is worse.
Use this instead:

1. **Dispatch ONE mid-model agent** briefed with: the code change (absolute paths), the doc(s) to update,
   and the instruction to act as its own auditor — verify every falsifiable claim it writes against code
   with `file:line` citations *before* writing it.
2. **You run the link linter** (must report 0 broken), then commit and push per the Git rules below.

State explicitly that you chose the lean path and why. **Escalate to the full chain** the moment the change
grows: a new surface to document, more than ~2 docs touched, cross-cutting/data-lineage content, or any
security-relevant claim.

## Audit cycle (the L0 → L1 → L2 → L3 walk)

When auditing finished docs (a periodic pass, or before a release), run it as a dedicated cycle on the
**strong model** (`opus`) — consistent with the "strong model → audit" rule above. Each auditor starts at
`docs/LLM_MAP.md`, walks the link chain down into its assigned slice, and checks three axes:

- **NAVIGATION** — L0 routes to the correct L1, each L1 routes to its proper L2s, and every link resolves.
- **COHERENCE** — each L2 aligns with its L1 (no contradictions; the L1 genuinely generalizes its L2s).
- **ACCURACY** — every falsifiable L2 claim verifies against L3 code with a `file:line` citation.

Auditors run in parallel (they only read docs/code and write disjoint fix-lists). They **write fix-lists
to `temp/`; they do NOT edit docs.** Then **sequential** disjoint-ownership fixers (mid model, per rule 8)
apply only the fixes within their owned files, **re-verifying each flagged item against L3 first** —
auditors miscount and fabricate too, so a fix-list is a lead, not a fact.

## Verification gate — the link linter

Before committing, run the **bundled** Markdown link linter (catches broken cross-references and stray
folder links). It ships with this skill at `scripts/doc_lint.py` — a `scripts/` folder next to this
`SKILL.md`. **Locate that script, then run it**, passing the docs root(s) as arguments. To find it: the
`${CLAUDE_SKILL_DIR}` substitution resolves to this skill's directory if your runtime expands it;
otherwise Glob for `**/doc-maintenance/scripts/doc_lint.py`. Call it with an absolute path (don't rely on
the working directory):

```
py      "<skill-dir>/scripts/doc_lint.py" docs            # Windows (python launcher)
python3 "<skill-dir>/scripts/doc_lint.py" docs            # macOS/Linux
py      "<skill-dir>/scripts/doc_lint.py" docs api/docs   # several docs roots in one run
py      "<skill-dir>/scripts/doc_lint.py" docs --strict   # also fail on in-docs directory links
```

(`<skill-dir>` = the located absolute path, e.g. the value of `${CLAUDE_SKILL_DIR}`. With no path argument
it defaults to `./docs`.) The linter must report **0 broken** links → exit 0. Links into the codebase
(relative paths to source files) are validated like any other path. Treat "in-docs dir links" warnings as
a nudge to point at a specific `.md`.

## Tier contract (quick reference — full version in docs/STRUCTURE.md)

- **L0** (`docs/LLM_MAP.md`): one-sentence purpose per system + link to its code folder/L1. No code,
  no signatures, no change history.
- **L1** (`docs/<Area>/README.md`): **cross-cutting SYNTHESIS that generalizes across the area's L2s** —
  the sub-system's purpose, the shared concepts, and how the pieces fit together (the data/control flow
  tying them). It is **NOT** a bare file inventory; a one-line-per-file list belongs at most as a
  secondary aid. Links to L2. No per-method docs.
- **L2** (`docs/<Area>/<Thing>.md`): the specific workings of ONE thing in depth, where "thing" may be a
  project, a complicated system/flow, an important function, a concept, an architecture/view, **or a data
  layer** (an ORM/EF model, a SQL schema, how the DB works, a specific table/context) — responsibilities,
  signatures, request/response shapes, invariants, edge cases, gotchas. No marketing, no remediation
  opinions (document what IS). Use inline date markers: `(observed YYYY-MM-DD)` / `(decided YYYY-MM-DD)`.
- **L3**: the code. Source of truth.

## Git / publishing rules

- Work on a dedicated docs branch (e.g. **`docs/codebase-documentation`**, off the default branch).
  Commit + push each iteration.
- **NEVER open a PR.** Publish the branch only.
- Follow the repo's commit-message convention (e.g. an agreed `Co-Authored-By:` trailer if the team uses one).
- `CLAUDE.md`, `temp/`, and most local-only config are typically gitignored. **Watch for exceptions:** the
  shared skills under `.claude/skills/` are often tracked (via `.gitignore` negation rules) so the team gets
  them, while everything else under `.claude/` (incl. machine-local settings) stays local. `docs/` is tracked.
  Confirm the repo's actual ignore rules before assuming.

## Hard-won lessons (don't relearn these)

- **Explorers fabricate and miscount.** Real examples caught only because the writer/auditor re-checked code:
  invented version/compat numbers, wrong table/job/data-context counts, "subsystem X is dormant" (it actually
  runs live), a phantom config field, omitted folders, dead-code retry policies presented as live. **Verify
  every falsifiable claim (counts, names, versions, "non-functional" / "build-excluded" / "feature-flagged-off"
  assertions) against code with a file/line citation.**
- **Security claims need extra conservatism.** State what the code does, with citations; never add
  remediation advice or exaggerate. (When a code path looks security-relevant but disabled/removed, document
  it as such only after verifying it independently and having a strong-model audit confirm.)
- **Domain glossary cautions — do not regress.** Domain terms and acronyms are easy to mis-define from their
  name alone (a name can suggest the opposite of what the code does). Verify each ambiguous term against its
  actual usage in code, and record the confirmed meaning so it isn't re-guessed next pass. Never infer a
  term's meaning from the name when the code can tell you.
- **Fold in & deprecate legacy docs**, don't duplicate: absorb evergreen content into the L2s, drop
  gate-log/planning cruft, and put a deprecation banner on the legacy artifact pointing to its new home.
- **Layer nuance:** the same concept can behave differently in different layers — e.g. one layer joins across
  data stores directly while another materializes in memory then writes, or one path is transactional while a
  parallel one is eventually-consistent. Keep these layers distinct in any data-lineage writing rather than
  collapsing them into one claim.
- **Pass ABSOLUTE paths to sub-agents.** A sub-agent's working directory is not guaranteed to match yours,
  and repo paths may contain spaces — give every agent absolute paths for both the code it reads and the
  `temp/`/`docs/` files it writes, rather than relying on a CWD it may not share.

## Relationship to the other skill

`codebase-context` is for **wayfinding and drift detection** (where does X live, walk
L0→L1→L2→L3, flag drift). Invoke it at the start of any task. **This** skill is the **production
process** for writing/updating the docs once you know what needs documenting. Use them together.
