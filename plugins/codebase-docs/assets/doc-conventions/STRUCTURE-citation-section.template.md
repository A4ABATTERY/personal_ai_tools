## Doc-citation conventions

These directories use two distinct, deliberately different-shaped conventions for pointing at code.
Both are enforced/verified by `check-doc-cites.mjs` (see below) except where noted.

### 1. Code citation — `path/from/repo/root.ext § symbolName`

The **only** form for citing a specific piece of code. Replaces an old `file.ext:NN[-MM]` line-number
convention (line numbers drift the moment the cited file is edited; a symbol name does not).

- **Path** — full repo-root-relative path (never a bare filename: several files can share a basename
  shape, and a full path removes any ambiguity for a plain grep).
- **Separator** — a literal ` § ` (U+00A7, one space either side).
- **Symbol** — the name exactly as declared in code: a function/const/class/interface/type/hook/component
  name (`src/payments/process.py § process_payment`), a dot-form method/handler inside a component or
  scope (`src/widgets/Panel.tsx § PanelProvider.confirmClose`), a JSON/YAML key-path for a config file
  (`package.json § scripts["build"]`, `.github/workflows/ci.yml § jobs.test.steps["Lint"]`), or a
  data-layer anchor for a schema/table declared as an object key rather than a `const`/`function`
  (`db/schema.sql § orders`, or an ORM-model-style key — see the `extraDeclarationPatterns` escape hatch
  below for how a repo teaches the lint its own declaration idioms). Multiple line numbers
  for the same symbol collapse to ONE anchor; a range spanning several small symbols collapses to a
  comma-separated list of anchors, never a re-invented numeric range.
- **True line-only exceptions** — when no stable anchor exists (a bare `RUN` instruction, a specific
  `<meta>` tag, a file-header comment block, an anonymous test case, a renamed destructuring export, a
  JSONC file `JSON.parse` can't walk structurally) the citation stays in its literal `` `file.ext:NN` ``
  form and gets one row in the installed exceptions TSV (tab-separated: `doc_path`, `cite_text`,
  `min_line_count`, `reason`) — this is what keeps an un-converted cite from being a silent leftover; the
  lint fails on any `file.ext:NN`-shaped citation in these dirs that has no matching exception row.
- **Repo-specific declaration shapes** — if this repo has a "thing" the lint's built-in per-language
  declaration table doesn't recognize (e.g. a schema table declared as an object key, a framework's own
  first-class block form), it is taught to the lint via one `extraDeclarationPatterns` entry in the
  installed `doc-cite-config.json` — never by inventing a fake anchor and never by silently over-broadening
  a built-in regex.
- **Heading-anchor slugs are forge-specific.** The installed lint's heading-anchor check (which catches an
  inbound `[text](./doc.md#fragment)` link going stale when a heading's TEXT changes) replicates GitHub's
  own heading-to-anchor rendering rules and is enabled only when `doc-cite-config.json`'s
  `headingSlugAlgorithm` is `"github"` (auto-detected from `git remote get-url origin` at install time). A
  non-GitHub-hosted repo runs with this check disabled (`"none"`) rather than risking false-positive
  "broken anchor" reports from a forge-specific algorithm applied to the wrong forge.

### 2. Doc-section cross-reference — `doc.md § "quoted phrase"`

A **pre-existing, unrelated** idiom (search for it before assuming `§` is free to use as a fresh
separator — a repo may already use it) for linking to a *section of another doc* by its heading text,
always inside a markdown link, e.g.
`` [flow.md § "The retry-and-backoff design"](./flow.md#the-retry-and-backoff-design) ``. The quoted
phrase is what excludes it from the code-citation convention above by construction — the lint's
citation-detection regex never matches a symbol that starts with `"`/`'`. Never converted, never
symbol-existence-checked, entirely out of `check-doc-cites.mjs`'s scope. Do not blur the two — a citation
whose "symbol" is a quoted phrase is always this convention, never a code citation.

### Per-doc frontmatter

Every `.md` directly inside each doc-citation-scoped directory (READMEs included) opens with a flat YAML
frontmatter block:

```yaml
---
covers:
  - "src/payments/process.py § process_payment"   # a citation (per the grammar above) …
  - "src/payments/gateway.py"                      # … or a bare repo-relative path = whole-file coverage
related:
  - "docs/payments/refunds.md"                     # sibling docs, repo-relative paths
status: current                                     # current | historical — exactly these two values
status_note: null                                   # optional free text; set only when status is genuinely
                                                      # nuanced (e.g. a file that's part-current/part-retired)
---
```

`covers` must be non-empty (a doc with nothing it's authoritative for is itself a drift signal).
`related` may be `[]`. This is a deliberately restricted flat grammar (list-of-strings + one scalar + one
optional scalar, no nested maps, no multiline scalars) so `check-doc-cites.mjs` can hand-parse it without a
YAML dependency.

### The lint — `check-doc-cites.mjs`

Zero-dependency Node ESM, installed at this repo's chosen script directory. Checks: cited file exists
(excluding any configured generated-output prefixes), cited symbol/key-path is actually declared in that
file (a declaration-boundary regex — not a raw substring match, so a rename can't silently leave a
stale-but-still-matching anchor), every doc's frontmatter is present and well-formed, the exception list
stays fresh (the cited line hasn't been deleted out from under it, and no un-converted line cite survives
untracked), and — where `headingSlugAlgorithm` is `"github"` — every internal
`[text](<doc>.md#fragment)` heading-anchor link anywhere under the docs root resolves to a real heading's
*current* GitHub-rendered slug in its target file. This last check exists because rewriting a heading's
TEXT (e.g. converting an old `file.ext:NN` line-cite parenthetical to the new `§ symbol` form) silently
changes that heading's GitHub anchor slug too — a drift class the `§`-citation checks above never cover,
since they check doc↔code, not doc↔doc heading references. Fix the *citing* link's fragment to the target's
current slug in the SAME pass as any heading rewrite that triggered the drift — never as a separate,
easy-to-forget follow-up. Run it locally with `node <script-dir>/check-doc-cites.mjs` — no flags for normal
operation, no network.

### Drift-status tooling — `doc-drift-status.mjs`

A companion, report-only-by-default tool that answers "**when** have docs drifted" by comparing git
timestamps: code newer than the L2 doc that `covers` it (needs-maintenance), and an L2 changed since its L1
sibling by more than a configurable threshold (minor → the L1 may need a `status_note`; major → the L1
needs a status change + update). Never mutates anything in CI; a local-only `--write` flag can write
`status_note` back for minor verdicts. See `doc-maintenance`'s skill text for how to use its report as a
prioritization lead (verify every flagged item against code — the tool narrows WHERE to look, it doesn't
replace looking).
