<!--
  TEMPLATE — copy to docs/STRUCTURE.md and adapt to THIS repo.
  Fill every <FILL IN …> marker. Keep the tier DEFINITIONS verbatim: the codebase-context and
  doc-maintenance skills key off them, so they must not drift. Delete THIS comment after adapting.
  Leave the separate `<!-- INSTALL: citation-conventions section ... -->` marker further down alone —
  it is replaced mechanically by the shared install procedure (docs-init-or-improve STEP 2A / docs-migrate
  STEP 1), never by hand.
-->

# Documentation structure & scope contract

This file is the **scope contract** for this repo's docs. It defines the documentation tiers, how the doc
tree mirrors the code, and which docs to update when code changes. Read it before writing or auditing docs.

> **Code is the source of truth (L3).** When a doc disagrees with the code, the code wins and the doc is
> corrected. Docs drift; surfacing that drift is part of the job.

## The tiers

- **L0** — `docs/LLM_MAP.md`: a one-sentence purpose per system + a link to its code folder / L1. No code,
  no signatures, no change history. The index you start from.
- **L1** — `docs/<Area>/README.md`: **cross-cutting SYNTHESIS that generalizes across the area's L2s** — the
  sub-system's purpose, the shared concepts, and how the pieces fit together (the data/control flow tying
  them). It is **NOT** a bare file inventory; a one-line-per-file list belongs at most as a secondary aid.
  Links to its L2s. No per-method docs. Create an L1 for a folder **only when there is real cross-cutting
  synthesis to write** — do not spawn a synthesis-less stub README just to complete the mirror.
- **L2** — `docs/<Area>/<Thing>.md`: the specific workings of ONE thing in depth, where "thing" may be a
  project, a complicated system/flow, an important function, a concept, an architecture/view, **or a data
  layer** (an ORM/EF model, a SQL schema, a table/context) — responsibilities, signatures, request/response
  shapes, invariants, edge cases, gotchas. Document what IS (no marketing, no remediation opinions). Use
  inline date markers: `(observed YYYY-MM-DD)` / `(decided YYYY-MM-DD)`.
- **L3** — the code. Source of truth.

## How the doc tree mirrors the code

Doc folders mirror the **codebase's own** `repo → project → subfolder` structure **where that structure
carries meaning** — no imposed `Backend_docs`/`Frontend_docs` split. **Mirror substantive folders only:**
skip `Properties`/`bin`/`obj`/`Log`/generated/vendored/bulk-static-asset directories. A deep,
namespace-mirroring tree wants nested per-subfolder L1s; a flat or shallow tree wants fewer, higher L1s.

### This repo's substantive areas (<FILL IN>)

| Code path | Doc home (L1) | What it is |
|-----------|---------------|------------|
| `<FILL IN e.g. src/Api>` | `docs/<Area>/README.md` | <FILL IN one line> |
| `<FILL IN>` | `docs/<Area>/README.md` | <FILL IN> |

## "You touched … → update …" (maintenance routing)

When code changes, update the docs it invalidates. Adapt these rows to this repo's real layout:

| You touched … | Update … |
|---------------|----------|
| A public entry point / route / handler in `<FILL IN>` | that area's L1 + the relevant L2; add an L0 entry if it's a new system |
| A data model / schema / migration in `<FILL IN>` | the data-layer L2 for that store |
| A cross-cutting flow spanning modules | every L2 on the flow + the L1 that synthesizes it |
| Added a whole new module/area | a new L1 (if synthesis warrants), its L2s, and an L0 link |

<!-- INSTALL: citation-conventions section installed here by docs-init-or-improve/docs-migrate at
scaffold/migration time — see assets/doc-conventions/STRUCTURE-citation-section.template.md -->

## Doc workflow (how these docs get written and kept honest)

- **Set up / clean up the whole repo's docs** → the `docs-init-or-improve` skill (assess → bootstrap → route).
- **Write or update docs** (per area or a full cycle) → the `doc-maintenance` skill (explore → verify → write
  → audit → lint → commit). The code is always the source of truth.
- **Navigate / detect drift** ("where does X live", "how does X work", "is it safe to change X") → the
  `codebase-context` skill.
- **Verification gate:** the Markdown link linter must report **0 broken** links before committing.

## Git / publishing

- Work on a dedicated docs branch (e.g. `docs/codebase-documentation`) off the default branch; commit + push
  each iteration. **Do not open a PR** — publish the branch. Follow the repo's commit-message convention.
- `temp/` (doc-work scratch) and local-only config are gitignored; `docs/` is tracked.
