# contrib/tiered-docs-workflow

**Reference artifact — NOT bundled in the installed plugin.** This is a personal reference Workflow that
operationalizes the `codebase-docs` plugin's `doc-maintenance` prose process. Nothing here is wired into
`marketplace.json` or any `SKILL.md` — it is meant to be **read and adapted**, not installed or run blind
(it is harness-specific).

A generic, codebase-agnostic Workflow that operationalizes the `doc-maintenance` skill's prose process:

| File | What it is |
|------|------------|
| `document-tiered-docs.workflow.js` | A generic Workflow that runs one documentation cycle (scout → explore → verify → integrate, or audit → fix) over any repo, building a tiered `docs/` tree. |

> **Note: the linter ships with the plugin.** `doc_lint.py` lives at
> `plugins/codebase-docs/skills/doc-maintenance/scripts/doc_lint.py`, referenced from the skill's
> verification gate via `${CLAUDE_SKILL_DIR}`. The `## doc_lint.py` notes below are retained for context
> and apply to that shipped copy. The Workflow stays here as a reference artifact (harness-specific;
> adapt-don't-run-blind) and is intentionally **not** bundled inside the installed plugin.

---

## `document-tiered-docs.workflow.js`

A deterministic, repeatable driver for the cheap → mid → strong orchestration the
`doc-maintenance` SKILL.md describes in prose. Generalized from a battle-tested project-specific
script by replacing all hardcoded module topology with a **SCOUT phase**.

### How it works

Workflow scripts have **no filesystem access**, so the script cannot list a repo's folders itself.
Instead:

1. **Scout** — a cheap-model agent inventories the repo's module/subfolder tree and returns it as
   *structured output*: a JSON list of substantive folders `{ path, role, weight }` (trivial,
   generated, vendored, and bulk-static-asset dirs excluded). On cycle 1 the manifest is persisted to
   `temp/docwork/_manifest/structure.json`; later cycles **reuse** it so topology and ownership stay
   stable across cycles.
2. **Derive topology deterministically** — pure functions (no `Math.random`, no `Date.now`) turn the
   sorted manifest into: one **explorer** per substantive folder, one **verifier/integrator group**
   per project, and a **disjoint** partition of project subtrees across N integrator owners. Exactly
   one owner (index 0) additionally owns `LLM_MAP.md` + `STRUCTURE.md`.
3. **Run the cycle** — Explore (haiku, parallel) → Verify+draft (sonnet, parallel) → Integrate into
   `docs/` (sonnet) over disjoint subtrees, written **SEQUENTIALLY** so each writer reads what the prior
   ones just published and links instead of re-documenting (the `LLM_MAP`/`STRUCTURE` owner goes last so
   its links resolve); cycle 4 swaps in Audit (opus, parallel) → Fix (sonnet, sequential).

   **Why sequential writers?** Disjoint *file* ownership stops two writers touching the same file, but not
   two writers documenting the same cross-cutting concept from different angles. Sequencing + a read-prior
   instruction closes that gap. Explorers/verifiers stay parallel (they read code / write disjoint
   scratch), so most of the wall-clock parallelism is preserved. Every agent is also told to treat
   already-written docs as a **hypothesis to re-verify against code**, never as settled fact — so
   compounding across cycles speeds the work without laundering a prior cycle's mistakes into permanence.

### Cycle progression (bump `CYCLE_DEFAULT` each run)

| Cycle | Goal |
|-------|------|
| 1 | **Inventory** — broad, verified map; flat-ish drafts. |
| 2 | **Deepen** — signatures, shapes, invariants, gotchas; carve out L2s. |
| 3 | **Mirror-restructure** — migrate docs into a tree that mirrors the code repo→project→subfolder 1:1, with a README (L1) per mirrored folder and L2s inside. |
| 4 | **Audit + fix** — walk L0→L1→L2→L3 (navigation / coherence / accuracy) and apply fixes within disjoint owned files. |

### Configure before running

Edit the constants at the top (or pass `args`):

```js
const CYCLE_DEFAULT = 1                 // bump 1 → 2 → 3 → 4 before each run
const DATE_DEFAULT  = '2026-06-23'      // pass args.date; the runtime forbids Date.now()
const REPO_ROOTS_DEFAULT = [ 'C:/path/to/Repo' ]   // one or more absolute repo roots
const DOCS_DEFAULT  = ''                // defaults to <first repo>/docs
```

Optional `args` overrides: `cycle`, `date`, `repoRoots`, `docs`, `temp`, `roleTaxonomy`,
`scoutFanout`, `integratorCount`, and `manifest`. **Why an editable constant *and* an `args` override:**
in our harness `args` did not reliably inject for `scriptPath` runs, so the constant is authoritative and
the resolved values are `log()`-ged at startup for verification.

**`args.manifest` (recommended for cycles 2–4).** If you pass the scout manifest (the array of per-repo
`{ repoRoot, folders }` objects) as `args.manifest`, the script skips both the scout and the persisted-file
reload and derives topology straight from it. This is the robust way to keep ownership stable across
cycles — see the limitation below.

### Known limitation — manifest persistence/transcription

Workflow scripts have no filesystem access, so on cycle 1 the manifest is written and (on later cycles)
re-read **by a cheap agent**, by embedding/transcribing JSON through a prompt. Agents do not perfectly
reproduce large JSON blobs, and a corrupted manifest would skew the derived topology for cycles 2–4. The
durable workaround is the **`args.manifest` override** above: capture the manifest from the cycle-1 digest
and pass it straight back on subsequent cycles. (Multi-repo reload also fans out one loader agent per root,
since the structured-output schema represents only one repo at a time.)

`roleTaxonomy` lets a team inject their own classification vocabulary (e.g. *"classify each module as
PUSH / PULL / LISTEN"*); leave it empty for fully generic role inference.

### Operating notes (carried over from real runs)

- **Smoke-test on cycle 1** before trusting a multi-cycle run: confirm the model short-names
  (`haiku`/`sonnet`/`opus`) actually route, agents wrote to the expected temp paths, and the
  structured-output schemas returned cleanly.
- The orchestrator passes **PATHS** between agents and never reads code/doc files itself. Explorers
  write full findings to gitignored `temp/` and return only a 100–250-word summary + the temp path.
- **Sub-agents fabricate and miscount** — every verifier/auditor re-checks falsifiable claims (counts,
  names, routes, "dead/unused" assertions) against code with `path:line` citations. Agreement between
  explorers is not proof.
- Run the linter (now shipped at `plugins/codebase-docs/skills/doc-maintenance/scripts/doc_lint.py`)
  between/after cycles; it must report **0 broken** links before committing.

This file is a **reference artifact**: it is syntactically valid (`node --check` passes) and faithful
to the Workflow tool API, but is meant to be read and adapted, not necessarily run unmodified.

---

## `doc_lint.py`

_Now shipped at `plugins/codebase-docs/skills/doc-maintenance/scripts/doc_lint.py`; the usage below
applies to that copy (run it with the script's real path)._

Scans `<docs>/**/*.md`, extracts every markdown link, and verifies each relative target resolves to a
real file on disk (links into the codebase are validated like any other path). External links
(`http(s):`, `mailto:`, `tel:`, `#`, protocol-relative) are skipped.

```bash
python3 doc_lint.py                 # lint ./docs ; exit 1 if any broken link
python3 doc_lint.py path/to/docs    # a specific docs root
python3 doc_lint.py docs other/docs # several roots in one run
python3 doc_lint.py --strict        # also fail on in-docs links pointing at a directory
```

On Windows substitute `py` for `python3`. Exit code is non-zero when any link is broken (or, with
`--strict`, when an in-docs link points at a directory) — suitable as a pre-commit gate.

Generalized from the project-specific version by accepting the docs root(s) as arguments instead of
hardcoding `<script_dir>/docs`; the link-resolution logic is otherwise unchanged.
