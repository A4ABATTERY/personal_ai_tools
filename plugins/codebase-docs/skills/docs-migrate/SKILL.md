---
name: docs-migrate
description: >-
  Migrates an existing tiered-docs repo from an OLD `file.ext:NN` line-cite convention (no frontmatter, no
  lint) to the codebase-docs plugin's citation convention (`path § symbolName` symbol cites + `covers`/
  `related`/`status` frontmatter + an installed lint + drift-status tooling). Invoke once per repo when the
  tiered docs convention (`docs/LLM_MAP.md`, `docs/STRUCTURE.md`) already exists but its citation style is
  the old line-number form, or when asked to "migrate the docs to the new convention", "convert line-cite
  docs to symbol cites", or "upgrade this repo's doc lint". `docs-init-or-improve` routes here automatically
  once it detects the old convention on an otherwise-documented repo. Starts with a STEP 0 assessment that
  can and should conclude "zero migration work needed" if the repo is already on the new convention (do not
  skip this step or assume work is required). For a genuinely undocumented repo, use `docs-init-or-improve`
  instead — it bootstraps the new convention from scratch, so there is nothing to migrate.
---

# Docs migrate — convert an existing repo onto the citation + frontmatter + lint convention

You are converting one repo's tiered docs from an old, line-number-based citation style (or no citation
convention at all) onto this plugin's `§ symbolName` convention, `covers`/`related`/`status` frontmatter,
and an installed, CI-wireable lint + drift-status tool. **Always start with STEP 0** — a repo already on
the new convention needs zero work, and STEP 0 is how you find that out cheaply instead of assuming.

Relationship to the other two skills: `docs-init-or-improve` is the whole-repo front door that routed you
here (it decides bootstrap-from-scratch vs. migrate-existing); `doc-maintenance` is the production process
you fold this migration's *writing* work into once the convention itself is installed (frontmatter/citation
maintenance on every future doc touch is `doc-maintenance`'s job going forward, not this skill's).

---

## STEP 0 — Assess (the dry-run — do this FIRST, every time)

Cheap, mechanical checks — **never** "does this script's bytes match our template" (the shipped engine is a
generic, parameterized asset by design; a byte-diff against a repo-tuned reference implementation would be
a false negative). Locate the shared assets first (see "Locating the shared assets" below).

1. Glob `docs/LLM_MAP.md` + `docs/STRUCTURE.md`. If either is missing, this isn't this skill's job — route
   back to `docs-init-or-improve` STEP 2A. This is also the graceful-degradation point for a flat-corpus /
   non-tiered `docs_layout` repo: both this skill and the lint/drift tools are premised on the tiered
   `docs/<Area>/README.md` + `docs/<Area>/<Thing>.md` shape with a `covers`-bearing frontmatter contract:
   route away cleanly rather than forcing that shape onto a flat corpus.
2. Grep `docs/STRUCTURE.md` for a "Doc-citation conventions" section (or the ` § ` separator literally) —
   confirms the convention is *documented*.
3. For every `.md` directly inside each directory named in `docs/STRUCTURE.md`'s "substantive areas" table:
   confirm it opens with a `---` frontmatter block containing non-empty `covers`, a `related` list, and
   `status` in `{current, historical}`. **Count across all** — a spot-check that "most" have it is not
   sufficient; the goal is a complete sweep, since "zero migration work" requires zero exceptions.
4. Regex-sweep those same directories for the OLD `` `file.ext:NN` `` shape — every hit must resolve to a
   row in the target repo's own exceptions TSV (discover its actual path from whatever lint script is
   already installed, or from `docs/STRUCTURE.md`'s own convention-section text — don't assume a fixed
   path).
