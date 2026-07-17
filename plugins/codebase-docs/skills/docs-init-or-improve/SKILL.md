---
name: docs-init-or-improve
description: >-
  The front door for WHOLE-REPO documentation work — use it the moment a user wants documentation set up
  or cleaned up across a project, not one specific area. Two entry conditions: (A) the project is
  UNDOCUMENTED — there is no tiered `docs/` tree yet (no `docs/LLM_MAP.md`, no `docs/STRUCTURE.md`) and docs
  must be established from scratch; or (B) docs EXIST but are STALE/INCONSISTENT and the user asks for a
  whole-repo cleanup, consistency fix, or full refresh that will end in committed doc changes (for
  read-only "is the doc tree consistent / where does it drift" detection without fixing, use
  `codebase-context`). This skill ASSESSES the current doc state,
  BOOTSTRAPS the tiered-docs convention (scaffolds `docs/STRUCTURE.md` + a seed `docs/LLM_MAP.md`) when
  starting from zero, then HANDS OFF to the `doc-maintenance` skill to run the actual explore→verify→write
  and audit→fix cycles. Invoke whenever the user says things like "document this app", "set up docs for
  this project", "there's no documentation", "the docs are out of date / inconsistent / a mess", "clean up
  the docs", "make the docs consistent", or "do a documentation consistency check". For writing/updating
  ONE specific area after a code change, use `doc-maintenance` directly instead; for "where does X live /
  how does X work / is it safe to change X" wayfinding, use `codebase-context`.
---

# Docs: initialise or improve — the whole-repo front door

You are the **router and bootstrapper** for a project's tiered documentation. The heavy lifting (writing
and auditing docs) belongs to the **`doc-maintenance`** skill — your job is to figure out *which* situation
you are in, do the one thing `doc-maintenance` assumes already exists (the convention scaffold), and then
hand off. Resist the urge to start writing docs yourself; that duplicates `doc-maintenance` and burns
context you'll want for orchestration.

The tier system you are setting up / keeping honest:
**L0** `docs/LLM_MAP.md` (one-line-per-system index) → **L1** `docs/<Area>/README.md` (cross-cutting
synthesis, *not* a file list) → **L2** `docs/<Area>/<Thing>.md` (one thing in depth) → **L3** the code
(source of truth). Doc folders mirror the **code's own** `repo → project → subfolder` structure.

---

## STEP 1 — Assess the current state (decides which branch you take)

Look before you leap. Run these checks (cheaply — a few globs and one git query):

