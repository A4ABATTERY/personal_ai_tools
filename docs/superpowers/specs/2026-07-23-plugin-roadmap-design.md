# Plugin Roadmap Design — Orchestrated Delivery & codebase-docs (2026-07-23)

Owner-approved design from the 2026-07-23 brainstorm. Answers the question: **"where should
we take each of the plugins?"** — grounded in two verified research cycles (9 external
systems, 3 waves; 5 evaluation-methodology lanes, 2 waves), a four-lens internal debate,
and a Chairman synthesis. Research corpus: `~/Documents/plugin-research/` (outside this
repo); debate + synthesis: `~/Documents/plugin-research/2026-07-23-debate/`.

## Owner decisions this design is built on

1. **Audience**: the plugins are personal tools that happen to live in a public repo.
   No first-mover race; published claims must stay honest, artifacts presentation-quality.
2. **Sequencing**: evals first, then improvements — eval results pick what ships.
3. **OD default posture**: flip to lean-default for standard-risk work now (reversible);
   `budget_caps` stays an optional contract key.
4. **codebase-docs structure**: lint/evidence work only; no skill consolidation.
5. **Shape**: Approach 1 — four small alternating cycles E1 → E2 → U1 → U2.

## Design principles (from the research, verified)

- **Evidence before features.** Nothing published measures long-horizon docs value; the
  one rigorous context-file study found a null success effect for flat files, while doc
  *quality/freshness* effects are real (+20pp SWD-Bench; 21–43pp drift blind spot, TRACE).
  So: measure our own mechanisms before extending them.
- **Independence, not discussion.** The debate literature is negative on chatty councils;
  the retracted Google claim removed the only external validation of adversarial panels.
  OD's context-isolation (minimal-context panel, blind gate) is the defensible core.
- **Machinery must prove it still runs.** OB1's gate ran 0-for-140 silently; a 75k-star
  docs tool rotted its own docs. Instrument lightly; never trust a quiet gate.
- **Every rule costs orchestrator context.** SKILL.mds are prompts; additions must earn
  their words (see success criterion 3).

---

## Cycle E1 — OD evidence harvest (S-cost; no plugin behavior changes)

**Deliverable:** `~/Documents/plugin-research/evidence/E1-od-memo.md` — "which failure
modes and catches actually occur in our OD usage?" Catch AND miss rates both reported.

Prerequisite folded into E1 setup: **write this repo's OD adaptation contract** (currently
absent — a standing blocking setup error). E1 running under OD is the contract's shakedown.

Workstreams:

