---
name: codebase-context
description: The DEFAULT first step for substantive work on this codebase — invoke PROACTIVELY at the start of a task, before you grep, design, or edit, even when docs aren't mentioned. Reach for it when building a feature or asking "does this already exist?"; fixing a bug (localized or diffuse); reviewing, refactoring, or assessing the blast radius of a change; debugging data/pipeline lineage; answering config/auth/deploy questions; or scoping/estimating work. Also for any "what is X / where does X live / how does X work / what consumes X / is it safe to change X" question. It uses a measured grep-first protocol to orient faster than blind grepping, reuse existing patterns instead of duplicating them, and ALWAYS report code↔doc drift — even when the user didn't ask for it. Code (the lowest tier) is always the source of truth. Do NOT invoke for a trivial one-line edit whose location you already know and that has no cross-cutting risk.
---

# Codebase wayfinding — grep-first protocol + mandatory drift report + governance

This is the project's codebase. The `docs/` tree is tiered — **L0** `docs/LLM_MAP.md` (index) →
**L1** per-module `README.md` (cross-cutting synthesis across its L2s, **not** a file list) →
**L2** deep-dive `.md` (one thing in depth — a system/flow, function, concept, or data layer) →
**L3** the code. **Code is the source of truth; docs drift — when they disagree, code wins and you flag
the drift.** Doc folders mirror the codebase's own structure (`repo → project → subfolder` where that
structure carries meaning; no imposed backend/frontend split). Full tier scope-contract + doc workflow:
`docs/STRUCTURE.md` (read only if editing docs).

> **The user usually will NOT ask you to check for drift or gotchas — surfacing them anyway is the whole
> point of this skill.** §Drift-report below is a REQUIRED part of every answer, including a plain
> "how does X work?" lookup. A feature that looks live but is half-disabled is the most important thing to catch.

---

## STEP 0 — Classify the task (decides budget; every class still produces the mandatory §Drift-report)

- **Locate** — "what is X / where / how does X work" → run §Search + §Synthesis in full (incl. §Drift-report),
  **Locate budget**.
- **Enumerate** — "what consumes X / is it safe to change X / find ALL drift / blast radius", or any claim
  that something is **dead/unused** → §Search + §Synthesis, **Enumerate budget**.
- **Feature-dev / reuse / scoping** — "build X / add integration Y / does X already exist / how big a job" →
  §Search to find the analogous existing surface, then **also read §Reuse**.
- **Editing docs / fixing drift** → answer first, then read §Drift-handling and §Doc-handoff.

---

## §Search protocol  (the hot path — follow in order)

1. **Do NOT read `CLAUDE.md` or `LLM_MAP.md` in full.** Grep finds the owning files faster.
2. **Grep the most DISTINCTIVE SINGLE token — not the phrase.** A specific symbol name (a class, function,
   type, constant, or config key), not the prose description of what it does — e.g. the actual handler name,
   not "how the API authenticates". Issue the doc-grep and code-grep together (`files_with_matches`). If
   several names could own it (a type *and* its interface, an implementation *and* a build-excluded or
   feature-flagged twin), grep them in parallel in one turn.
3. **Gotcha sweep — content-grep (`-C 3`) the token across EVERY matched doc** (legacy / cross-store /
   inventory / domain docs included). **MANDATORY — never skip this, even for a one-line lookup.** This
   single grep is how disabled/dead/commented-out facts surface; skipping it is how you miss the answer.
4. **Confirm in code with targeted reads:** grep the symbol for line numbers, then `Read` with
   `offset`/`limit`. **Never read a file >150 lines wholesale.** For any dead/live/unused/"is it safe to
   change" question, **grep the symbol's call-sites across the code** before answering.

## §Synthesis  (before writing — costs no extra reads)

5. **Name the load-bearing claims** (the 2–4 a wrong answer hinges on); verify exactly those.
6. **Run the gotcha checklist** over your sweep output: *dead code · commented out · REMOVE ·
   non-functional · disabled · circular · build-excluded · conditionally-compiled · feature-flagged-off ·
   deprecated · hardcoded · "only functional" · "never called" · duplicate registration.*
7. **Tag provenance** per fact: `[code-confirmed]` or `[doc-only — may be stale]`.