5. Confirm SOME lint script performing the equivalent checks (cite-resolves, symbol-exists,
   frontmatter-well-formed, exception-freshness, heading-anchor) is present **and green when run** —
   equivalence of *behavior*, not identity of *source text*. If the installed lint is materially weaker
   (e.g. missing the heading-anchor check), that is itself migration work — a scoped, targeted upgrade
   (re-run STEP 1's install), not a blocker to declaring the citation convention itself already compliant.
6. **Installed-asset currency check**, covering all three shared assets. If a `doc-cite-config.json` with a
   `_pluginAssetVersion` field is found, compare it against the shipping plugin's own `plugin.json` version.
   Separately, grep `docs/STRUCTURE.md` for the
   `<!-- codebase-docs-plugin-asset-version: ... (STRUCTURE-citation-section.template.md) -->` stamp
   (installed per STEP 1's splice procedure) and compare its version the same way. Either check finding a
   version older than the shipping plugin folds into **one** distinct finding —
   `"installed doc-conventions assets are stale (installed vX, plugin now vY)"`, naming which asset(s)
   specifically. This is orthogonal to the citation-convention compliance verdict: an outdated-but-still-
   convention-compliant install is not "migration work" in the citation-format sense, but is an actionable
   upgrade (minimum remedial action: re-run STEP 1's install/splice, which will re-copy the two scripts and
   re-splice the STRUCTURE.md section since its stamp will read stale — no in-place diffing/patching of an
   installed copy is attempted in v1).
7. **Verdict:** if checks 1–5 all hold, STOP and report **"zero migration work needed — repo already on the
   new convention"** (this exact phrase), listing the evidence for each of 1–5, plus check 6's currency
   finding if applicable (currency staleness never blocks this verdict — it's an orthogonal, additional
   finding). If any of 1–5 fail, list precisely which docs/directories need which of STEP 1–5's work,
   ordered **smallest-first** by ascending old-style-cite count per file (convert the easy files first to
   build confidence in the lint before tackling the hardest ones).

## Locating the shared assets

The lint engine, drift tool, config/exceptions templates, `STRUCTURE.md` citation-section template, and
`HANDOFF.template.md` all live in this plugin's shared `assets/doc-conventions/` folder (a plugin-level
folder, sibling to `skills/`, not owned by any one skill). Locate it via a path relative to **this skill's
own directory** — every skill already knows this (`${CLAUDE_SKILL_DIR}`): from
`skills/docs-migrate/`, the shared folder is two levels up then into `assets/doc-conventions/` —
`${CLAUDE_SKILL_DIR}/../../assets/doc-conventions/<file>`. If your runtime doesn't expand
`${CLAUDE_SKILL_DIR}` as expected, fall back to a `Glob` for `**/assets/doc-conventions/<file>` (this
fallback intentionally never names this plugin's own folder — same coupling strength as this plugin's
existing skill-to-skill-by-name references, not a new, wider one; the tradeoff is that in a marketplace
with a second, unrelated same-named `assets/doc-conventions/` folder the fallback could match the wrong
plugin's copy — accepted as a named, rarely-exercised limitation rather than re-introducing a hardcoded
plugin-name coupling).

## STEP 1 — Install the lint + config + exceptions template (before any doc edits)

Copy three files from the shared asset folder into the target repo:

1. **`check-doc-cites.mjs`** — installed **verbatim, byte-for-byte, never hand-edited** into the target
   repo's script directory. Choose that directory with this rule: (a) if a `doc-cite-config.json` already
   exists with `_scriptInstallDir` set, use that value — this IS the override surface, never re-decide once
   present; (b) otherwise, if a `scripts/` directory already exists at the repo root, use it; (c) otherwise,
   create `scripts/`. Before writing, replace the file's `{{PLUGIN_ASSET_VERSION}}` placeholder (in its
   header comment) with the shipping plugin's own version string — a mechanical, literal substitution, not
   a hand-edit of the script's logic.
2. **A freshly generated `doc-cite-config.json`** (not the bare template) — read `docs/STRUCTURE.md`'s
   "substantive areas" table to fill `scopedDocDirs`; set `docsRoot` to this repo's actual docs root; detect
   `headingSlugAlgorithm` by checking `git remote get-url origin` for a `github.com` host (if the remote is
   absent, unrecognized, or not GitHub, set `"none"` and print a one-line note — never silently default to
   `"github"` and risk false-positive reports on a non-GitHub repo); leave `extraDeclarationPatterns: []`
   unless STEP 2's decision-tree walk discovers a repo-specific declaration shape that needs one (see STEP
   2, rule with the escape hatch); record the chosen script directory into `_scriptInstallDir`; record the
   shipping plugin's version into `_pluginAssetVersion`.
