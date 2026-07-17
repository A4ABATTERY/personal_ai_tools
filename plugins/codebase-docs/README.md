# codebase-docs

Four skills for working in a tiered-docs codebase. **They install together as one plugin and are
meant to be used together** — none is shipped on its own.

| Skill | Role |
|-------|------|
| **codebase-context** | *Wayfinding / drift detection.* Grep-first orientation that finds where things live, reuses existing patterns, and always reports code↔doc drift. Use at the start of substantive work. |
| **doc-maintenance** | *Production process.* Orchestrates sub-agents to create/update the tiered `docs/` (L0 `LLM_MAP.md` → L1 READMEs → L2 deep-dives), then lints and commits. |
| **docs-init-or-improve** | *Whole-repo front door.* Fires when a project is **undocumented** (bootstraps the tiered-docs convention from scratch) or its docs are **stale/inconsistent** and need a cleanup/consistency check. Assesses state, scaffolds `docs/STRUCTURE.md` + a seed `docs/LLM_MAP.md`, then hands off to `doc-maintenance`. |
| **docs-migrate** | *Migration.* Converts an existing tiered-docs repo from an old `file.ext:NN` line-cite convention to the `§ symbol` convention + frontmatter + lint. Invoke once per repo; `docs-init-or-improve` routes here automatically when it detects the old convention. |

**Why they're coupled:** `docs-init-or-improve` decides *init vs. clean up* and lays the convention
down once (routing to `docs-migrate` instead when an existing repo's citation style is the old one);
`doc-maintenance` builds and maintains the tiered docs structure (`docs/LLM_MAP.md`,
`docs/STRUCTURE.md`, the L0–L3 tiers); `codebase-context` navigates that structure and keeps it
honest. One sets up the front door, one converts a repo onto the citation convention, one writes the
map, one reads it and flags drift. Each skill references the others, so installing them together is
intentional.

## Shared `assets/doc-conventions/` bundle

`docs-init-or-improve` and `docs-migrate` both install from one shared, plugin-level asset folder
(`assets/doc-conventions/`, sibling to `skills/`) rather than each carrying its own copy:

- **`check-doc-cites.mjs`** — the citation-lint engine. Zero-dependency Node ESM, installed verbatim
  into the target repo's script directory; all repo-specific facts (which doc directories are in
  scope, extra declaration shapes, heading-anchor forge support) live in a sibling
  `doc-cite-config.json`, never hardcoded in the script.
- **`doc-cite-config.template.json`** / **`doc-cite-exceptions.template.tsv`** — the per-repo config
  and exceptions-list starter, generated/filled in at install time.
- **`doc-drift-status.mjs`** — a companion, **report-only by default** tool that compares git
  timestamps to answer "when have docs drifted" (code newer than the L2 doc that covers it; an L2
  changed since its L1 sibling by more than a configurable threshold). Never mutates anything in CI;
  a local-only `--write` flag can write `status_note` back for minor verdicts (never pass `--write` in
  CI). `doc-maintenance` consumes its report as a prioritization lead — it doesn't own or ship it.
- **`STRUCTURE-citation-section.template.md`** / **`HANDOFF.template.md`** — the canonical
  citation-conventions prose (spliced into a target repo's `docs/STRUCTURE.md`, never duplicated) and
  a context-budget handoff artifact template for large migrations.

`doc-maintenance` **consumes** the drift tool's report but doesn't own or install these assets — both
`docs-init-or-improve` and `docs-migrate` do.

## Install

```text
/plugin install codebase-docs@personal-ai-tools
```

(First add the marketplace — see the [repo README](../../README.md).)

## Compatibility

These skills assume a specific docs convention: `docs/LLM_MAP.md`, `docs/STRUCTURE.md`, and an L0–L3
documentation tier system. The `doc_lint.py` link linter the verification gate uses **ships with the
plugin** — bundled in the `doc-maintenance` skill at `skills/doc-maintenance/scripts/doc_lint.py`, so
there is nothing to supply. A reference **Workflow** that operationalizes the `doc-maintenance` process
also ships alongside it at `skills/doc-maintenance/workflows/` — harness-specific, read-and-adapt, not
auto-run. `codebase-context` is written to trigger proactively at the start of nearly
every task, so once installed it is active in **every** repo you open. Use it in repos that follow this convention; disable it per-project via the `/plugin`
menu if it fires where the convention isn't in use.