## §Drift-report  (MANDATORY output — every answer ends with this section, verbatim heading)

End your answer with:

```
## Drift & gotchas
- Swept: <which docs you content-grepped + whether you checked call-sites for the key symbol>
- Trigger words hit: <any checklist words found, with file:line> OR "none"
- Verdict: <headline gotcha, [code-confirmed], file:line>  OR  "No drift/disabled code found after the sweep — surface is live."
```

Rules that keep this honest:
- You may only write "surface is live" **after** actually running the §Search step-3 sweep — name the docs you swept.
- **Do NOT manufacture a gotcha.** A live, well-used surface with no triggers is a correct and common verdict;
  reporting "none after checking X, Y" is a pass, not a failure.
- If a trigger genuinely applies, it is the **HEADLINE** of your whole answer, not a footnote.

## §Budget  (rough guidance, NOT ceilings — classify in Step 0)

Large codebases vary; the numbers below are **typical** spends per task class, **not limits**.
Spend what the task genuinely needs — a thorough, correct answer beats hitting a number. The point of
classifying is to know roughly where you are and to escalate deliberately, not to cut a search short:

| Class | Typical spend | Typical tool calls |
|---|---|---|
| **Locate** | ~40–50k | ~8–12 |
| **Enumerate** | ~60–90k+ | ~20–30+ |
| **Deep-drift audit** (explicit doc-vs-code audit / dead-code hunt) | as much as it takes | as needed |

Default to **Locate**. **Escalate to Enumerate** the moment the question contains *all / every / consumes /
depends / blast radius / safe to change*, or when the load-bearing claim is **negative** ("X is unused/dead")
— negative claims require codebase-wide call-site enumeration. Prefer reallocating reads (grep-slices over
whole files) before adding passes — but if a thorough answer genuinely needs more passes, take them.

> **Model note (measured).** This protocol reliably gets you to the right surface and always produces the
> §Drift-report — on any model. But *unprompted* detection of **subtle cross-cutting drift** (gotchas buried
> in large inventory / cross-store docs) lands only ~1/3 of the time on a small model and essentially
> every time on a stronger one. A small/cheap model is fine for **locating and explaining**; for a
> **review / audit / "is it safe to change X"** where catching hidden drift matters, run on a stronger model,
> and read a small model's "no drift found" as *"none in the docs I swept,"* not a guarantee.

> **A pure Locate lookup ends after §Drift-report.** Read on only if Step 0 routed you to a governance section.

---

## §When NOT to invoke / stop early
Skip the heavy protocol for a trivial self-contained edit whose location you already know, a conversation
not about this repo, or an area you already oriented on earlier this session.

## §Drift-handling  (read when docs disagree with code, or you're fixing drift)
- **Fix in place (no need to ask):** a stale/moved L0 reference, or a wrong/missing L1↔L2 link — mechanical.
  Then verify: the doc link linter must report **0 broken** before committing.
- **Surface to the user (don't silently change):** **L3↔L2 drift** (code diverged from its L2 — give
  file:line, doc-says vs code-does) and **undocumented L3 surfaces** (a public entry point / module /
  data-context / background job / entity with no L2). Batch these.

## §Doc-handoff  (read after a change that made docs stale)
Writing/fixing docs is the **`doc-maintenance`** skill's job (explore → write → audit → lint →
commit). This skill finds WHERE things are and flags drift; hand off whenever docs need to change. A good
skill over stale docs is the worst outcome — keep them current.

## §Reuse  (read for feature-dev / "does this already exist?" / scoping)
Before designing anything new, use §Search to find the **analogous existing surface** (a comparable
integration, report, flow, or entity) and reuse its pattern — name the insertion point and which L2s to
update. Many codebases have near-parallel implementations of the same shape; assume a similar pattern
already exists. **Inventing a novel surface when one exists is new tech debt** — confirm reuse-vs-new
explicitly. For scoping, list **the layers the change actually touches** (don't assume a fixed stack —
trace which entry points, core logic, data-access, entities, and pipelines/jobs are really involved) so the
estimate isn't half-counted.

## Why this exists (1 line)
Without this skill agents re-discover the layout every time, let docs silently rot, and duplicate surfaces
that already exist — the grep-first protocol + mandatory drift report + tiered budget make orientation cheap,
drift visible, and reuse the default.
