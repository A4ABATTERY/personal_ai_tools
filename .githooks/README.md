# Git hooks

Shared, version-controlled hooks for this repo.

## Enable them (once per clone)

Git does not use this directory automatically. Run:

```
git config core.hooksPath .githooks
```

On Windows this runs under Git Bash; no extra setup needed.

## Hooks

- **pre-commit** — blocks any staged file that starts with a UTF-8 BOM
  (`EF BB BF`). A BOM makes `plugin.json` / `marketplace.json` fail to parse
  with `Unrecognized token`. Windows PowerShell 5.1's `Out-File` /
  `Set-Content` emit a BOM by default, so this is an easy regression to
  introduce. Bypass for one commit with `git commit --no-verify`.
