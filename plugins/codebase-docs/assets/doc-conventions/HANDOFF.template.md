<!--
  TEMPLATE — context-budget handoff artifact for a docs-migrate run (or any
  long-running doc-maintenance cycle). Write this PROACTIVELY when context
  usage crosses a rough threshold — not "when you run out." One artifact per
  handoff. Lives OUTSIDE the repo tree (job/task scratch dir) — never commit
  it. A fresh instance picking up a handoff reads it in FULL before touching
  any file, and self-corrects any status claim in it against a live `git
  log` — the handoff is a lead from the previous instance, not a verified
  fact; the previous instance may itself have mis-stated its own status.
-->

# <CYCLE NAME> — handoff (context-limit handoff, not a blocker)

Written by the instance that reached a context-budget threshold mid-run. The next instance: read this in
FULL, then verify STATUS AT HANDOFF TIME against `git log` before trusting a single claim in it.

## STATUS AT HANDOFF TIME

<FILL IN — be explicit about what's DONE (committed, verified) vs. what's MID-FLIGHT (in progress,
uncommitted, or committed-but-not-yet-lint-verified). Do not round up "mostly done" to "done.">

## REMAINING WORK (in sequencing order)

<FILL IN — the ordered list of what's left, matching the migration/maintenance skill's own step order
(smallest-first for citation conversion, per the decision-tree step). One line per remaining file/area.>

## GIT LOG REFERENCE

```
git log <start-commit>..HEAD --format='%h %s' --reverse
```

<FILL IN the actual command output, or a pointer to where to run it — the next instance should re-run
this itself rather than trust a pasted, possibly-stale list.>

## LEARNED CONVENTIONS (the part only this session knows)

<FILL IN repo-specific quirks discovered mid-run that aren't in the shared template's generic guidance —
e.g. a declaration shape that needed an `extraDeclarationPatterns` entry, an unusual frontmatter edge case,
a pre-existing `§` collision found and how it was handled. This is exactly the kind of thing that should
graduate into a config change or a docs/STRUCTURE.md note, not stay tribal knowledge in this file alone.>

## GOTCHAS

<FILL IN anything a fresh instance would otherwise rediscover the hard way — a mis-firing regex on a
specific file shape, a heading-anchor collision, a git-history edge case (rename, deletion) that needed
special handling.>
