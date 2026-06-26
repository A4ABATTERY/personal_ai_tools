// ===========================================================================
// document-tiered-docs.workflow.js
// ---------------------------------------------------------------------------
// A GENERIC, codebase-agnostic Workflow that operationalizes the `doc-maintenance`
// skill's cheap -> mid -> strong orchestration as a deterministic, repeatable
// script. Drop it into any repo (or set of repos) to build/refresh a tiered
// docs/ tree (L0 LLM_MAP -> L1 READMEs -> L2 deep-dives -> L3 = the code).
//
// It is a REFERENCE ARTIFACT generalized from a battle-tested, project-specific
// script. It is syntactically valid and faithful to the Workflow tool's API, but
// it is meant to be READ and ADAPTED top-to-bottom, not necessarily run as-is.
//
// ---------------------------------------------------------------------------
// HOW THIS DIFFERS FROM A HARDCODED SCRIPT (the key generalization)
// ---------------------------------------------------------------------------
// A project-specific version HARDCODES its module/subfolder topology (explorer
// targets, verifier groups, integrator ownership) in big literal arrays. That
// cannot be generic. But Workflow scripts have NO filesystem access — the script
// itself cannot list the repo's folders. So the FIRST phase is a SCOUT phase:
//   * a cheap-model agent (or a few) inventory the target repo's module/subfolder
//     tree and return it as STRUCTURED output: a JSON list of substantive folders
//     { path, role, weight } (trivial/generated dirs excluded);
//   * PURE deterministic functions then derive the entire topology from that
//     manifest — explorers per discovered module, verifiers per project group,
//     and integrators over DISJOINT subtrees of the discovered tree.
// No Math.random(), no Date.now() (the runtime forbids both); the partition is a
// pure function of the sorted manifest so it is stable and disjoint-safe.
//
// ---------------------------------------------------------------------------
// WORKFLOW TOOL API USED (faithful to the runtime)
// ---------------------------------------------------------------------------
//   export const meta = { name, description, whenToUse, phases }   // metadata
//   args                       // injected params (string or object); see caveat below
//   log(msg)                   // append to the run digest
//   phase(title)               // mark a phase boundary in the digest
//   await parallel(thunks)     // run an array of () => Promise in parallel, barrier-join
//   await agent(prompt, opts)  // dispatch a sub-agent; opts = { label, phase, model, schema }
//                              //   model: 'haiku' | 'sonnet' | 'opus' (cheap/mid/strong)
//                              //   schema: a JSON-schema object for structured output;
//                              //           the agent's return value is the parsed object
//
// ===========================================================================

export const meta = {
  name: 'document-tiered-docs',
  description:
    'One generic documentation cycle over any repo (or repos). A SCOUT phase inventories the ' +
    'codebase tree as structured output, then the topology (explorers/verifiers/integrators) is ' +
    'derived deterministically and run cheap->mid->strong. Cycle progression: 1 = INVENTORY ' +
    '(broad, flat); 2 = DEEPEN; 3 = RESTRUCTURE into a codebase-mirrored docs tree + deepen per ' +
    'subfolder; 4 = AUDIT (walk L0->L1->L2->L3) + FIX. Cycle is set by CYCLE_DEFAULT (bump it each ' +
    'run); args.cycle overrides. All agents write to temp/ and docs/; the orchestrator passes PATHS.',
  whenToUse:
    'Creating or refreshing a tiered docs/ tree for any codebase. Run once per cycle ' +
    '(1=inventory, 2=deepen, 3=mirror-restructure, 4=audit+fix), reviewing the returned digest ' +
    'between runs. Generic: no codebase-specific knowledge is baked in — the scout discovers it.',
  phases: [
    { title: 'Scout',     detail: 'cheap-model agent(s) inventory the repo tree -> structured manifest (persisted to temp)', model: 'haiku' },
    { title: 'Explore',   detail: 'cheap-model explorers inventory/verify slices of the codebase -> temp', model: 'haiku' },
    { title: 'Verify',    detail: 'mid-model agents verify explorer notes against code and write doc drafts -> temp', model: 'sonnet' },
    { title: 'Integrate', detail: 'mid-model agents build out docs/ over DISJOINT subtrees, SEQUENTIALLY (each reads prior writers + links; LLM_MAP owner last)', model: 'sonnet' },
    { title: 'Audit',     detail: 'cycle 4 only: strong-model agents walk L0->L1->L2->L3 and write fix-lists -> temp (parallel; read-only on docs)', model: 'opus' },
    { title: 'Fix',       detail: 'cycle 4 only: disjoint-ownership agents apply audit fixes to docs/, SEQUENTIALLY', model: 'sonnet' },
  ],
}

// ===========================================================================
// PARAMETERS
// ---------------------------------------------------------------------------
// GOTCHA (observed in our harness): the runtime did NOT reliably inject `args`
// for scriptPath runs, so the EDITABLE in-script constants below are the
// authoritative control. `args` is honored as an OPTIONAL override when present.
// We log() every resolved value so it can be verified from the digest — a silent
// default once caused a cycle to re-run as cycle 1.
//
// Also: the runtime forbids Date.now() / Math.random(). Pass the date in (or edit
// DATE_DEFAULT below); never call new Date() in this script.
// ===========================================================================

