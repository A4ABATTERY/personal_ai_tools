# personal-ai-tools — Claude Code plugin marketplace

A **personal** [Claude Code](https://code.claude.com) plugin marketplace.
Add it once, then install the plugins (skills, workflows, and other harness add-ons) you want.

This repo is the **catalog**. Each plugin lives in its own folder under `plugins/`.

---

## Prerequisites

- **Claude Code** installed and working.
- **Read access to this GitHub repo**, with git credentials already configured on your machine
  (an SSH key or a credential-manager token for HTTPS). `/plugin marketplace add` runs `git clone`
  under the hood using *your* git credentials — if `git clone <this repo url>` works in your
  terminal, the marketplace will too.

> **Privacy:** this marketplace is exactly as private as the GitHub repo backing it. There is no
> public registry — nothing is published to any external index. If the repo is private, only people
> you grant access to can add it.

---

## Install

Run these in Claude Code (`/plugin` commands are typed at the prompt):

```text
# 1. Register the catalog (one time)
/plugin marketplace add https://github.com/A4ABATTERY/personal_ai_tools.git

# 2. Install the plugin(s) you want
/plugin install codebase-docs@personal-ai-tools
```

That's it — the skills load automatically. Open the `/plugin` menu anytime to browse, enable,
disable, or remove installed plugins.

### Updating

```text
/plugin marketplace update personal-ai-tools   # pull the latest catalog + plugin versions
```

### Removing

```text
/plugin uninstall codebase-docs@personal-ai-tools
```

---

## What's included

### `codebase-docs`

Three skills for working in a tiered-docs codebase:

| Skill | What it does |
|-------|--------------|
| **codebase-context** | Wayfinding. A grep-first orientation protocol that finds where things live faster than blind grepping, reuses existing patterns, and **always reports code↔doc drift** — even when you didn't ask. Written to trigger proactively at the start of substantive work. |
| **doc-maintenance** | The orchestration process for creating/updating the tiered docs (`docs/` — L0 `LLM_MAP.md`, L1 READMEs, L2 deep-dives). Dispatches sub-agents (explore → verify+write → audit), then lints and commits. |
| **docs-init-or-improve** | The whole-repo front door. Fires when a project is **undocumented** (sets up the tiered-docs convention from scratch) or when the docs are **stale/inconsistent** and need a cleanup or consistency check. It assesses state, bootstraps `docs/STRUCTURE.md` + a seed `docs/LLM_MAP.md`, then hands off to `doc-maintenance`. |

Install: `/plugin install codebase-docs@personal-ai-tools`

> **⚠️ Compatibility note.** These two skills assume a specific docs convention — they reference
> `docs/LLM_MAP.md`, `docs/STRUCTURE.md`, a `doc_lint.py` link linter, and an L0–L3 documentation
> tier system. `codebase-context` is also written to trigger **aggressively** (it positions itself as
> the default first step on nearly every task). Once installed it is active in **every** repo you open.
> If a repo does **not** follow this tiered-docs convention, the skill will still try to fire and may
> reference files (`LLM_MAP.md`, `doc_lint.py`, etc.) that don't exist there. Install it where that
> convention is in use, or disable it per-project via the `/plugin` menu if it gets noisy.

A generic, codebase-agnostic **Workflow** that operationalizes the `doc-maintenance` process ships with
the plugin under
[`plugins/codebase-docs/skills/doc-maintenance/workflows/`](./plugins/codebase-docs/skills/doc-maintenance/workflows/)
— a reference artifact to read and adapt (it is harness-specific), not auto-run as part of the skill.

---

## For maintainers — adding more plugins

This repo is a catalog, so adding a plugin is two steps:

1. **Create the plugin folder** under `plugins/`:

   ```text
   plugins/<your-plugin>/
   ├── .claude-plugin/
   │   └── plugin.json          # { "name": "<your-plugin>", "version": "0.1.0", ... }
   ├── skills/<skill-name>/SKILL.md   # optional: one folder per skill
   ├── hooks/hooks.json               # optional: event hooks
   ├── agents/<agent>.md              # optional: subagents
   └── .mcp.json                      # optional: MCP servers
   ```

2. **List it** in [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json) by adding an
   entry to the `plugins` array, with `source` pointing at the folder:

   ```json
   {
     "name": "<your-plugin>",
     "description": "...",
     "version": "0.1.0",
     "source": "./plugins/<your-plugin>"
   }
   ```

Commit and push. Re-install with `/plugin marketplace update personal-ai-tools`, then
`/plugin install <your-plugin>@personal-ai-tools`.

### Repo layout

```text
.
├── .claude-plugin/
│   └── marketplace.json          # the catalog (lists all plugins)
└── plugins/
    └── codebase-docs/
        ├── .claude-plugin/
        │   └── plugin.json
        └── skills/
            ├── codebase-context/SKILL.md
            ├── docs-init-or-improve/        # whole-repo front door: init or clean-up
            │   ├── SKILL.md
            │   └── assets/STRUCTURE.template.md
            └── doc-maintenance/
                ├── SKILL.md
                ├── scripts/doc_lint.py
                └── workflows/      # generic Workflow reference (ships with the plugin; read & adapt)
                    ├── README.md
                    └── document-tiered-docs.workflow.js
```
