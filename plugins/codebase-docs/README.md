# codebase-docs

A coupled pair of skills for working in a tiered-docs codebase. **They install together as one
plugin and are meant to be used together** — neither is shipped on its own.

| Skill | Role |
|-------|------|
| **codebase-context** | *Wayfinding / drift detection.* Grep-first orientation that finds where things live, reuses existing patterns, and always reports code↔doc drift. Use at the start of substantive work. |
| **doc-maintenance** | *Production process.* Orchestrates sub-agents to create/update the tiered `docs/` (L0 `LLM_MAP.md` → L1 READMEs → L2 deep-dives), then lints and commits. |

**Why they're coupled:** `doc-maintenance` builds and maintains the tiered docs structure
(`docs/LLM_MAP.md`, `docs/STRUCTURE.md`, the L0–L3 tiers) that `codebase-context` navigates and
keeps honest. One writes the map; the other reads it and flags when it drifts from the code. Each
skill references the other in its workflow, so installing them as a pair is intentional.

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