// --- EDIT THESE for your repo, then BUMP CYCLE_DEFAULT before each run --------
const CYCLE_DEFAULT = 1                                  // 1 -> 2 -> 3 -> 4; bump before each invocation
const DATE_DEFAULT  = '2026-06-23'                       // pass args.date, or edit this literal each run
const REPO_ROOTS_DEFAULT = [                             // absolute path(s) to the code repo root(s)
  // e.g. 'C:/Users/you/Documents/MyRepo'
  // (one entry = single repo; multiple = multi-repo monorepo-style docs)
]
const DOCS_DEFAULT = ''                                  // absolute path to the docs root (defaults to <first repo>/docs)
// -----------------------------------------------------------------------------

// Optional: a team MAY inject a role taxonomy so the scout/explorers classify
// modules with their own vocabulary (e.g. 'PUSH'|'PULL'|'LISTEN', or
// 'service'|'library'|'ui'|'data'). Leave empty for fully generic role inference.
const ROLE_TAXONOMY_DEFAULT = '' // e.g. 'Classify each module as one of: PUSH (sends to an external system), PULL (fetches), LISTEN (receives).'

// How many scout agents to fan out (1 is usually enough; use 1-per-root for big multi-repo trees).
const SCOUT_FANOUT_DEFAULT = 1
// Target number of disjoint integrator owners (the partitioner clamps to the number of groups).
const INTEGRATOR_COUNT_DEFAULT = 5

// --- args parsing (string-or-object; both forms tolerated) -------------------
let _args = (typeof args === 'string')
  ? (() => { try { return JSON.parse(args) } catch (e) { return {} } })()
  : args
_args = _args || {}

const CYCLE          = _args.cycle ?? CYCLE_DEFAULT
const DATE           = _args.date  || DATE_DEFAULT
const REPO_ROOTS     = (Array.isArray(_args.repoRoots) && _args.repoRoots.length) ? _args.repoRoots : REPO_ROOTS_DEFAULT
const DOCS           = _args.docs  || DOCS_DEFAULT || ((REPO_ROOTS[0] || '.') + '/docs')
const TEMP           = (_args.temp || (REPO_ROOTS[0] || '.') + '/temp') + '/docwork'
const ROLE_TAXONOMY  = _args.roleTaxonomy || ROLE_TAXONOMY_DEFAULT
const SCOUT_FANOUT   = _args.scoutFanout    || SCOUT_FANOUT_DEFAULT
const INTEGRATOR_N   = _args.integratorCount || INTEGRATOR_COUNT_DEFAULT

// Cycle semantics (kept identical to the project-specific progression).
const WIDE   = CYCLE === 2   // DEEPEN over the flat layout (more explorers, more depth)
const MIRROR = CYCLE === 3   // RESTRUCTURE into a codebase-mirrored tree + deepen per subfolder
const AUDIT  = CYCLE >= 4    // AUDIT (walk L0->L1->L2->L3) + FIX

// Manifest path: the SCOUT writes the discovered tree here on cycle 1; later
// cycles REUSE it so topology/ownership stay STABLE (see cross-cycle note below).
const MANIFEST_PATH = TEMP + '/_manifest/structure.json'

log(`RESOLVED cycle=${CYCLE} (args.cycle=${JSON.stringify(_args.cycle)}), date=${DATE}`)
log(`RESOLVED repoRoots=${JSON.stringify(REPO_ROOTS)} docs=${DOCS} temp=${TEMP}`)
log(`RESOLVED phase=${AUDIT ? 'AUDIT+FIX' : MIRROR ? 'MIRROR-RESTRUCTURE' : WIDE ? 'DEEPEN' : 'INVENTORY'}, integrators=${INTEGRATOR_N}, roleTaxonomy=${ROLE_TAXONOMY ? 'custom' : 'generic'}`)
if (!REPO_ROOTS.length) log('WARNING: REPO_ROOTS is empty — edit REPO_ROOTS_DEFAULT or pass args.repoRoots.')

// ===========================================================================
// STRUCTURED-OUTPUT SCHEMAS
// ---------------------------------------------------------------------------
// SMOKE-TEST the plumbing on the first cycle: confirm the model short-names route,
// agents wrote to the expected temp paths, and these schemas return cleanly BEFORE
// trusting a large multi-cycle run.
// ===========================================================================

// The SCOUT returns the substantive-folder manifest as structured output.
const SCOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repoRoot: { type: 'string', description: 'absolute path of the repo root you inventoried' },
    folders: {
      type: 'array',
      description: 'every SUBSTANTIVE folder in this repo (skip trivial/generated/vendored dirs)',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path:   { type: 'string', description: 'folder path RELATIVE to repoRoot, forward slashes (e.g. "ProjectA/Models")' },
          role:   { type: 'string', description: 'one short phrase: what this folder is/does (its inferred role)' },
          weight: { type: 'integer', description: 'rough substance 1-5 (file count / importance); 1=tiny, 5=large/central' },
        },
        required: ['path', 'role', 'weight'],
      },
    },
    notes: { type: 'string', description: 'up to 80 words: entry points, build layout, anything that affects how to group these' },
  },
  required: ['repoRoot', 'folders'],
}