3. **The exceptions TSV** — copy `doc-cite-exceptions.template.tsv` (header row only) to the same script
   directory, unless one already exists there (don't clobber real exception rows on a re-run).

Also splice the citation-conventions section into `docs/STRUCTURE.md` (see "Installing the STRUCTURE.md
citation-conventions section" below) if it doesn't already carry a current-version stamp for it.

Run the lint once, locally, against the CURRENT (pre-conversion) tree — expect it to fail loudly
(frontmatter missing, old-style cites everywhere). This is the sanity check that the engine's regex/parsing
behaves sanely against the target repo's *real* file shapes before any doc edits start depending on it.

### Installing the STRUCTURE.md citation-conventions section

This is a **mechanical, byte-for-byte, idempotent splice** — never an agent re-typing/paraphrasing the
prose. Read `STRUCTURE-citation-section.template.md`'s raw bytes; locate the exact marker string
`<!-- INSTALL: citation-conventions section installed here by docs-init-or-improve/docs-migrate at
scaffold/migration time — see assets/doc-conventions/STRUCTURE-citation-section.template.md -->` in the
target `docs/STRUCTURE.md`; replace that substring with the template's raw content verbatim; write the
result back. Immediately following the spliced section, insert one HTML comment generated from the same
`_pluginAssetVersion` value used for the scripts (never hand-maintained separately):
`<!-- codebase-docs-plugin-asset-version: X.Y.Z (STRUCTURE-citation-section.template.md) -->`.

**Idempotency** — before splicing, check for the marker string's presence:
- **Marker present** → not yet installed (or the marker was manually restored) → perform the splice.
- **Marker absent AND the version-stamp comment present** → already installed → no-op, report "citation-
  conventions section already installed (see stamp for version)."
- **Marker absent AND no version-stamp comment present** → an ambiguous state (someone hand-edited
  `STRUCTURE.md` and removed both) — do NOT silently re-insert a second copy; report this as a finding
  requiring human review.

If the target repo's `docs/STRUCTURE.md` doesn't carry the marker at all (e.g. it predates this plugin's
STEP 2A scaffold), append the spliced section near the end of the file (after any "You touched … → update
…" maintenance-routing section, before a closing "Git / publishing" section if one exists) rather than
failing — report where you placed it.

## STEP 2 — The decision tree (convert citations, one file at a time)

**Before anything else, search the target repo's docs for existing `§` usage** —
`grep -rc '§' <docs root>` — a repo may already use `doc.md § "quoted phrase"` as a pre-existing,
unrelated cross-reference idiom. Confirm this collision doesn't exist (or, if it does, document both
conventions side-by-side per the template's structure) before assuming `§` is free to use as a fresh
separator.

For every old-style citation found (smallest file first, per STEP 0's ordering):

1. **Named symbol already in the sentence** → `(file.ext § symbolName)`, collapsing multiple line numbers
   for the same symbol to one anchor.
2. **Multi-symbol/range cite** → a comma-separated list of independently-verifiable anchors, never a
   re-invented numeric range.
3. **Method/handler inside a component/class/scope** → dot form (`path.ext § Outer.inner`).
4. **JSON/YAML file with a stable key** → key-path anchor (`config.json § scripts["build"]`), bracket-
   quoting any key containing `:`/`-`.
5. **True line-only target (no stable anchor)** → leave the literal `` `file.ext:NN` `` form, add one
   exceptions-TSV row with a one-sentence reason — **never invent a fake anchor**.
6. **Not a citation at all** (port number, ratio, timestamp, version string) → untouched, no exception row,
   out of scope.
7. **Quoted-phrase carve-out** — `doc.md § "quoted phrase"` is a distinct doc-section cross-reference
   convention (see the search step above): excluded from conversion and from symbol-existence checks.

If, while converting a real citation, the target symbol is a real, stable, named "thing" that doesn't match
any of the lint's built-in per-language declaration keywords, that's the trigger to add one
`extraDeclarationPatterns` entry to `doc-cite-config.json` — not to invent a fake anchor and not to
silently over-broaden a built-in regex.

**Every conversion is spot-verified against current code** before being written (open the target file,
confirm the symbol still exists and still means what the sentence claims) — this is the invariant that
keeps reformatting from *re-introducing* drift; the easiest step to skip under time pressure, and the one
most likely to go wrong when skipped.

**Fix inbound heading anchors in the SAME pass** as any heading rewrite triggered by this conversion
(rewriting a heading's text changes its rendered anchor slug — run the lint's heading-anchor check and fix
every link it flags before moving to the next file, not as a separate follow-up).

**Per-file commits**: one file's citations + frontmatter in ONE commit, lint re-run after each (must only
ever show fewer un-converted/unexcepted cites, never more — an increase means stop and fix before
continuing).

## STEP 3 — Thin the L0 map (verify-before-delete)

Read the L0 (`docs/LLM_MAP.md`) entry for an area side-by-side with its L2 docs. Confirm every discrete
claim in the L0 entry already exists in an L2 (by symbol/date/section, not skim) — relocate anything
missing into the L2 **before** cutting it from L0. Then replace the L0 entry with an 8–20-word one-liner +
link. Do this LAST among the doc-edit steps, after all L2 frontmatter/citations are final (thinning should
point at stable, already-final anchors, not ones still in flux).

## STEP 4 — Context-budget handoff (for large corpora)

On a large migration, write a handoff artifact **proactively** when context usage crosses a rough threshold
— not "when you run out." Copy `HANDOFF.template.md` from the shared assets and fill it in: what's done vs.
mid-flight (explicit about which is which), remaining work in sequencing order, a `git log` reference for
the range covered so far, a "learned conventions" section for repo-specific quirks discovered mid-run (the
exact kind of thing `extraDeclarationPatterns` entries get sourced from), and gotchas. One artifact per
handoff, written outside the repo tree (job/task scratch dir — never committed). A fresh instance picking
up a handoff reads it in full before touching any file, and self-corrects any status claim in it against a
live `git log` rather than trusting it — the same "verify, don't trust a status ping" discipline
`doc-maintenance`'s own hard-won-lessons section already applies to auditor fix-lists.

## STEP 5 — Wire CI, seed → RED → revert → GREEN

Locate the target repo's CI config (e.g. `.github/workflows/*.yml`, or whatever the repo actually uses —
**do not assume GitHub Actions**; if no CI exists, say so and stop at "locally green," don't invent a CI
system). If a recognized CI system is present, add the lint as a step in the earliest sensible job, named
consistently with the repo's own step-naming convention. Seed one deliberately broken citation, capture the
FAIL transcript, revert, confirm GREEN — log both transcripts as the RED-proof.

If `headingSlugAlgorithm` was set to `"none"` at STEP 1 (non-GitHub remote), the RED-proof for the
heading-anchor check is naturally skipped (there's nothing to seed — the check is a no-op); the
seed→RED→revert→GREEN cycle instead targets a citation-symbol break, which is always applicable regardless
of forge.

## Known v1 limitations (state these explicitly, don't paper over them)

- The heading-anchor check's slug algorithm is GitHub-specific (`headingSlugAlgorithm: "github"`); a
  non-GitHub repo runs with it disabled rather than an unvalidated alternate slugger.
- `--follow` rename tracking (used by the drift tool) is a git heuristic, not a guarantee; directory
  renames or heavily-rewritten files can still break the chain.
- Doc directories are walked **non-recursively** in v1 (direct-child `.md` files only per `scopedDocDirs`
  entry); a repo with genuinely nested doc subdirectories lists each nested directory as its own config
  entry.
- No smart in-place upgrade/merge for an already-installed, locally-customized copy of the shared assets —
  STEP 0 check 6's currency signal exists, but the only remedial action in v1 is re-copy + re-splice.
