# orchestrated-delivery

A skill + agent team for **Orchestrated Delivery**: an orchestrator-driven loop for shipping
non-trivial code changes with independent planning, adversarial (panel + blind) review, and
verified testing before merge — instead of one agent designing, implementing, and grading its own
work.

## What it is

The `orchestrated-delivery` skill turns the main session into an **ORCHESTRATOR** that does not
write code, docs, or tests itself. It dispatches scoped sub-agents through a fixed loop —
**Scope → Plan → Audit-Plan (panel) → Blind lead gate → Implement → Audit-Impl → Test → Docs →
Integrate** — and drives it to a merged, tested, documented change (or, in spec-only mode, an
approved spec). A **lean variant** collapses the loop for small/mechanical/urgent changes.

The design rests on two structural bets, both earned from observed failures rather than theory:
single-lens reviewers with minimal context catch defects that broad reviews miss, and a **blind**
final gate (never told a panel ran) catches what panels structurally can't. Full artifacts land on
disk, not in context, so a run survives compaction.

## What's inside

| Path | Role |
|---|---|
| `skills/orchestrated-delivery/SKILL.md` | The loop definition: stages, artifact discipline, sub-agent hygiene, auditor independence rules, failure protocols, WorkLog convention. |
| `agents/od-planner.md` | Designs the implementation plan. |
| `agents/od-auditor.md` | Adversarial panel auditor — one lens per instance (feasibility, regression, security, maintainability…). |
| `agents/od-lead-auditor.md` | The blind final gate — reviews fresh, never told a panel ran. |
| `agents/od-implementer.md` | Executes an accepted plan in isolation; documents every deviation. |
| `agents/od-tester.md` | Panel tester — verifies the REAL running/deployed system with evidence. |
| `agents/od-researcher.md` | Verifies external unknowns (APIs, libraries, pricing/quotas) before commitment. |

## Install

Via the marketplace this plugin ships in:

```text
/plugin marketplace add <marketplace-repo-url>
/plugin install orchestrated-delivery@<marketplace-name>
```

Once installed, the skill is available to any project; invoke it directly or let it trigger on
its description (delivering a non-trivial change, or an explicit request for an orchestrated /
audited / high-assurance / multi-agent workflow).

## How it adapts to your project

This skill defines the **loop**; the **project** defines the specifics. Before its first dispatch
the orchestrator reads the project's `CLAUDE.md` (and whatever memory/docs it points to) and
resolves seven things: model policy per agent, branch/merge convention, test entry points, deploy
flow, docs tooling, orientation entry point (e.g. a docs map or context skill), and what counts as
protected data. Anything not declared falls back to the skill's own defaults (all agents on a
single named model; PR-to-default-branch merged by the user; ask once and record test/deploy
specifics; treat all non-test data as protected). A project that wants tighter control states its
answers explicitly in `CLAUDE.md` — a copy-pasteable starting block:

```markdown
## How we work — Orchestrated Delivery
Use the `orchestrated-delivery` skill for non-trivial changes. The main session is the
ORCHESTRATOR and dispatches scoped sub-agents — it does not implement directly.

- Model policy: <e.g. "all sub-agents on sonnet" | "planner/lead-auditor on your strongest model">
- Branch/merge: PR to `<branch>`, merged by <you | the orchestrator after green gates>
- Test entry points: <app URL(s)>, <test account pattern>, <E2E tooling in use>
- Deploy flow: <e.g. "merge to main -> CI auto-deploys">
- Docs: <a doc-maintenance skill/process, or "update by hand">
- Orientation: <a docs map path, or "read code directly">
- Protected data: <e.g. "all non-test data is protected">
```