// Every worker (explorer/verifier/integrator/auditor/fixer) returns this.
const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    area:         { type: 'string', description: 'the area/slice key you were assigned' },
    filesWritten: { type: 'array', items: { type: 'string' }, description: 'absolute paths of every file you created/updated' },
    summary:      { type: 'string', description: '100-250 words: what you found / what you did, with the most important verified facts' },
    openQuestions:{ type: 'string', description: 'up to 60 words: unresolved conflicts, suspected drift, or gaps for the next cycle' },
  },
  required: ['area', 'filesWritten', 'summary'],
}

// ===========================================================================
// SHARED PROMPT FRAGMENTS (codebase-agnostic)
// ===========================================================================

// Ground rules pasted into every worker prompt. NO domain specifics — these hold
// for any codebase. The CODE IS THE SOURCE OF TRUTH is the load-bearing rule.
const RULES = `
GROUND RULES (apply to all work):
- The CODE IS THE SOURCE OF TRUTH. Verify every falsifiable claim (file/type counts, symbol names,
  endpoint routes, versions, "unused"/"disabled"/"dead code"/"feature-flagged-off" assertions) DIRECTLY
  against the code and cite it as a path + line (e.g. src/Foo/Bar.ext:42). Do NOT fabricate counts or
  names. Sub-agents (you included) fabricate and miscount; multiple explorers agreeing is NOT proof.
  If unsure, say so rather than guess.
- Use ABSOLUTE paths when reading source; relative paths only WITHIN markdown links between docs/source.
- Use inline date markers in any prose you write: "(observed ${DATE})".
- Read each repo's own README first. Repo root(s): ${REPO_ROOTS.join(', ') || '(none configured)'}.
- COMPOUND, don't rediscover. BEFORE writing, read what is already documented — ${DOCS}/LLM_MAP.md (the
  index of what exists) and any already-written files under ${DOCS}/ for your area and adjacent areas (from
  prior cycles AND, if you are a writer, from writers earlier in THIS cycle). Build on it: extend/correct
  it and LINK to an existing doc rather than re-documenting the same thing from a different angle.
- BUT existing docs are a HYPOTHESIS, not fact. Prior agents (cheap and otherwise) fabricate and miscount,
  so RE-VERIFY every falsifiable claim you carry forward against the code (path:line) before trusting it.
  If a doc disagrees with code, the CODE WINS — correct the doc and note the drift. Compounding speeds you
  up; it must never let an unverified prior claim harden into "fact."
${ROLE_TAXONOMY ? '- ' + ROLE_TAXONOMY : ''}
- Your final message is consumed by a SCRIPT, not a human: return ONLY the requested structured fields.
  Keep the summary to 100-250 words. Do not paste file contents back.`

// The tier model — already generic in the source; kept nearly verbatim. This is
// the highest-value clarification (esp. that L1 is SYNTHESIS, not a file list).
const L2_NOTE = `
TIER MODEL (follow exactly):
- L0 (LLM_MAP.md) = WAYFINDING ONLY: one sentence + a link per system. No depth, no signatures.
- L1 (a folder's README.md) = CROSS-CUTTING knowledge that GENERALIZES across that folder's L2s — the
  shared concepts, how the pieces fit together, the data/role flow tying them. It is NOT merely a file
  inventory; it SYNTHESIZES what the multiple L2s have in common.
- L2 = the SPECIFIC WORKINGS of ONE thing, derived directly from L3. That "thing" can be a project, a
  complicated cross-file system/flow, an important function/algorithm, a domain concept, an
  architecture/view, OR a data layer (an ORM/EF model, a SQL schema, how the DB works, a specific table/
  context). Name the page after the thing. When something is intricate, give it its OWN L2 and link it
  from the L1 — don't cram everything into a per-project page.
- L3 = the code / SQL / config. The source of truth. Every L2 is BASED ON L3 and cites it.`

// Per-cycle goal text (generic — no domain terms).
function cycleGoal() {
  if (CYCLE <= 1) {
    return `CYCLE 1 = INVENTORY. Build a broad, verified map: list each file/type in scope with a ` +
           `one-line purpose, identify entry points and external integrations, and (if a role taxonomy ` +
           `was given) classify each piece by role. Capture cross-cutting data flows you notice.`
  }
  if (CYCLE === 2) {
    return `CYCLE 2 = DEEPEN. The inventory and a first docs/ draft already exist. Read them, then go ` +
           `DEEPER on the most important subsystems in scope: key signatures, request/response shapes, ` +
           `config/connection points, invariants, edge cases, and gotchas. Carve out dedicated L2s for ` +
           `any intricate system/concept/function. Verify and correct anything already written that is ` +
           `wrong or vague.`
  }
  if (CYCLE === 3) {
    return `CYCLE 3 = RESTRUCTURE + DEEPEN (MIRROR THE CODEBASE). Migrate the docs into a tree that ` +
           `MIRRORS the code 1:1 at repo -> project -> SUBFOLDER level: ` +
           `${DOCS}/<Repo>/<Project>/<Subfolder>/README.md (an L1 generalizing across that folder's ` +
           `children) + L2s inside each folder, where the folder names match the real code folders. ` +
           `Mirror SUBSTANTIVE folders only (the scout manifest already excludes trivial/generated/vendored ` +
           `dirs). Fold in (migrate) the existing flat-doc content AND the deep cycle-2 drafts, then ` +
           `deepen per subfolder. Every mirrored folder's README is an L1; the specific workings inside ` +
           `it are L2s.`
  }
  return `CYCLE ${CYCLE} = AUDIT & FIX. docs/ is largely built. Audit your scope against code: find ` +
         `undocumented files/types/systems, incorrect claims, broken or missing cross-links, and stale ` +
         `facts. Produce concrete fixes with path:line citations.`
}