1. **Is the tiered convention present?** Glob for `docs/LLM_MAP.md` and `docs/STRUCTURE.md`.
   - Neither exists → **UNDOCUMENTED → go to STEP 2A (Bootstrap).** (Pre-existing scattered `README`s or a
     `docs/` folder *without* `LLM_MAP.md`/`STRUCTURE.md` still counts as undocumented for the tier system —
     you'll fold that legacy content in during the write cycle, not treat it as the convention.)
   - Both exist, but `docs/STRUCTURE.md` has no "Doc-citation conventions" section / the docs use an old
     `file.ext:NN` line-cite style / docs have no `covers`/`related`/`status` frontmatter → the tiered
     convention exists but its citation style is the OLD one → **route to the `docs-migrate` skill instead
     of STEP 2B** (it runs its own STEP 0 assessment, which may itself conclude "zero migration work
     needed" if you mis-detected — that's fine, let it confirm).
   - Both exist, on the NEW citation convention, but otherwise stale/inconsistent → the convention is fully
     established → **go to STEP 2B (Improve)**, with the addition in STEP 2B below.
2. **How stale is it?** `git log -1 --format=%cd -- docs/` vs. recent code commits. A `docs/` that hasn't
   moved while code churned is a staleness signal worth reporting.
3. **Confirm scope with the user if it's large.** Whole-repo passes are expensive. If the codebase is big,
   say roughly how many substantive top-level areas you see and confirm they want the full pass (or a slice).

---

## STEP 2A — Bootstrap an undocumented project

`doc-maintenance` opens with *"Read `docs/STRUCTURE.md` … start at `docs/LLM_MAP.md`."* On a fresh repo those
don't exist — creating them is the **only** thing this skill does that `doc-maintenance` doesn't. Do exactly
this, then hand off:

1. **Scaffold the scope contract.** Copy the bundled template `assets/STRUCTURE.template.md` (next to this
   `SKILL.md`; locate via `${CLAUDE_SKILL_DIR}` or Glob for `**/docs-init-or-improve/assets/STRUCTURE.template.md`)
   to `docs/STRUCTURE.md`, then **adapt it to THIS repo**: fill in the actual substantive top-level folders
   (skip `bin`/`obj`/`Properties`/`Log`/generated/vendored/bulk-static-asset dirs) and the "you touched … →
   update …" maintenance table. Keep the tier definitions verbatim — the other two skills key off them, so
   they must not drift. The template carries an `<!-- INSTALL: citation-conventions section ... -->` marker
   comment — leave it as-is here; the next sub-step replaces it.
2. **Install the citation/frontmatter convention + its tooling, from the start.** A brand-new project should
   never begin on an old line-cite convention. Follow the **`docs-migrate`** skill's STEP 1 install procedure
   by name (same install logic — do not duplicate its prose here): install `check-doc-cites.mjs` +
   `doc-cite-config.json` (generated from THIS repo's own `docs/STRUCTURE.md` areas table, which you just
   filled in) + the exceptions TSV to the chosen script directory, and splice
   `STRUCTURE-citation-section.template.md`'s content into `docs/STRUCTURE.md` at the marker left in step 1
   above (mechanical marker-replace, per `docs-migrate`'s "Installing the STRUCTURE.md citation-conventions
   section" procedure). Since there are no docs yet to convert, there is no decision-tree conversion work to
   do here — new docs get written directly in the new convention by `doc-maintenance`'s normal write step.
3. **Seed the L0 index.** Create `docs/LLM_MAP.md` with a title and a short "what this is" line. Leave the
   per-system entries for the write cycle to fill — don't hand-write the whole map now.
4. **Do NOT pre-build empty `docs/<Area>/` folders or stub READMEs.** A synthesis-less stub README is exactly
   what an L1 must never be. Let `doc-maintenance` create each area's docs as it actually documents it.
5. **Hand off to `doc-maintenance`.** Invoke that skill to run the **inventory cycle** (its per-iteration
   recipe / the reference Workflow's cycle 1): parallel explorers → verify+write L1/L2 → wire up L0 links →
   lint → commit. You orchestrate; it executes.

The result of 2A is a repo that now satisfies `doc-maintenance`'s starting assumptions, with a verified
first-pass map — ready for the deepen/restructure cycles on later runs.

---

## STEP 2B — Improve / clean up stale or inconsistent docs

The convention already exists, so **do not rebuild it** — that's wasted work and risks laundering good docs
into worse ones. `doc-maintenance` already owns the consistency machinery (its **Audit cycle** walks
L0→L1→L2→L3 for NAVIGATION / COHERENCE / ACCURACY). Your value here is *scoping the cleanup and routing it*:

1. **Produce a short state report first** so the user sees the shape of the work before you spend on it. If
   `doc-drift-status.mjs` is installed (check the script directory named in `doc-cite-config.json`'s
   `_scriptInstallDir` field — a reliable machine-readable pointer, not an assumed path), run it and fold its
   `needsMaintenance`/`major` buckets into the state report as **leads**, still verified against code below —
   the tool narrows WHERE to look, it doesn't replace looking. Then use the `codebase-context` skill's
   grep-first protocol to surface, across the existing docs:
   - **Drift** — L2 claims that no longer match the code (`file:line`, doc-says vs. code-does).
   - **Gaps** — public surfaces / modules / entities with no L2, and L1 areas missing synthesis.
   - **Navigation/consistency breaks** — broken or stale L0→L1→L2 links, contradictory statements between docs.
2. **Hand off to `doc-maintenance`** to run the **Audit cycle** (strong-model auditors → fix-lists in `temp/`)
   then the **sequential disjoint-ownership fixers**, each re-verifying every flagged item against L3 first
   (auditors miscount and fabricate too — a fix-list is a lead, not a fact).
3. **Close on the verification gate.** Have `doc-maintenance` run its bundled link linter; it must report
   **0 broken** links before committing. Then commit + push the `docs/` changes (no PR — publish the branch).

If the "stale docs" are actually scattered/legacy and not in the tier system at all, treat it as a hybrid:
bootstrap the convention (2A) and tell the writers to **fold in & deprecate** the legacy content rather than
duplicate it.

---

## How this skill relates to the other two (stay in your lane)

- **`docs-init-or-improve`** (this one) — *whole-repo entry decision + cold-start scaffold.* Assess, bootstrap
  the convention if missing, then delegate. Lean by design; it points outward.
- **`doc-maintenance`** — *the production process.* Per-area and whole-repo explore→verify→write and
  audit→fix cycles, the orchestration rules, the linter. This skill calls into it; it does the real writing.
- **`codebase-context`** — *wayfinding + drift detection.* Where things live and where docs disagree with code.
  Use it for the STEP 2B assessment and any "where/how" question.
- **`docs-migrate`** — *citation-convention migration.* Converts a repo that already has the tiered `docs/`
  convention but an old line-cite citation style onto the `§ symbolName` + frontmatter + lint convention.
  STEP 1 above routes here automatically when it detects that state; this skill never does that conversion
  work itself.

Reference these by **name**, never by file path — the skills may sit at different paths in different repos.

## Why this exists (1 line)

`doc-maintenance` assumes the tiered-docs convention already exists and works per-area; a brand-new or
broadly-rotten repo needs a front door that decides *init vs. clean up*, lays the convention down once, and
then routes to the process that does the work — without re-implementing it.