1. **MAST-code the real WorkLogs.** Classify entries from the two real consumer journals
   (RSVP: ~1,196 dated entries; market-mosaic: ~44) against MAST's public 14-mode taxonomy
   (arXiv:2503.13657, κ=0.88). Sampled coding with spot verification — the codebook is a
   lead, not an oracle. Output: a frequency table; the headline question is whether
   step-repetition (MAST's largest mode, 15.7%) occurs in our usage.
2. **Mutation-telemetry tabulation.** Extract every mutation-testing outcome recorded in
   past cycle artifacts/WorkLogs: guards tested, false guards caught, later-discovered
   misses. This is the organic seeded-defect eval — the loop already generated the data.
3. **Contract-refusal test.** In a sandbox repo, feed OD three deliberately incomplete
   adaptation contracts (missing `merge_authority`; missing `protected_data`; undeclared
   `existing_orchestrator` collision) and verify the loop BLOCKS rather than guessing
   defaults. Deterministic pass/fail per case.
4. **Gate-dispatch logging.** One-line instrumentation convention: each cycle's WorkLog
   records which gates dispatched and returned. A glanceable log — explicitly NOT a
   watchdog subsystem (the RSVP project already tried and retired a heartbeat cron).

## Cycle E2 — codebase-docs evidence (S-cost)

**Deliverable:** `~/Documents/plugin-research/evidence/E2-cd-memo.md`.

Seed 20–30 realistic stale claims into a COPY of a real documented repo's docs — wrong
counts, renamed symbols, dead-feature claims, moved files; at least half drawn from drift
the plugin actually caught historically. Measure:

- (a) `check-doc-cites.mjs` + `doc-drift-status.mjs` catch-rate, reported against the
  published 64%-precision baseline for unstructured doc-reference checkers
  (Treude & Baltes, arXiv:2606.09090);
- (b) the fault categories that slip through cleanly (these become U2's requirements);
- (c) **agent silent-propagation rate** — does a `codebase-context` lookup over the
  seeded docs repeat the lie or flag it? (TRACE's 21–43pp blind-spot finding predicts
  repetition; our drift-report discipline predicts flagging. This measures which wins.)

Grading is deterministic — the seed list is the oracle; no LLM judge.

---

## Cycle U1 — OD v2.3 (informed by E1)

Pre-approved, evidence-independent:

1. **Lean-default flip.** SKILL.md reframed: standard-risk work takes the lean path by
   default; the full loop is the named escalation for high-risk / novel / security-touching /
   multi-integration-unit changes, with the escalation triggers written explicitly.
2. **ADR-style WorkLog decision entries.** Decisions recorded as Context / Decision /
   Consequences (±) / Alternatives-considered, with `dependsOn`/`related` links
   (SilverBullet's `docs/ADR/` schema). Ordinary dated entries remain for non-decisions.
   Dogfooded starting in E1, shipped as convention in U1.

Gated on E1's memo (ship only if the failure mode is real for us):

3. **Step-repetition detector** — as WorkLog discipline (orchestrator self-check: last N
   dispatches produced no new artifact state → stop/escalate), not new tooling.
4. **Targeted panel hardening** — only S-cost items E1 justifies (fail-closed verdict
   handling if silently-dropped verdicts appear; XML-wrapping of reviewed artifacts if
   injection-shaped noise shows up in audit inputs).
5. **Gate-dispatch log** promoted from E1 instrumentation to standing convention.

## Cycle U2 — codebase-docs 0.6 (informed by E2)

1. **Coverage-gap check** — concept/symbol referenced across ≥N docs with no doc page of
   its own (the llm-wiki sixth lint check; default N=3, tunable in U1's plan from E2 data);
   lands in `check-doc-cites.mjs` or the audit checklist depending on what E2 shows is
   mechanically detectable.
2. **Symbol-cite cross-check** — where a doc restates an enum/count defined in code, the
   lint verifies the restated count against the cited symbol ("cite the defining symbol,
   don't restate" — the Understand-Anything drift lesson). Scope = exactly the categories
   E2's seeded faults slipped past.
3. **Efficiency line on close-outs** — doc-consult token cost vs drift caught / duplicate
   work avoided (mirrors OD's cost-per-caught-defect).
4. **No restructuring.** The four-skill shape is untouched.

## Stage-ablation decision point (after E1; before or during U1)

The M-cost OD-vs-single-agent ablation runs ONLY IF E1's harvested telemetry cannot
already answer "do the panel/gate stages catch real defects the implementer missed?"

- If the WorkLogs show a handful of clear panel/gate catches with costs attached:
  compute cost-per-caught-defect from history; skip the synthetic experiment.
- If ambiguous: run a right-sized 2-arm ablation (lean vs full, 10–15 real-failure
  tasks, k=2) — not the 4-arm k=3 version.
- Either way: the decision is written as an ADR entry.

---

## Parked items (ADRs, not forgotten intentions)

| Parked item | Unlock condition |
|---|---|
| Staleness-**resolution** mechanism (CD) | E2 baseline exists AND flagged drift lingers unfixed across ≥2 maintenance passes — resolution, not detection, proven to be the bottleneck |
| Amortization / ChainSWE capstone | A personal need to justify doc investment on a new repo, or a deliberate decision to promote the plugins beyond personal use |
| Full panel-bias bundle (shuffle+log, self-vote exclusion, cross-family panels) | OD gains a stage that comparatively RANKS multiple candidate artifacts (today's panel judges one artifact per lens — position/self-preference bias has no surface) |
| Council-review machinery (typed disagreement, mediating assessments, devil's advocate) | Evidence of gate misses that discussion-shaped review would have caught |
| Full 4-arm stage-ablation | The E1-informed decision point rules the 2-arm version insufficient |
| CD consolidation (merge skills, one-command init) | Onboarding another person, or a second consumer repo hitting the learning curve |

## Governance

- Each cycle runs under OD itself; E1 doubles as the new adaptation contract's shakedown.
- ADR-format WorkLog decisions from E1 onward (dogfood before shipping).
- Every close-out reports cost-per-caught-defect (evidence cycles: cost-per-verified-finding).
- Plugin changes land as versioned releases (OD v2.3, codebase-docs 0.6) with changelogs,
  via PRs on this public repo. README claims stay within what the memos back.

## Success criteria

1. Both evidence memos exist and report catch AND miss rates.
2. Every U1/U2 change traces to an explicit owner decision (this document) or a memo
   finding — zero unsourced changes.
3. OD's SKILL.md word count after U1 is ≤ its v2.2.0 count (4,291 words) — lean-default
   must simplify, not append.
4. The parked list survives as written ADRs with their unlock conditions.