// ===========================================================================
// PURE TOPOLOGY DERIVATION (no I/O, no Date.now/Math.random)
// ---------------------------------------------------------------------------
// These functions turn the SCOUT manifest into the explorer/verifier/integrator
// topology DETERMINISTICALLY. Because they are pure functions of the SORTED
// manifest, the same manifest always yields the same disjoint ownership — which
// is what makes parallel integrators safe and what makes ownership STABLE across
// cycles (we persist the manifest on cycle 1 and reuse it; see loadOrScout()).
// ===========================================================================

// A manifest entry, normalized: { repo, project, sub, path, role, weight }
//   repo    = the repo root the folder belongs to
//   project = first path segment under the repo (the top-level module)
//   sub     = the rest of the path (may be '' for a project-root folder)
//   path    = repo + '/' + relativePath (absolute)
function normalizeManifest(scoutResults) {
  const out = []
  for (const sr of scoutResults) {
    if (!sr || !Array.isArray(sr.folders)) continue
    const repo = sr.repoRoot
    for (const f of sr.folders) {
      const rel = String(f.path || '').replace(/^[\/]+/, '').replace(/[\/]+$/, '')
      if (!rel) continue
      const segs = rel.split('/')
      const project = segs[0]
      const sub = segs.slice(1).join('/')
      out.push({
        repo,
        project,
        sub,
        rel,
        path: repo + '/' + rel,
        role: f.role || '',
        weight: Number.isFinite(f.weight) ? f.weight : 1,
      })
    }
  }
  // STABLE ordering: by repo, then project, then path. Never sort by weight alone
  // (ties would be nondeterministic); path is the deterministic tiebreaker.
  out.sort((a, b) =>
    a.repo.localeCompare(b.repo) ||
    a.project.localeCompare(b.project) ||
    a.rel.localeCompare(b.rel))
  return out
}

// Group folders into PROJECT groups (repo + top-level module). Verifiers and
// integrators operate per group; explorers operate per substantive folder.
function groupByProject(manifest) {
  const byKey = new Map()
  for (const m of manifest) {
    const key = m.repo + '::' + m.project
    if (!byKey.has(key)) {
      byKey.set(key, { key, repo: m.repo, project: m.project, folders: [], weight: 0 })
    }
    const g = byKey.get(key)
    g.folders.push(m)
    g.weight += m.weight
  }
  // Deterministic order: heaviest first, path as tiebreaker (so big projects get
  // their own integrator before being merged with neighbors).
  return [...byKey.values()].sort((a, b) =>
    b.weight - a.weight ||
    a.repo.localeCompare(b.repo) ||
    a.project.localeCompare(b.project))
}

// Partition project groups into N DISJOINT owners. Greedy bin-packing by weight
// (deterministic: groups are pre-sorted heaviest-first; ties broken by path).
// Each owner gets a contiguous, non-overlapping set of project subtrees. Exactly
// ONE owner (index 0, the heaviest) is additionally the ROOT owner of LLM_MAP.md
// and STRUCTURE.md — no other owner may write those.
function partitionIntoOwners(groups, n) {
  const count = Math.max(1, Math.min(n, groups.length || 1))
  const bins = Array.from({ length: count }, (_, i) => ({ idx: i, weight: 0, groups: [] }))
  for (const g of groups) {
    // assign to the currently-lightest bin; ties -> lowest index (deterministic)
    let target = bins[0]
    for (const b of bins) if (b.weight < target.weight) target = b
    target.groups.push(g)
    target.weight += g.weight
  }
  return bins
}

// Build an explorer assignment per substantive folder. One cheap agent per folder
// keeps each slice small. (For very large trees you may coarsen this to one
// explorer per project; left fine-grained here to match the source's per-subfolder
// depth in the mirror cycle.)
function buildExplorers(manifest) {
  return manifest.map(m => ({
    key: `${m.repo.split(/[\/]/).pop()}.${m.rel}`.replace(/[^A-Za-z0-9._-]/g, '_'),
    scope: m.path,
    project: m.project,
    role: m.role,
    docTarget: mirroredDocDir(m),   // where this folder's L1 README lives in the mirrored tree
  }))
}

// Map a code folder to its mirrored docs folder: <DOCS>/<repoName>/<rel>/
function repoName(repoRoot) { return repoRoot.split(/[\/]/).filter(Boolean).pop() }
function mirroredDocDir(m) { return `${DOCS}/${repoName(m.repo)}/${m.rel}` }

// ===========================================================================
// SCOUT PHASE — discover the substantive-folder tree, persist it, reuse it.
// ---------------------------------------------------------------------------
// CROSS-CYCLE STABILITY: the scout writes the manifest to MANIFEST_PATH on cycle 1.
// On later cycles we ask a cheap agent to RE-READ that persisted file (the script
// can't read disk) and return it unchanged. Because the partition is a pure
// function of the sorted manifest, reusing the same manifest keeps integrator
// ownership disjoint and stable cycle-to-cycle — re-scouting from scratch each
// cycle would let LLM nondeterminism reshuffle ownership and break disjointness.
// ===========================================================================
async function loadOrScout() {
  // ESCAPE HATCH: if args.manifest is supplied (the array of per-repo SCOUT_SCHEMA
  // objects), short-circuit both scout AND reload. The orchestrator can review the
  // cycle-1 digest and paste the manifest back on later cycles — this sidesteps both
  // a re-inventory and the agent-transcription fragility of the persisted file.
  if (Array.isArray(_args.manifest) && _args.manifest.length) {
    log(`Scout: using args.manifest (${_args.manifest.length} repo object(s)); skipping scout + reload.`)
    return _args.manifest
  }

  if (CYCLE > 1) {
    // Reuse the persisted manifest. The SCOUT_SCHEMA can represent only ONE repo, so
    // we fan out one loader agent PER ROOT — each reads the same persisted file but
    // returns only its OWN repo's slice. (A single loader would silently drop every
    // repo but the first, breaking the deepen/mirror/audit cycles for multi-repo runs.)
    log(`Scout: cycle ${CYCLE} reusing persisted manifest at ${MANIFEST_PATH} (one loader per root).`)
    const targets = REPO_ROOTS.length ? REPO_ROOTS : ['.']
    const loadJobs = targets.map(root => () => agent(
`You are a manifest loader. READ the JSON file at this absolute path; do NOT re-inventory the repo and do
NOT change anything: ${MANIFEST_PATH}
The file is { results: [ <one SCOUT_SCHEMA object per repo> ] }. Find the object whose "repoRoot" equals
this exact path and return it (and only it) via the schema:
  ${root}
If no object matches that repoRoot, or the file is missing, return repoRoot="${root}" with an empty folders
array and say so in notes.`,
      { label: `scout:load:${repoName(root)}`, phase: 'Scout', model: 'haiku', schema: SCOUT_SCHEMA }
    ))
    return (await parallel(loadJobs)).filter(Boolean)
  }

  // Cycle 1: actually inventory the tree. Fan out one scout per root (or SCOUT_FANOUT).
  const targets = REPO_ROOTS.length ? REPO_ROOTS : ['.']
  const scoutJobs = []
  for (const root of targets) {
    for (let i = 0; i < SCOUT_FANOUT; i++) {
      scoutJobs.push(() => agent(
`You are a codebase SCOUT. Inventory the module/subfolder tree of this repo and return it as structured output.

REPO ROOT (absolute): ${root}

Walk the directory tree and list every SUBSTANTIVE folder — a folder that contains source/config/schema
worth documenting. For each, return { path (RELATIVE to the repo root, forward slashes), role (one short
phrase for what it is/does), weight (1-5 rough substance: file count / centrality) }.

SKIP trivial / generated / vendored / static-asset folders — do NOT list:
  build output (bin, obj, dist, build, out, target), dependency dirs (node_modules, vendor, packages,
  .venv, site-packages), VCS/IDE/tooling (.git, .idea, .vs, .vscode), generated/proxy code (Connected
  Services, auto-generated client stubs, *.designer), framework boilerplate (Properties, Migrations if
  pure-generated), logs (Log, logs), and bulk static assets (images, fonts, localization bundles,
  minified third-party scripts, ML model blobs / wasm / tessdata). When unsure whether a folder is
  substantive, INCLUDE it with a low weight and note the doubt.

Mirror the repo -> project -> subfolder hierarchy in the paths you return (e.g. "ProjectA",
"ProjectA/Models", "ProjectA/Models/Orders"). Prefer to descend at least to the second level so the
mirror cycle has per-subfolder granularity.
${ROLE_TAXONOMY ? 'ROLE HINT: ' + ROLE_TAXONOMY : ''}
${RULES}`,
        { label: `scout:${repoName(root)}#${i}`, phase: 'Scout', model: 'haiku', schema: SCOUT_SCHEMA }
      ))
    }
  }
  const results = (await parallel(scoutJobs)).filter(Boolean)

  // Persist the manifest for later cycles (a cheap agent does the write — the
  // script has no filesystem access). Later cycles read it back via loadOrScout().
  await agent(
`You are a manifest writer. WRITE the following JSON to this exact absolute path (create parent dirs):
${MANIFEST_PATH}

Write it VERBATIM as a single JSON object with this exact shape, and nothing else:
{ "generatedForCycle": 1, "date": "${DATE}", "results": <THE ARRAY BELOW> }

THE ARRAY (already structured; do not edit, just embed it as the "results" value):
${JSON.stringify(results)}

Then return the file path you wrote in filesWritten.`,
    { label: 'scout:persist', phase: 'Scout', model: 'haiku', schema: SUMMARY_SCHEMA }
  )
  log(`Scout: persisted manifest for ${results.length} repo(s) to ${MANIFEST_PATH}`)
  return results
}

// ===========================================================================
// RUN
// ===========================================================================

phase('Scout')
log(`Scout: discovering substantive-folder tree across ${REPO_ROOTS.length || 1} root(s).`)
const scoutResults = await loadOrScout()
const MANIFEST = normalizeManifest(scoutResults)
const GROUPS = groupByProject(MANIFEST)
const OWNERS = partitionIntoOwners(GROUPS, INTEGRATOR_N)
log(`Scout: ${MANIFEST.length} substantive folders, ${GROUPS.length} project groups, ${OWNERS.length} integrator owners.`)
for (const g of GROUPS) log(`  group ${g.repo.split(/[\/]/).pop()}/${g.project} (weight ${g.weight}, ${g.folders.length} folders)`)

if (!MANIFEST.length) {
  log('Scout returned no folders — aborting. Check REPO_ROOTS and the scout output.')
  return { cycle: CYCLE, error: 'empty manifest', repoRoots: REPO_ROOTS }
}

// ---------------------------------------------------------------------------
// CYCLE 4 — AUDIT + FIX (strong model audits; mid model fixes within owned files)
// ---------------------------------------------------------------------------
// One auditor per project group walks L0 -> L1 -> L2 -> L3 and checks three axes:
//   (a) NAVIGATION: L0 routes to the correct L1 README; the L1 routes to the proper
//       L2s; all links resolve to real files.
//   (b) COHERENCE: each L2 aligns with (does not contradict) its L1.
//   (c) ACCURACY: every falsifiable L2 claim verifies against L3 (code/SQL/config).
// Auditors write fix-lists to temp; they do NOT edit docs. The disjoint-ownership
// fixers then apply ONLY the fixes within their owned files (re-verifying first).
// ---------------------------------------------------------------------------
if (AUDIT) {
  const AUDIT_DIR = TEMP + '/_audit'

  phase('Audit')
  log(`Cycle ${CYCLE} = AUDIT: ${GROUPS.length} auditors (opus, strong) walk L0->L1->L2->L3.`)
  const auditResults = (await parallel(GROUPS.map(g => () => {
    const docDirs = g.folders.map(mirroredDocDir)
    return agent(
`You are a documentation AUDITOR. The docs/ tree is built; your job is to find defects, NOT to write docs.

START at ${DOCS}/LLM_MAP.md (L0) and walk the link chain into YOUR SLICE, then audit on three axes:
1. NAVIGATION — does L0 route to the correct L1 README, and does that L1 route to the proper L2(s)? Do all
   links resolve to real files?
2. COHERENCE — does each L2's content ALIGN with its L1 (no contradictions; the L1 correctly generalizes)?
3. ACCURACY — does every falsifiable L2 claim hold against L3 (the actual code/SQL/config)? Re-open the
   cited source files and check. Auditors can be wrong too — confirm against L3 before flagging.

YOUR SLICE = the docs for project "${g.project}" (repo ${g.repo}). Doc dirs to audit:
${docDirs.join('\n')}

WRITE a precise, actionable fix-list to this exact file (create parent dirs): ${AUDIT_DIR}/${sanitize(g.key)}-c${CYCLE}.md
For each issue: the doc file + section, the problem (broken link / wrong claim / L1-L2 mismatch /
missing L2), and the correct fact with an L3 path:line citation. If a slice is clean, say so explicitly.
${RULES}`,
      { label: `audit:${sanitize(g.key)}`, phase: 'Audit', model: 'opus', schema: SUMMARY_SCHEMA }
    )
  }))).filter(Boolean)
  log(`Audit done: ${auditResults.length}/${GROUPS.length} returned. Digest:`)
  for (const r of auditResults) log(`  [${r.area}] ${r.summary}`)

  // SEQUENTIAL fixers (same reasoning as integrate): a later fixer can see the
  // corrections earlier fixers already applied, so cross-link repairs stay
  // consistent. LLM_MAP/STRUCTURE owner (idx 0) runs last. Auditors above stay
  // parallel — they only read docs/code and write disjoint temp fix-lists.
  const FIX_ORDER = [...OWNERS.filter(o => o.idx !== 0), ...OWNERS.filter(o => o.idx === 0)]
  phase('Fix')
  log(`Cycle ${CYCLE}: ${OWNERS.length} fixers (sonnet) apply audit fixes within owned subtrees, SEQUENTIALLY (LLM_MAP owner last).`)
  const fixResults = []
  for (const o of FIX_ORDER) {
    const r = await agent(
`You are a documentation FIXER, running in SEQUENCE after the fixers before you. Apply ONLY the fixes within the files YOU OWN.

${ownershipText(o, OWNERS)}

READ all auditor fix-lists in this directory and act ONLY on items touching your owned files: ${AUDIT_DIR}/
Also read the corrections earlier fixers already applied under ${DOCS}/ this cycle, so your cross-links
stay consistent. Before applying any fix, INDEPENDENTLY confirm it against the cited L3 source (re-open the
file) — auditors can be wrong too, and a fix-list is a lead, not a fact. Apply corrections in place: fix
broken links, correct inaccurate claims, realign L1<->L2, add a missing L2 the audit flagged within your
area. Keep "(observed ${DATE})" markers current. Do not rewrite clean docs.
${L2_NOTE}
${RULES}`,
      { label: `fix:owner${o.idx}`, phase: 'Fix', model: 'sonnet', schema: SUMMARY_SCHEMA }
    )
    if (r) fixResults.push(r)
  }
  log(`Fix done: ${fixResults.length}/${OWNERS.length} returned.`)

  return {
    cycle: CYCLE,
    topology: `${GROUPS.length} auditors (opus) / ${OWNERS.length} fixers (sonnet)`,
    auditors: auditResults.map(r => ({ area: r.area, summary: r.summary, open: r.openQuestions || '' })),
    fixers:   fixResults.map(r => ({ area: r.area, files: r.filesWritten, summary: r.summary, open: r.openQuestions || '' })),
  }
}

// ---------------------------------------------------------------------------
// PHASE — EXPLORE (cheap model, one explorer per substantive folder)
// ---------------------------------------------------------------------------
// GOTCHA (conserve orchestrator context): explorers write FULL findings to the
// gitignored temp/ scratch and return only a 100-250 word summary + the temp path.
// The orchestrator passes PATHS between agents and never reads code/doc files itself.
// ---------------------------------------------------------------------------
const EXPLORERS = buildExplorers(MANIFEST)

phase('Explore')
log(`Cycle ${CYCLE}: ${EXPLORERS.length} explorers (haiku) over ${REPO_ROOTS.length || 1} root(s).`)
const exploreResults = (await parallel(EXPLORERS.map(e => () =>
  agent(
`You are a codebase explorer. ${cycleGoal()}

AREA KEY: ${e.key}
SCOPE (read only what is relevant within this folder; absolute path): ${e.scope}
THIS FOLDER'S INFERRED ROLE: ${e.role || '(unknown — determine it)'}

WRITE your full findings to this exact file (create parent dirs): ${TEMP}/${sanitize(e.key)}/explore-c${CYCLE}.md
Structure it with headings: Inventory (file -> one-line purpose), Role classification, Key types & entry
points, External integrations, Data flow notes, Citations. In cycle >=2 also add: Corrections to existing docs.
${RULES}`,
    { label: `explore:${sanitize(e.key)}`, phase: 'Explore', model: 'haiku', schema: SUMMARY_SCHEMA }
  )
))).filter(Boolean)
log(`Explore done: ${exploreResults.length}/${EXPLORERS.length} returned. Digest:`)
for (const r of exploreResults) log(`  [${r.area}] ${r.summary}`)

// ---------------------------------------------------------------------------
// PHASE — VERIFY + WRITE DRAFTS (mid model, one verifier per PROJECT group)
// Verifiers read their group's explorer temp files, re-verify against code, and
// write polished DRAFT docs mirroring the planned docs/ layout -> temp drafts.
// ---------------------------------------------------------------------------
phase('Verify')
log(`Cycle ${CYCLE}: ${GROUPS.length} verifiers (sonnet).`)
const verifyResults = (await parallel(GROUPS.map(g => () => {
  const tempPaths = g.folders
    .map(buildExplorerKeyFor)
    .map(k => `${TEMP}/${sanitize(k)}/explore-c${CYCLE}.md`)
  const draftDir = `${TEMP}/_drafts/${sanitize(g.key)}`
  return agent(
`You are a documentation verifier/writer. ${cycleGoal()}

YOUR SLICE = project "${g.project}" (repo ${g.repo}).
READ these explorer note files (some may be missing if an explorer failed — work with what exists):
${tempPaths.join('\n')}
Also re-read the relevant code yourself to VERIFY claims. Multiple explorers agreeing is NOT proof — check
the code with path:line citations.

Produce verified DRAFT docs in a NESTED layout that MIRRORS the code subfolders of this project:
- a project-level README.md (the L1 generalizing across the project's L2s),
- per substantive subfolder, a README.md (a folder L1) plus an L2 per intricate thing inside it.
Each README is an L1 that GENERALIZES across its folder's children; each L2 is the specific workings of
one thing, derived from and citing L3.
${L2_NOTE}

WRITE your DRAFT doc files under this exact directory (create it; one file per L1/L2, mirroring the planned
docs/ subtree for this project): ${draftDir}/
${RULES}`,
    { label: `verify:${sanitize(g.key)}`, phase: 'Verify', model: 'sonnet', schema: SUMMARY_SCHEMA }
  )
}))).filter(Boolean)
log(`Verify done: ${verifyResults.length}/${GROUPS.length} returned. Digest:`)
for (const r of verifyResults) log(`  [${r.area}] ${r.summary}`)

// ---------------------------------------------------------------------------
// PHASE — INTEGRATE INTO docs/ (mid model, DISJOINT-OWNERSHIP owners, SEQUENTIAL)
// Each owner builds the real docs/ for its assigned project subtrees ONLY. Exactly
// one owner (index 0) additionally owns LLM_MAP.md + STRUCTURE.md.
//
// WRITERS RUN SEQUENTIALLY (one at a time), not in parallel. Disjoint FILE ownership
// stops two writers clobbering the same file, but NOT two writers documenting the
// same cross-cutting concept from different angles. Sequencing + a read-prior
// instruction closes that gap: each integrator reads what earlier ones just
// published and LINKS instead of re-documenting. The LLM_MAP/STRUCTURE owner (idx 0)
// runs LAST so its links resolve to docs that already exist on disk. Heaviest-first
// order otherwise → central docs land first to link against. (Explorers/verifiers
// above stay parallel — they read code / write disjoint scratch, so no concept
// clobber.) NOTE: the partition/ownership is UNCHANGED — only execution order is.
// ---------------------------------------------------------------------------
const INTEGRATE_ORDER = [...OWNERS.filter(o => o.idx !== 0), ...OWNERS.filter(o => o.idx === 0)]
phase('Integrate')
log(`Cycle ${CYCLE}: ${OWNERS.length} integrators (sonnet) build docs/ over disjoint subtrees, SEQUENTIALLY (LLM_MAP owner last).`)
const integrateResults = []
for (const o of INTEGRATE_ORDER) {
  // Each owner reads the drafts for the project groups it owns.
  const draftDirs = o.groups.map(g => `${TEMP}/_drafts/${sanitize(g.key)}`)
  const r = await agent(
`You are a documentation integrator, running in SEQUENCE after the integrators before you this cycle. ${cycleGoal()}

${ownershipText(o, OWNERS)}

SOURCE DRAFTS to fold in (read these dirs):
${draftDirs.join('\n')}

BEFORE writing, read what already exists under ${DOCS}/ — both prior cycles AND the docs the earlier
integrators THIS cycle just published. If a cross-cutting concept is already documented, LINK to its
existing home instead of re-documenting it from a different angle. Then build/refresh the real docs in
${DOCS}/ from your drafts, but INDEPENDENTLY SPOT-CHECK key claims against the code before publishing
(re-open the cited files — drafts and existing docs are hypotheses; the code is the truth). Follow the
TIER MODEL. Write L2s in depth (responsibilities, signatures, request/response shapes, schema where
relevant, invariants, gotchas) with "(observed ${DATE})" markers, and write each L1 README as cross-cutting
SYNTHESIS over its L2s — NOT a bare file list. Mirror the code tree:
${DOCS}/<repoName>/<Project>/<Subfolder>/README.md (L1) + L2s. Make every relative link a valid path to a
doc or source file that EXISTS (you run after the others, so the files they wrote are already on disk).
${L2_NOTE}
${RULES}`,
    { label: `integrate:owner${o.idx}`, phase: 'Integrate', model: 'sonnet', schema: SUMMARY_SCHEMA }
  )
  if (r) integrateResults.push(r)
}
log(`Integrate done: ${integrateResults.length}/${OWNERS.length} returned.`)

// ---------------------------------------------------------------------------
// Compact digest for the orchestrator to review between cycles.
// (The orchestrator then runs `doc_lint.py` and commits per the doc-maintenance skill.)
// ---------------------------------------------------------------------------
return {
  cycle: CYCLE,
  topology: `${EXPLORERS.length} explorers / ${GROUPS.length} verifiers / ${OWNERS.length} integrators`,
  explorers:   exploreResults.map(r => ({ area: r.area, summary: r.summary, open: r.openQuestions || '' })),
  verifiers:   verifyResults.map(r => ({ area: r.area, summary: r.summary, open: r.openQuestions || '' })),
  integrators: integrateResults.map(r => ({ area: r.area, files: r.filesWritten, summary: r.summary, open: r.openQuestions || '' })),
}

// ===========================================================================
// SMALL HELPERS (declared last; function declarations hoist, so order is fine)
// ===========================================================================

// Filesystem-safe key for temp paths / labels.
function sanitize(s) { return String(s).replace(/[^A-Za-z0-9._-]/g, '_') }

// Recompute the explorer key for a manifest folder (must match buildExplorers()).
function buildExplorerKeyFor(m) {
  return `${m.repo.split(/[\/]/).pop()}.${m.rel}`.replace(/[^A-Za-z0-9._-]/g, '_')
}

// Render an owner's ownership block for its prompt: the project subtrees it owns,
// plus the root-files clause for owner 0 only. Disjointness is enforced by telling
// each owner the EXACT set of docs paths it may write and that others own the rest.
function ownershipText(owner, allOwners) {
  const subtrees = owner.groups.map(g => `  - ${DOCS}/${repoName(g.repo)}/${g.project}/  (entire subtree: nested README.md L1s + L2s)`)
  const rootClause = owner.idx === 0
    ? `\nYou are ALSO the ROOT owner — the ONLY writer of:\n  - ${DOCS}/LLM_MAP.md (L0)\n  - ${DOCS}/STRUCTURE.md (the tier contract + docs/ folder layout). If STRUCTURE.md is missing, create it: define the L0/L1/L2/L3 tier contract and that docs/ mirrors <repoName>/<Project>/<Subfolder>/. You run LAST this cycle, so every other owner's docs are already on disk — in LLM_MAP.md, link to EVERY project README using its mirrored path and CONFIRM each link resolves to a file that exists.`
    : `\nYou do NOT own LLM_MAP.md or STRUCTURE.md (owner 0 owns those, and writes them last). Do not write them.`
  return `YOUR OWNERSHIP (write ONLY these paths — the other ${allOwners.length - 1} owner(s) own the rest; ` +
         `writing outside your set risks overwriting their work):\n${subtrees.join('\n')}${rootClause}`
}
