#!/usr/bin/env node
// codebase-docs plugin asset — check-doc-cites.mjs
// codebase-docs-plugin-asset-version: {{PLUGIN_ASSET_VERSION}}
//
// A zero-dependency, zero-network Node ESM script that keeps a repo's
// `§ symbolName` doc-citation convention (see the sibling
// STRUCTURE-citation-section.template.md for the full grammar) from silently
// drifting out of sync with the code it cites, and enforces the per-doc
// frontmatter contract (`covers`/`related`/`status`[/`status_note`]).
//
// This is the GENERIC engine: it carries no stack-specific assumptions.
// Every repo-specific fact (which doc directories are in scope, which
// declaration shapes count as "a real named thing" beyond the built-in
// per-language table below, whether the heading-anchor check can assume
// GitHub's slug algorithm, which extensions the old-style-cite sweep should
// consider) lives in a sibling `doc-cite-config.json` read at a fixed
// `__dirname`-relative path — never a flag, never an env var (this asset's
// whole family of scripts is zero-flags by convention: everything a repo
// needs to customize lives in one config file next to the script).
//
// This file is installed **verbatim, byte-for-byte, never hand-edited** into
// a target repo (see docs-migrate/SKILL.md and docs-init-or-improve/SKILL.md
// for the install procedure) — the ONLY substitution performed at install
// time is the `{{PLUGIN_ASSET_VERSION}}` placeholder above, mechanically
// replaced with the installing plugin's own version (a human-readable echo
// of doc-cite-config.json's own `_pluginAssetVersion` field — never an
// independent fact to keep in sync by hand).
//
// Two citation conventions coexist in a target repo's docs (both documented
// in that repo's docs/STRUCTURE.md, installed from
// STRUCTURE-citation-section.template.md) and this script deliberately
// treats them differently:
//   1. CODE CITATION — `path/from/repo/root.ext § symbolName` — a BARE,
//      UNQUOTED identifier (or dot-form / key-path form) after ` § `. This
//      is the convention this lint enforces (checks 1+2 below).
//   2. DOC-SECTION CROSS-REFERENCE — `doc.md § "quoted phrase"` — a
//      PRE-EXISTING idiom some repos already use, pointing at a section of
//      another doc by its heading text, always inside a markdown link. The
//      symbol part is QUOTED, which is exactly what excludes it from checks
//      1+2 by construction (the citation regex's symbol capture group
//      explicitly refuses to start with `"` or `'`) — never converted, never
//      symbol-existence-checked, entirely out of this lint's scope. A repo
//      being migrated onto this convention must be searched for this
//      pre-existing idiom BEFORE assuming `§` is free to use as a fresh
//      separator (see docs-migrate/SKILL.md STEP 2, rule 7).
//
// Usage: node check-doc-cites.mjs
//   Exits 0 (all checks pass) or 1 (prints every violation, grouped by
//   check, then exits non-zero). No flags for normal operation.
// Usage: node check-doc-cites.mjs --self-test
//   Runs this asset's own correctness self-test (pure-function + a scratch
//   filesystem integration proof) and exits 0/1. NEVER reads the installed
//   doc-cite-config.json and NEVER touches the target repo's own docs/code
//   when this flag is passed — see runSelfTest() below.

import {
  readFileSync,
  existsSync,
  statSync,
  readdirSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config loading (§3.1 of the design doc this asset ships from) — repo-
// specific facts live in a sibling JSON file, never hardcoded here.
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  scopedDocDirs: [],
  docsRoot: "docs",
  knownCiteExtensions: [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "yml", "yaml",
    "html", "css", "md", "py", "go", "rs", "java", "cs", "rb",
  ],
  generatedPathPrefixes: [],
  headingSlugAlgorithm: "none",
  extraDeclarationPatterns: [],
};

function loadConfig() {
  const configPath = join(__dirname, "doc-cite-config.json");
  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    console.error(
      `check-doc-cites: doc-cite-config.json failed to parse (${e.message}) — falling back to built-in defaults (fail-safe, never crash)`,
    );
    return { ...DEFAULT_CONFIG };
  }
}

// ---------------------------------------------------------------------------
// Citation regex — the symbol-capture group is anchored to NEVER start with
// a quote character, which is what excludes `doc.md § "quoted phrase"`
// cross-references by construction rather than by a secondary allowlist.
// ---------------------------------------------------------------------------

// Bounded quantifiers ({1,240} / {1,20}), not unbounded `+` (ReDoS fix): the
// original `[\w./@-]+\.\w+` has an ambiguous prefix — the leading class
// already contains `.`, so on a long run with no eventual matching suffix
// the engine backtracks over every split point at every start offset
// (O(n^2), measured 53s on a 128k adversarial blob). Capping both repeats
// bounds the worst-case backtracking cost per start position to a constant,
// turning the scan back into O(n) total. 240/20 comfortably covers any real
// repo-relative path/extension while eliminating the unbounded blowup.
const PATH_RE_SRC = String.raw`[\w./@-]{1,240}\.\w{1,20}`;
const IDENT_RE_SRC = String.raw`[A-Za-z_$][\w$-]*`;
const SYMBOL_SEGMENT_RE_SRC = String.raw`${IDENT_RE_SRC}|\["[^"]*"\]|\['[^']*'\]|\[\d+\]`;
const SYMBOL_RE_SRC = String.raw`(?:${SYMBOL_SEGMENT_RE_SRC})(?:\.(?:${IDENT_RE_SRC})|\["[^"]*"\]|\['[^']*'\]|\[\d+\])*`;
const CITATION_RE = new RegExp(String.raw`(${PATH_RE_SRC})\s§\s(${SYMBOL_RE_SRC})`, "g");

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGeneratedPath(p, config) {
  return config.generatedPathPrefixes.some((prefix) => p.startsWith(prefix));
}

/** `_scriptInstallDir` must be a SINGLE path segment (e.g. "scripts",
 *  "tools") directly under the repo root — REPO_ROOT is computed as
 *  `resolve(__dirname, "..")`, which is only correct one level below the
 *  real repo root. A nested value (e.g. "packages/foo/scripts", from a
 *  monorepo install) would silently miscompute REPO_ROOT to the wrong
 *  ancestor, which in turn would make every containment check below (the
 *  path-traversal guard) validate against the WRONG boundary. Refuse to run
 *  rather than silently operate against a miscomputed root. */
function assertScriptInstallDirIsSingleSegment(config) {
  const val = config._scriptInstallDir;
  if (typeof val !== "string" || val === "") return; // not set — nothing to validate
  if (val.includes("/") || val.includes("\\")) {
    console.error(
      `check-doc-cites: doc-cite-config.json's "_scriptInstallDir" ("${val}") contains a path separator — ` +
        `only a single directory name directly under the repo root is supported (REPO_ROOT is computed as ` +
        `one level above this script's own install location). A nested install path would make REPO_ROOT, ` +
        `and therefore every path-containment check, resolve against the wrong boundary. Refusing to run.`,
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Path-containment guard (security fix): every doc-authored path (a
// `covers`/`§`-citation target, or a heading-anchor link target) must
// resolve to somewhere INSIDE repoRoot before this script ever calls
// existsSync/statSync/readFileSync on it. Without this, `join(repoRoot,
// "../outside/secret.ts")` or a symlink planted inside the repo pointing
// outside it would let a doc's `covers:`/§-citation/heading-link content
// make the lint read (and get a declaration/heading-slug match signal for)
// ANY file the process can read — a path-traversal / symlink-escape oracle.
// Fix: canonicalize (realpathSync) the resolved candidate AND repoRoot, and
// require the real candidate path to be repoRoot itself or nested under it
// (`sep`-prefixed) — this catches BOTH literal `../` sequences (they
// resolve outside the prefix even before symlink-following) AND an
// in-repo symlink that points outside (caught only after realpath
// resolution, since the pre-realpath path itself looks perfectly
// in-bounds). A candidate that doesn't exist yet can't be realpath'd; the
// plain prefix check on the un-resolved candidate is the best available
// signal in that case (the subsequent existsSync-based violation handles
// "doesn't exist" separately either way).
// ---------------------------------------------------------------------------

const REALPATH_CACHE = new Map();
function cachedRealpath(p) {
  if (REALPATH_CACHE.has(p)) return REALPATH_CACHE.get(p);
  let real;
  try {
    real = realpathSync(p);
  } catch {
    real = null;
  }
  REALPATH_CACHE.set(p, real);
  return real;
}

function isPathContained(repoRoot, absCandidate) {
  const withinPrefix = absCandidate === repoRoot || absCandidate.startsWith(repoRoot + sep);
  if (!withinPrefix) return false;
  if (!existsSync(absCandidate)) {
    // Nothing to realpath yet (target doesn't exist) — the un-resolved
    // prefix check above is the strongest signal available; a downstream
    // existsSync-based violation reports "doesn't exist" separately.
    return true;
  }
  const realCandidate = cachedRealpath(absCandidate);
  const realRoot = cachedRealpath(repoRoot);
  if (realCandidate === null || realRoot === null) return false;
  return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
}

function listScopedMarkdownFiles(repoRoot, config) {
  // Non-recursive by design (v1 scope, see plan §3.1 R4b): readdirSync of
  // direct children only per scopedDocDirs entry. A repo with genuinely
  // nested doc subdirectories lists each nested dir as its own entry.
  const files = [];
  for (const dir of config.scopedDocDirs) {
    const abs = join(repoRoot, dir);
    if (!existsSync(abs)) continue;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(join(dir, entry.name));
      }
    }
  }
  return files.sort();
}

// ---------------------------------------------------------------------------
// Heading-anchor check — GitHub-specific by construction (headingSlugAlgorithm
// config knob; "none" disables this check as a no-op rather than guessing at
// a non-GitHub forge's slug rules). The mechanism (code-fence/inline-code
// stripping, de-duplication-suffix handling, link-target resolution) is
// generic; only the slug algorithm itself is GitHub's own rendering behavior.
// ---------------------------------------------------------------------------

function githubHeadingSlug(headingText) {
  const plain = headingText
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\*([^*]*)\*/g, "$1")
    .replace(/^#+\s*/, "");
  return plain
    .toLowerCase()
    .replace(/[^\w\- ]/g, "")
    .replace(/ /g, "-");
}

function stripCodeForAnchorScan(text) {
  const lines = text.split("\n");
  let inFence = false;
  const out = [];
  for (let line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    if (inFence) {
      out.push("");
      continue;
    }
    line = line.replace(/``[^`]*``/g, (m) => " ".repeat(m.length));
    line = line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
    out.push(line);
  }
  return out.join("\n");
}

// Strips ONLY fenced ``` code blocks (not inline `code spans`, unlike
// stripCodeForAnchorScan) — used before the CITATION_RE body scan and the
// old-style-cite sweep, both of which scan the whole doc body with a
// path-shaped regex. This is a ReDoS defense-in-depth measure alongside the
// bounded PATH_RE_SRC above: large adversarial/incidental blobs (base64
// data URIs, pasted hashes/logs) realistically live inside fences, and
// skipping them removes the largest practical attack surface while still
// scanning genuine inline citations (which are never fenced). Mirrors the
// heading-anchor check's own fence-skipping discipline (stripCodeForAnchorScan),
// applied here to the two other whole-body regex scans that lacked it.
function stripFencedCodeBlocksOnly(text) {
  const lines = text.split("\n");
  let inFence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    if (inFence) {
      out.push("");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function extractHeadingSlugs(absPath, cache) {
  if (cache.has(absPath)) return cache.get(absPath);
  const rawText = readFileSync(absPath, "utf8");
  const slugs = new Set();
  const counts = new Map();
  let inFence = false;
  for (const rawLine of rawText.split("\n")) {
    if (/^\s*```/.test(rawLine)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = rawLine.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    let slug = githubHeadingSlug(m[2]);
    const n = counts.get(slug) || 0;
    counts.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;
    slugs.add(slug);
  }
  cache.set(absPath, slugs);
  return slugs;
}

function listAllDocsMarkdownFiles(repoRoot, config) {
  const docsAbs = join(repoRoot, config.docsRoot);
  const files = [];
  if (!existsSync(docsAbs)) return files;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(join(config.docsRoot, abs.slice(docsAbs.length + 1)));
      }
    }
  }
  walk(docsAbs);
  return files.sort();
}

const HEADING_LINK_RE = /\]\(([^)]+\.md#[^)]+)\)/g;

function checkHeadingAnchors(repoRoot, config, violations) {
  if (config.headingSlugAlgorithm !== "github") return; // disabled — "skip, don't guess"
  const cache = new Map();
  for (const relPath of listAllDocsMarkdownFiles(repoRoot, config)) {
    const absPath = join(repoRoot, relPath);
    const text = stripCodeForAnchorScan(readFileSync(absPath, "utf8"));
    let m;
    const re = new RegExp(HEADING_LINK_RE.source, "g");
    while ((m = re.exec(text))) {
      const target = m[1];
      const hashIdx = target.indexOf("#");
      const targetRelPath = target.slice(0, hashIdx);
      const fragment = target.slice(hashIdx + 1);
      if (/^https?:\/\//.test(targetRelPath)) continue;
      const targetAbs = resolve(dirname(absPath), targetRelPath);
      if (!isPathContained(repoRoot, targetAbs)) {
        violations.push(
          `[heading-anchor] ${relPath}: link target "${targetRelPath}" resolves outside the repository root (blocked: path-traversal or symlink escape)`,
        );
        continue;
      }
      if (!existsSync(targetAbs) || !statSync(targetAbs).isFile()) {
        violations.push(
          `[heading-anchor] ${relPath}: link target "${targetRelPath}" does not exist (linked as #${fragment})`,
        );
        continue;
      }
      const slugs = extractHeadingSlugs(targetAbs, cache);
      if (!slugs.has(fragment)) {
        violations.push(
          `[heading-anchor] ${relPath}: fragment "#${fragment}" does not match any heading's GitHub slug in "${targetRelPath}" (heading text changed since the link was written — update the link's anchor to the current slug)`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Frontmatter — a deliberately restricted flat grammar: a `---`-delimited
// block with EXACTLY three-or-four top-level scalar/list keys (`covers`,
// `related`, `status`, optional `status_note`), each a YAML block list
// (`- "..."`) or a bare scalar. No nested maps, no multiline scalars, no
// flow-style `[a, b]` — restricted specifically so this hand-rolled parser
// suffices and no js-yaml dependency needs adding.
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { error: "missing opening `---` frontmatter delimiter" };
  }
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") {
    return { error: "missing opening `---` frontmatter delimiter" };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { error: "missing closing `---` frontmatter delimiter" };
  }
  const block = lines.slice(1, end);
  const data = {};
  let currentKey = null;
  for (const raw of block) {
    if (raw.trim() === "") continue;
    const listItemMatch = /^\s*-\s+(.*)$/.exec(raw);
    if (listItemMatch && currentKey) {
      const val = stripQuotes(listItemMatch[1].trim());
      data[currentKey].push(val);
      continue;
    }
    const kvMatch = /^([A-Za-z_]+):\s*(.*)$/.exec(raw);
    if (kvMatch) {
      const key = kvMatch[1];
      const rest = kvMatch[2].trim();
      if (rest === "" || rest === "[]") {
        data[key] = [];
        currentKey = rest === "[]" ? null : key;
        continue;
      }
      currentKey = null;
      data[key] = rest === "null" ? null : stripQuotes(rest);
      continue;
    }
    return { error: `unparseable frontmatter line: ${JSON.stringify(raw)}` };
  }
  return { data, bodyStartLine: end + 1 };
}

/** Pure, standalone frontmatter-well-formedness check (factored out of
 *  main()'s file-scan loop so it's directly unit-testable in Layer 1
 *  without needing a real file on disk — this is the exact logic that was
 *  previously ONLY reachable via main()'s inline loop, which the self-test
 *  never exercised with a bad fixture: it only round-tripped parseFrontmatter
 *  itself, never asserted a violation is actually emitted for bad data).
 *  Returns an array of violation-message SUFFIXES (caller prefixes with
 *  `[frontmatter] <relPath>: `). */
function checkFrontmatterWellFormedness(data) {
  const violations = [];
  if (!("covers" in data) || !Array.isArray(data.covers) || data.covers.length === 0) {
    violations.push("`covers` must be a non-empty list");
  }
  if (!("related" in data) || !Array.isArray(data.related)) {
    violations.push("`related` must be a list (may be empty [])");
  }
  if (!("status" in data) || (data.status !== "current" && data.status !== "historical")) {
    violations.push(`\`status\` must be exactly "current" or "historical" (found ${JSON.stringify(data.status)})`);
  }
  return violations;
}

function stripQuotes(s) {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Declaration-boundary matcher (§3.2) — per-extension keyword table, keyed
// off the target file's extension instead of assuming JS/TS everywhere.
// Deliberately NOT a raw substring test (the `getGuest`/`getGuestById`
// false-PASS this whole check exists to prevent).
// ---------------------------------------------------------------------------

const LANGUAGE_DECL_KEYWORDS = {
  ".ts": ["function", "const", "class", "interface", "type", "let", "var"],
  ".tsx": ["function", "const", "class", "interface", "type", "let", "var"],
  ".js": ["function", "const", "class", "interface", "type", "let", "var"],
  ".jsx": ["function", "const", "class", "interface", "type", "let", "var"],
  ".mjs": ["function", "const", "class", "interface", "type", "let", "var"],
  ".cjs": ["function", "const", "class", "interface", "type", "let", "var"],
  ".py": ["def", "class"],
  ".go": ["func", "type"],
  ".rs": ["fn", "struct", "enum", "trait", "const", "static"],
  ".java": ["class", "interface", "enum", "record"],
  ".cs": ["class", "interface", "enum", "record"],
  ".kt": ["class", "interface", "enum", "record"],
  ".swift": ["class", "interface", "enum", "record"],
  ".rb": ["def", "class", "module"],
};

const DECL_RE_CACHE = new Map();
function declarationRegexFor(symbol, ext) {
  const keywords = LANGUAGE_DECL_KEYWORDS[ext];
  if (!keywords) return null;
  const cacheKey = `${ext}::${symbol}`;
  if (DECL_RE_CACHE.has(cacheKey)) return DECL_RE_CACHE.get(cacheKey);
  const escaped = escapeRegex(symbol);
  const kw = keywords.join("|");
  const re = new RegExp(
    String.raw`\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:pub\s+)?(?:${kw})\s+${escaped}\b`,
  );
  DECL_RE_CACHE.set(cacheKey, re);
  return re;
}

const EXTRA_PATTERN_RE_CACHE = new Map();
function extraPatternRegexFor(pattern, symbol) {
  const cacheKey = `${pattern.label}::${symbol}`;
  if (EXTRA_PATTERN_RE_CACHE.has(cacheKey)) return EXTRA_PATTERN_RE_CACHE.get(cacheKey);
  const escaped = escapeRegex(symbol);
  const source = pattern.regexTemplate.replace(/\{SYMBOL\}/g, escaped);
  const re = new RegExp(source);
  EXTRA_PATTERN_RE_CACHE.set(cacheKey, re);
  return re;
}

function extPatternsForExt(config, extNoDot) {
  return config.extraDeclarationPatterns.filter((p) => p.ext.includes(extNoDot));
}

/** Splits a symbol into its dot/bracket path segments, e.g.
 *  `Outer.inner` -> ["Outer","inner"], `scripts["db:reset"]` -> ["scripts","db:reset"]. */
function splitSymbolPath(symbol) {
  const segs = [];
  const re = /([A-Za-z_$][\w$-]*)|\["([^"]*)"\]|\['([^']*)'\]|\[(\d+)\]/g;
  let m;
  while ((m = re.exec(symbol))) {
    segs.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  }
  return segs;
}

function symbolDeclaredAsHead(symbol, extNoDotDot, ext, config) {
  const declRe = declarationRegexFor(symbol, ext);
  return declRe !== null && declRe.test(extNoDotDot);
}

function symbolExistsInSource(sourceText, symbol, ext, config) {
  const extNoDot = ext.replace(/^\./, "");
  const segs = splitSymbolPath(symbol);
  if (segs.length === 1) {
    const declRe = declarationRegexFor(segs[0], ext);
    if (declRe && declRe.test(sourceText)) return true;
    for (const pat of extPatternsForExt(config, extNoDot)) {
      if (extraPatternRegexFor(pat, segs[0]).test(sourceText)) return true;
    }
    return false;
  }
  // Dot form (component.method / class.member): head must be a declared
  // component/function/const/class (built-in table OR an extra pattern),
  // tail must appear as a member inside SOME block in the source.
  const [head, ...tail] = segs;
  const headDeclRe = declarationRegexFor(head, ext);
  const headDeclared =
    (headDeclRe && headDeclRe.test(sourceText)) ||
    extPatternsForExt(config, extNoDot).some((pat) => extraPatternRegexFor(pat, head).test(sourceText));
  if (!headDeclared) return false;
  const last = tail[tail.length - 1];
  const memberRe = new RegExp(String.raw`\b${escapeRegex(last)}\s*[:(]`);
  return memberRe.test(sourceText);
}

/** JSON/YAML key-path anchors: walk the parsed structure instead of
 *  regexing. Only JSON is walked structurally; YAML key-path targets fall
 *  back to a scoped text search for the key/step name. Already fully
 *  generic — no stack assumptions. */
function keyPathExistsInJson(jsonText, symbol) {
  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch {
    return false;
  }
  const segs = splitSymbolPath(symbol);
  let cur = obj;
  for (const seg of segs) {
    if (cur == null || typeof cur !== "object") return false;
    if (!(seg in cur)) return false;
    cur = cur[seg];
  }
  return true;
}

function keyPathExistsInYamlText(yamlText, symbol) {
  const segs = splitSymbolPath(symbol);
  const last = segs[segs.length - 1];
  if (/^\d+$/.test(last) === false && segs.includes("steps")) {
    return yamlText.includes(`name: ${last}`) || yamlText.includes(`name: "${last}"`);
  }
  return new RegExp(String.raw`^\s*${escapeRegex(last)}:`, "m").test(yamlText);
}

function checkKeyPathAnchor(absPath, symbol) {
  const text = readFileSync(absPath, "utf8");
  if (absPath.endsWith(".json")) return keyPathExistsInJson(text, symbol);
  if (absPath.endsWith(".yml") || absPath.endsWith(".yaml")) return keyPathExistsInYamlText(text, symbol);
  return null;
}

// ---------------------------------------------------------------------------
// Exception-list parsing (check 4) — header row: doc_path\tcite_text\tmin_line_count\treason
// ---------------------------------------------------------------------------

function parseExceptionsTsv(absPath) {
  if (!existsSync(absPath)) return { rows: [], error: null };
  const text = readFileSync(absPath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], error: null };
  const header = lines[0].split("\t");
  const expected = ["doc_path", "cite_text", "min_line_count", "reason"];
  if (header.join("\t") !== expected.join("\t")) {
    return { rows: [], error: `malformed header (expected ${expected.join("\\t")})` };
  }
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length !== 4) {
      return { rows: [], error: `malformed row ${i + 1}: ${JSON.stringify(lines[i])}` };
    }
    rows.push({
      docPath: cols[0],
      citeText: cols[1],
      minLineCount: Number(cols[2]),
      reason: cols[3],
      lineNo: i + 1,
    });
  }
  return { rows, error: null };
}

function extOf(path) {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx);
}

/** Factored out of main() so it's directly testable (ReDoS timing self-test
 *  below) without needing to invoke the whole file-scan pipeline. Bounded
 *  leading class ({1,240}) — see PATH_RE_SRC's own comment for the same
 *  ambiguous-prefix backtracking rationale this mirrors. */
function buildOldStyleCiteRe(config) {
  const extAlternation = config.knownCiteExtensions.map(escapeRegex).join("|");
  return new RegExp(
    "`?([\\w./@-]{1,240}\\.(?:" + extAlternation + ")):(\\d+(?:[-–]\\d+)?(?:,\\s*\\d+(?:[-–]\\d+)?)*)`?",
    "g",
  );
}

// NOTE (bug fix, aligned with PATH_RE_SRC/CITATION_RE which both include
// `@` for scoped-package-shaped paths, e.g. `node_modules/@scope/pkg/...`):
// this hand-rolled parser previously omitted `@`, so an `@`-containing
// `covers` entry silently fell through the `return; // not a citation
// shape` branch below and skipped file-exists/symbol-exists checking
// entirely. Kept in sync with PATH_RE_SRC's character class deliberately —
// see also `stripCiteSuffix` in doc-drift-status.mjs, which has the exact
// same grammar and needed the same fix.
const COVERS_CITATION_RE = /^([\w./@-]+\.\w+)\s§\s(.+)$/;
const COVERS_BARE_PATH_RE = /^[\w./@-]+\.\w+$/;

function checkOneCitation(repoRoot, config, relPath, context, citationText, violations, seenOut) {
  const parsed = COVERS_CITATION_RE.exec(citationText.trim());
  let path, symbol;
  if (parsed) {
    [, path, symbol] = parsed;
  } else if (COVERS_BARE_PATH_RE.test(citationText.trim())) {
    path = citationText.trim();
    symbol = null;
  } else {
    return; // not a citation shape
  }

  seenOut.push({ relPath, context, path, symbol });

  if (isGeneratedPath(path, config)) return;

  const absTarget = join(repoRoot, path);
  if (!isPathContained(repoRoot, absTarget)) {
    violations.push(
      `[cited-file-exists] ${relPath} (${context}): "${path}" resolves outside the repository root (blocked: path-traversal or symlink escape)`,
    );
    return;
  }
  if (!existsSync(absTarget)) {
    violations.push(`[cited-file-exists] ${relPath} (${context}): "${path}" does not exist`);
    return;
  }
  if (symbol === null) return;

  const stat = statSync(absTarget);
  if (!stat.isFile()) {
    violations.push(`[cited-file-exists] ${relPath} (${context}): "${path}" is not a file`);
    return;
  }

  if (absTarget.endsWith(".json") || absTarget.endsWith(".yml") || absTarget.endsWith(".yaml")) {
    const result = checkKeyPathAnchor(absTarget, symbol);
    if (result === false) {
      violations.push(`[symbol-appears-in-file] ${relPath} (${context}): key path "${symbol}" not found in ${path}`);
    }
    return;
  }

  const sourceText = readFileSync(absTarget, "utf8");
  const ext = extOf(path);
  if (!symbolExistsInSource(sourceText, symbol, ext, config)) {
    violations.push(
      `[symbol-appears-in-file] ${relPath} (${context}): symbol "${symbol}" not found (declaration-boundary match) in ${path}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(repoRoot, config) {
  const violations = [];
  const files = listScopedMarkdownFiles(repoRoot, config);
  const allCitationsSeen = [];

  for (const relPath of files) {
    const absPath = join(repoRoot, relPath);
    const text = readFileSync(absPath, "utf8");

    const fm = parseFrontmatter(text);
    if (fm.error) {
      violations.push(`[frontmatter] ${relPath}: ${fm.error}`);
    } else {
      const data = fm.data;
      for (const fmViolation of checkFrontmatterWellFormedness(data)) {
        violations.push(`[frontmatter] ${relPath}: ${fmViolation}`);
      }
      if (Array.isArray(data.covers)) {
        for (const entry of data.covers) {
          checkOneCitation(repoRoot, config, relPath, `frontmatter covers: ${entry}`, entry, violations, allCitationsSeen);
        }
      }
    }

    // Strip fenced code blocks before scanning (ReDoS defense-in-depth +
    // avoids false-flagging an illustrative citation shown inside a fence).
    const strippedBody = stripFencedCodeBlocksOnly(text);
    let m;
    const bodyRe = new RegExp(CITATION_RE.source, "g");
    while ((m = bodyRe.exec(strippedBody))) {
      const [full, path, symbol] = m;
      checkOneCitation(repoRoot, config, relPath, full, `${path} § ${symbol}`, violations, allCitationsSeen);
    }
  }

  const exceptionsAbsPath = join(__dirname, "doc-cite-exceptions.tsv");
  const { rows: exceptionRows, error: tsvError } = parseExceptionsTsv(exceptionsAbsPath);
  if (tsvError) {
    violations.push(`[exceptions] doc-cite-exceptions.tsv: ${tsvError}`);
  }

  for (const row of exceptionRows) {
    const citedAbs = join(repoRoot, row.citeText.split(":")[0]);
    if (!existsSync(citedAbs)) {
      violations.push(
        `[exceptions] doc-cite-exceptions.tsv:${row.lineNo}: cited file for exception "${row.citeText}" does not exist: ${row.citeText.split(":")[0]}`,
      );
      continue;
    }
    const realLineCount = readFileSync(citedAbs, "utf8").split(/\r?\n/).length;
    if (realLineCount < row.minLineCount) {
      violations.push(
        `[exceptions] doc-cite-exceptions.tsv:${row.lineNo}: "${row.citeText}" min_line_count=${row.minLineCount} but ${row.citeText.split(":")[0]} now has only ${realLineCount} lines (file shrank past the cited line — stale exception)`,
      );
    }
    const docAbs = join(
      repoRoot,
      row.docPath.startsWith(config.docsRoot + "/") ? row.docPath : `${config.docsRoot}/${row.docPath}`,
    );
    if (!existsSync(docAbs)) {
      violations.push(`[exceptions] doc-cite-exceptions.tsv:${row.lineNo}: doc_path does not exist: ${row.docPath}`);
      continue;
    }
    const docText = readFileSync(docAbs, "utf8");
    if (!docText.includes(row.citeText)) {
      violations.push(
        `[exceptions] doc-cite-exceptions.tsv:${row.lineNo}: cite text "${row.citeText}" no longer appears in ${row.docPath} (stale-forward exception — the doc's cite was already fixed/removed; delete this row)`,
      );
    }
  }

  checkHeadingAnchors(repoRoot, config, violations);

  // No-silent-leftovers: every literal `file.ext:NN`-shaped citation still
  // present anywhere in the scoped doc dirs must have a matching exception row.
  // Fenced-code stripped before the scan (below) — ReDoS defense-in-depth.
  const oldStyleCiteRe = buildOldStyleCiteRe(config);
  const exceptionTexts = new Set(exceptionRows.map((r) => r.citeText));
  for (const relPath of files) {
    const absPath = join(repoRoot, relPath);
    const text = stripFencedCodeBlocksOnly(readFileSync(absPath, "utf8"));
    let m;
    const re = new RegExp(oldStyleCiteRe.source, "g");
    while ((m = re.exec(text))) {
      const full = m[0];
      const literal = `${m[1]}:${m[2].split(",")[0].trim()}`;
      if (!/\.[A-Za-z0-9]+$/.test(m[1])) continue;
      const tracked = exceptionTexts.has(literal) || [...exceptionTexts].some((t) => t.startsWith(m[1]));
      if (!tracked) {
        violations.push(
          `[no-silent-leftovers] ${relPath}: un-converted, un-tracked line cite "${full}" — convert to \`§ symbol\` form or add a doc-cite-exceptions.tsv row`,
        );
      }
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Self-test (--self-test flag only; never touches a real target repo).
// Layer 1: pure-function / in-memory. Layer 2: real-filesystem integration
// against a throwaway scratch dir under os.tmpdir().
// ---------------------------------------------------------------------------

function assert(cond, msg) {
  if (!cond) {
    console.error(`SELF-TEST FAILED: ${msg}`);
    process.exit(1);
  }
}

function runSelfTestLayer1() {
  // 1. Citation regex + quoted-phrase carve-out.
  const quotedPhraseSamples = [
    'see [section.md § "The CLS-under-latency fix"](./section.md#x)',
    '[flow.md § "Missing asset: `/subtle-pattern.png`"](./flow.md#y)',
  ];
  for (const sample of quotedPhraseSamples) {
    const re = new RegExp(CITATION_RE.source, "g");
    const matches = [...sample.matchAll(re)];
    assert(
      matches.length === 0,
      `CITATION_RE incorrectly matched a quoted-phrase doc-section cross-reference: ${JSON.stringify(sample)}`,
    );
  }
  const bareIdentifierSample = "see (src/auth.ts § requestOtp) for the mint path";
  const re2 = new RegExp(CITATION_RE.source, "g");
  const matches2 = [...bareIdentifierSample.matchAll(re2)];
  assert(
    matches2.length === 1 && matches2[0][2] === "requestOtp",
    `CITATION_RE did not match a genuine bare-identifier citation as expected: ${JSON.stringify(matches2)}`,
  );

  // 2. Per-extension declaration matcher — one assertion pair per language
  // family: a real declaration of fooBarSymbol PASSES; a substring-collision
  // (fooBarSymbolExtended present, fooBarSymbol never declared at a word
  // boundary) FAILS.
  const langCases = [
    { ext: ".ts", pass: "export function fooBarSymbol() {}", fail: "function fooBarSymbolExtended() {}" },
    { ext: ".py", pass: "def fooBarSymbol():\n    pass", fail: "def fooBarSymbolExtended():\n    pass" },
    { ext: ".go", pass: "func fooBarSymbol() {}", fail: "func fooBarSymbolExtended() {}" },
    { ext: ".rs", pass: "fn fooBarSymbol() {}", fail: "fn fooBarSymbolExtended() {}" },
    { ext: ".java", pass: "class fooBarSymbol {}", fail: "class fooBarSymbolExtended {}" },
    { ext: ".rb", pass: "def fooBarSymbol\nend", fail: "def fooBarSymbolExtended\nend" },
  ];
  const emptyConfig = { ...DEFAULT_CONFIG };
  for (const c of langCases) {
    assert(
      symbolExistsInSource(c.pass, "fooBarSymbol", c.ext, emptyConfig) === true,
      `declaration matcher for ${c.ext} did not PASS a real declaration of fooBarSymbol`,
    );
    assert(
      symbolExistsInSource(c.fail, "fooBarSymbol", c.ext, emptyConfig) === false,
      `declaration matcher for ${c.ext} incorrectly PASSED a substring-collision (fooBarSymbolExtended present, fooBarSymbol never declared) — the rename-false-PASS guard is broken`,
    );
  }

  // 3. extraDeclarationPatterns override — a data-layer-schema-shaped source
  // string (an object-literal key whose value is a framework-specific
  // "declare a table/model" call — a real, stable, documentable "thing" that
  // isn't a const/function/class declaration) FAILS against the built-in
  // table alone, then PASSES once a synthetic config supplies the pattern.
  const tableSource = "export default defineDataModel({\n  orders: declareTable({}),\n});\n";
  assert(
    symbolExistsInSource(tableSource, "orders", ".ts", emptyConfig) === false,
    "extraDeclarationPatterns test setup: built-in table alone unexpectedly matched a non-declaration shape",
  );
  const configWithExtra = {
    ...DEFAULT_CONFIG,
    extraDeclarationPatterns: [
      { label: "data-layer-table-shape", ext: ["ts"], regexTemplate: String.raw`\b{SYMBOL}\s*:\s*declareTable\s*\(` },
    ],
  };
  assert(
    symbolExistsInSource(tableSource, "orders", ".ts", configWithExtra) === true,
    "extraDeclarationPatterns escape hatch did not activate once the config supplied a matching pattern",
  );

  // 4. Missing/absent doc-cite-config.json -> fail-safe built-in defaults
  // (never crash — exercised via DEFAULT_CONFIG directly here since Layer 1
  // is in-memory only; the real load path is exercised in Layer 2).
  assert(DEFAULT_CONFIG.headingSlugAlgorithm === "none", "DEFAULT_CONFIG must default headingSlugAlgorithm to 'none' (fail-safe, never assume GitHub)");
  assert(Array.isArray(DEFAULT_CONFIG.extraDeclarationPatterns) && DEFAULT_CONFIG.extraDeclarationPatterns.length === 0, "DEFAULT_CONFIG.extraDeclarationPatterns must be empty by default");

  // 5. Dot-form member check.
  const dotFormSource = "export function Outer() {\n  function inner() {}\n}\n";
  assert(
    symbolExistsInSource(dotFormSource, "Outer.inner", ".ts", emptyConfig) === true,
    "dot-form member check did not accept a real Outer/inner pair",
  );
  assert(
    symbolExistsInSource(dotFormSource, "Outer.doesNotExist", ".ts", emptyConfig) === false,
    "dot-form member check incorrectly accepted a non-existent member",
  );

  // 6. Frontmatter parse/well-formed check.
  const goodFm = '---\ncovers:\n  - "src/x.ts § foo"\nrelated:\n  - "docs/y.md"\nstatus: current\n---\nbody\n';
  const fmGood = parseFrontmatter(goodFm);
  assert(!fmGood.error, `a valid frontmatter block was rejected: ${fmGood.error}`);

  const missingCoversFm = '---\nrelated: []\nstatus: current\n---\nbody\n';
  const parsedMissing = parseFrontmatter(missingCoversFm);
  assert(!parsedMissing.error, "parser itself should not error on a syntactically valid block missing `covers`");
  assert(!("covers" in parsedMissing.data), "test setup: `covers` should be genuinely absent from this fixture");

  const nonListRelatedFm = '---\ncovers:\n  - "src/x.ts"\nrelated: not-a-list\nstatus: current\n---\nbody\n';
  const parsedRelated = parseFrontmatter(nonListRelatedFm);
  assert(!parsedRelated.error && typeof parsedRelated.data.related === "string", "test setup: `related` fixture should parse as a scalar, not a list");

  const badStatusFm = '---\ncovers:\n  - "src/x.ts"\nrelated: []\nstatus: bogus\n---\nbody\n';
  const parsedStatus = parseFrontmatter(badStatusFm);
  assert(!parsedStatus.error && parsedStatus.data.status === "bogus", "test setup: `status` fixture should parse as the literal invalid string");

  // 7. Heading-anchor slug calibration — generic, non-stack-flavored samples.
  const slugCalibration = [
    ["`feature-toggle` — OPT-IN (`config.yml:10-20`)", "feature-toggle--opt-in-configyml10-20"],
    ["Session lifecycle", "session-lifecycle"],
    ["The `/status` route", "the-status-route"],
  ];
  for (const [heading, expected] of slugCalibration) {
    const got = githubHeadingSlug(heading);
    assert(got === expected, `githubHeadingSlug(${JSON.stringify(heading)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }

  // 8. Frontmatter WELL-FORMEDNESS VIOLATIONS (impl-audit finding B1 — the
  // parser round-trip above (item 6) never asserted a violation actually
  // fires for bad data; this drives the real, standalone
  // checkFrontmatterWellFormedness() — the same function main() calls —
  // against each independently-bad fixture and asserts the right, and ONLY
  // the right, violation is produced).
  const goodData = { covers: ["src/x.ts § foo"], related: [], status: "current" };
  assert(
    checkFrontmatterWellFormedness(goodData).length === 0,
    `a well-formed frontmatter object produced unexpected violations: ${JSON.stringify(checkFrontmatterWellFormedness(goodData))}`,
  );
  const emptyCoversData = { covers: [], related: [], status: "current" };
  const emptyCoversViolations = checkFrontmatterWellFormedness(emptyCoversData);
  assert(
    emptyCoversViolations.some((v) => v.includes("`covers` must be a non-empty list")),
    `an empty \`covers\` list did not produce the expected violation: ${JSON.stringify(emptyCoversViolations)}`,
  );
  const nonListRelatedData = { covers: ["src/x.ts"], related: "not-a-list", status: "current" };
  const nonListRelatedViolations = checkFrontmatterWellFormedness(nonListRelatedData);
  assert(
    nonListRelatedViolations.some((v) => v.includes("`related` must be a list")),
    `a non-list \`related\` did not produce the expected violation: ${JSON.stringify(nonListRelatedViolations)}`,
  );
  const badStatusData = { covers: ["src/x.ts"], related: [], status: "bogus-value" };
  const badStatusViolations = checkFrontmatterWellFormedness(badStatusData);
  assert(
    badStatusViolations.some((v) => v.includes('must be exactly "current" or "historical"') && v.includes("bogus-value")),
    `an invalid \`status\` value did not produce the expected violation: ${JSON.stringify(badStatusViolations)}`,
  );

  // 9. `@`-in-path regex alignment (impl-audit real-bug finding). Both the
  // covers-entry parser (COVERS_CITATION_RE) and the body-citation grammar
  // (CITATION_RE, via PATH_RE_SRC) must accept a scoped-package-shaped path
  // (e.g. `node_modules/@scope/pkg/index.ts`) — previously the covers
  // parser silently omitted `@`, so such an entry fell through
  // "not a citation shape" and was never file/symbol-checked at all.
  const scopedPkgCoversText = "node_modules/@scope/pkg/index.ts § someExport";
  const coversParsed = COVERS_CITATION_RE.exec(scopedPkgCoversText);
  assert(
    coversParsed !== null && coversParsed[1] === "node_modules/@scope/pkg/index.ts" && coversParsed[2] === "someExport",
    `COVERS_CITATION_RE failed to parse an @-scoped-package path as a citation: ${JSON.stringify(coversParsed)}`,
  );
  const bodyReForAt = new RegExp(CITATION_RE.source, "g");
  const bodyAtMatches = [...`see (${scopedPkgCoversText}) here`.matchAll(bodyReForAt)];
  assert(
    bodyAtMatches.length === 1 && bodyAtMatches[0][1] === "node_modules/@scope/pkg/index.ts",
    `CITATION_RE failed to parse an @-scoped-package path in body text: ${JSON.stringify(bodyAtMatches)}`,
  );

  // 10. ReDoS bound — a large adversarial (all path-class chars, no dot,
  // so no possible match) input must complete in bounded time against BOTH
  // whole-body regexes, proving the {1,240}-capped PATH_RE_SRC / old-style-
  // cite leading class prevents the O(n^2) backtracking blowup the
  // original unbounded `[\w./@-]+\.\w+` shape exhibited (measured 53s on a
  // 128k adversarial blob pre-fix; this asserts well under 3s on a larger,
  // 200k input post-fix — generous headroom against slow/loaded CI runners
  // while still proving no quadratic blowup survived).
  {
    const adversarial = "0123456789abcdef".repeat(12_500); // 200,000 chars, no '.', in-class throughout
    const start = Date.now();
    const re1 = new RegExp(CITATION_RE.source, "g");
    [...adversarial.matchAll(re1)];
    const elapsed1 = Date.now() - start;
    assert(
      elapsed1 < 3000,
      `CITATION_RE took ${elapsed1}ms against a 200k-char adversarial input (expected <3000ms, bounded) — possible ReDoS regression`,
    );

    const start2 = Date.now();
    const re2 = buildOldStyleCiteRe(DEFAULT_CONFIG);
    [...adversarial.matchAll(re2)];
    const elapsed2 = Date.now() - start2;
    assert(
      elapsed2 < 3000,
      `the old-style-cite regex took ${elapsed2}ms against a 200k-char adversarial input (expected <3000ms, bounded) — possible ReDoS regression`,
    );
  }

  console.log("check-doc-cites --self-test: Layer 1 (pure-function) — all assertions passed.");
}

function runSelfTestLayer2() {
  const scratchRoot = mkdtempSync(join(tmpdir(), "check-doc-cites-selftest-"));
  try {
    const docsAreaDir = join(scratchRoot, "docs", "area");
    mkdirSync(docsAreaDir, { recursive: true });
    const srcFile = join(scratchRoot, "thing.ts");
    writeFileSync(srcFile, "export function realSymbol() {}\n", "utf8");

    const readmePath = join(docsAreaDir, "README.md");
    writeFileSync(
      readmePath,
      '---\ncovers:\n  - "thing.ts § realSymbol"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee (thing.ts § realSymbol) for details.\n',
      "utf8",
    );

    const config = {
      ...DEFAULT_CONFIG,
      scopedDocDirs: ["docs/area"],
      docsRoot: "docs",
    };

    // PASS case.
    let violations = main(scratchRoot, config);
    assert(violations.length === 0, `Layer 2 PASS case unexpectedly failed: ${JSON.stringify(violations)}`);

    // RED case — mutate the citation to a symbol that doesn't exist.
    writeFileSync(
      readmePath,
      '---\ncovers:\n  - "thing.ts § realSymbol"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee (thing.ts § doesNotExistSymbol) for details.\n',
      "utf8",
    );
    violations = main(scratchRoot, config);
    const hasExpectedViolation = violations.some(
      (v) => v.startsWith("[symbol-appears-in-file]") && v.includes("doesNotExistSymbol") && v.includes("thing.ts"),
    );
    assert(
      hasExpectedViolation,
      `Layer 2 RED case did not produce the expected symbol-appears-in-file violation naming doesNotExistSymbol/thing.ts: ${JSON.stringify(violations)}`,
    );

    // GREEN case — revert, re-run, assert PASS again.
    writeFileSync(
      readmePath,
      '---\ncovers:\n  - "thing.ts § realSymbol"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee (thing.ts § realSymbol) for details.\n',
      "utf8",
    );
    violations = main(scratchRoot, config);
    assert(violations.length === 0, `Layer 2 GREEN (post-revert) case unexpectedly failed: ${JSON.stringify(violations)}`);

    // --- impl-audit finding: cite-resolves (cited-file-exists) had ZERO
    // self-test coverage — the RED case above only ever exercised the
    // symbol-existence branch (the target file always existed). Add a
    // dedicated fixture citing a path that does not exist at all.
    writeFileSync(
      readmePath,
      '---\ncovers:\n  - "thing.ts § realSymbol"\n  - "does-not-exist.ts"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee (thing.ts § realSymbol) for details.\n',
      "utf8",
    );
    violations = main(scratchRoot, config);
    const hasCiteResolvesViolation = violations.some(
      (v) => v.startsWith("[cited-file-exists]") && v.includes("does-not-exist.ts") && v.includes("does not exist"),
    );
    assert(
      hasCiteResolvesViolation,
      `cite-resolves guard did not fire for a covers entry citing a nonexistent file: ${JSON.stringify(violations)}`,
    );
    // Revert.
    writeFileSync(
      readmePath,
      '---\ncovers:\n  - "thing.ts § realSymbol"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee (thing.ts § realSymbol) for details.\n',
      "utf8",
    );
    violations = main(scratchRoot, config);
    assert(violations.length === 0, `post-cite-resolves-test revert unexpectedly failed: ${JSON.stringify(violations)}`);

    // --- impl-audit finding: frontmatter well-formedness had no
    // execution-path coverage through the REAL main() pipeline (Layer 1
    // item 8 tests checkFrontmatterWellFormedness() directly; this proves
    // main() actually calls it and surfaces the violation end-to-end).
    writeFileSync(
      readmePath,
      '---\ncovers:\n  - "thing.ts § realSymbol"\nrelated: []\nstatus: bogus-value\n---\n\n# Area\n\nSee (thing.ts § realSymbol) for details.\n',
      "utf8",
    );
    violations = main(scratchRoot, config);
    const hasFrontmatterViolation = violations.some(
      (v) => v.startsWith("[frontmatter]") && v.includes("bogus-value"),
    );
    assert(
      hasFrontmatterViolation,
      `main() did not surface a [frontmatter] violation for an invalid status value: ${JSON.stringify(violations)}`,
    );
    // Revert.
    writeFileSync(
      readmePath,
      '---\ncovers:\n  - "thing.ts § realSymbol"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee (thing.ts § realSymbol) for details.\n',
      "utf8",
    );
    violations = main(scratchRoot, config);
    assert(violations.length === 0, `post-frontmatter-test revert unexpectedly failed: ${JSON.stringify(violations)}`);

    // --- impl-audit finding: `@`-in-path — end-to-end proof that a
    // scoped-package-shaped covers entry is no longer silently skipped
    // (previously fell through "not a citation shape" and produced zero
    // violations even for a nonexistent target).
    writeFileSync(
      readmePath,
      '---\ncovers:\n  - "thing.ts § realSymbol"\n  - "node_modules/@scope/pkg/does-not-exist.ts"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee (thing.ts § realSymbol) for details.\n',
      "utf8",
    );
    violations = main(scratchRoot, config);
    const hasAtPathViolation = violations.some(
      (v) => v.startsWith("[cited-file-exists]") && v.includes("node_modules/@scope/pkg/does-not-exist.ts"),
    );
    assert(
      hasAtPathViolation,
      `an @-scoped-package covers entry citing a nonexistent file was silently skipped instead of producing a [cited-file-exists] violation: ${JSON.stringify(violations)}`,
    );
    // Revert.
    writeFileSync(
      readmePath,
      '---\ncovers:\n  - "thing.ts § realSymbol"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee (thing.ts § realSymbol) for details.\n',
      "utf8",
    );
    violations = main(scratchRoot, config);
    assert(violations.length === 0, `post-@-path-test revert unexpectedly failed: ${JSON.stringify(violations)}`);

    console.log("check-doc-cites --self-test: Layer 2 (real-filesystem RED/GREEN) — passed.");
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

/** Impl-audit finding: `checkHeadingAnchors`'s end-to-end detection path had
 *  ZERO self-test coverage (only the pure `githubHeadingSlug()` function was
 *  tested). Builds a real scratch repo with `headingSlugAlgorithm: "github"`,
 *  a real heading, and a real cross-doc `[text](./other.md#fragment)` link;
 *  asserts PASS while the link is valid, then RED once the heading is
 *  renamed (the exact "heading rewrite breaks an inbound anchor" hazard the
 *  acceptance criteria names by name), then GREEN again once reverted. */
function runSelfTestLayer2HeadingAnchorEndToEnd() {
  const scratchRoot = mkdtempSync(join(tmpdir(), "check-doc-cites-selftest-heading-"));
  try {
    const docsAreaDir = join(scratchRoot, "docs", "area");
    mkdirSync(docsAreaDir, { recursive: true });

    const targetPath = join(docsAreaDir, "target.md");
    writeFileSync(
      targetPath,
      '---\ncovers:\n  - "thing.ts"\nrelated: []\nstatus: current\n---\n\n## Old Heading Name\n\nBody.\n',
      "utf8",
    );
    const srcFile = join(scratchRoot, "thing.ts");
    writeFileSync(srcFile, "export function realSymbol() {}\n", "utf8");

    const citingPath = join(docsAreaDir, "README.md");
    writeFileSync(
      citingPath,
      '---\ncovers:\n  - "thing.ts"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee [target](./target.md#old-heading-name) for details.\n',
      "utf8",
    );

    const config = {
      ...DEFAULT_CONFIG,
      scopedDocDirs: ["docs/area"],
      docsRoot: "docs",
      headingSlugAlgorithm: "github",
    };

    // PASS case — the link's fragment matches the target heading's real slug.
    let violations = main(scratchRoot, config);
    assert(
      !violations.some((v) => v.startsWith("[heading-anchor]")),
      `heading-anchor PASS case unexpectedly produced a violation: ${JSON.stringify(violations)}`,
    );

    // RED case — rename the heading (simulating a citation-conversion pass
    // that rewrites headings, exactly the hazard the criteria names), which
    // silently changes its GitHub-rendered anchor slug and breaks the
    // inbound link — assert the check catches it.
    writeFileSync(
      targetPath,
      '---\ncovers:\n  - "thing.ts"\nrelated: []\nstatus: current\n---\n\n## New Renamed Heading\n\nBody.\n',
      "utf8",
    );
    violations = main(scratchRoot, config);
    const hasHeadingViolation = violations.some(
      (v) => v.startsWith("[heading-anchor]") && v.includes("old-heading-name") && v.includes("target.md"),
    );
    assert(
      hasHeadingViolation,
      `heading-anchor check did not fire after the target heading was renamed: ${JSON.stringify(violations)}`,
    );

    // GREEN case — fix the citing link's fragment to the new slug, revert.
    writeFileSync(
      citingPath,
      '---\ncovers:\n  - "thing.ts"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee [target](./target.md#new-renamed-heading) for details.\n',
      "utf8",
    );
    violations = main(scratchRoot, config);
    assert(
      !violations.some((v) => v.startsWith("[heading-anchor]")),
      `heading-anchor GREEN (post-fix) case unexpectedly produced a violation: ${JSON.stringify(violations)}`,
    );

    // Also confirm the no-op behavior when headingSlugAlgorithm is "none"
    // (a stale link would otherwise be silently unreported, which is the
    // intended, documented "skip, don't guess" v1 behavior for non-GitHub
    // remotes — reset the citing link back to the STALE fragment first so
    // this genuinely proves the check is a no-op, not incidentally still green).
    writeFileSync(
      citingPath,
      '---\ncovers:\n  - "thing.ts"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee [target](./target.md#old-heading-name) for details.\n',
      "utf8",
    );
    const noneConfig = { ...config, headingSlugAlgorithm: "none" };
    violations = main(scratchRoot, noneConfig);
    assert(
      !violations.some((v) => v.startsWith("[heading-anchor]")),
      `headingSlugAlgorithm: "none" should disable the heading-anchor check entirely (no-op), but it fired: ${JSON.stringify(violations)}`,
    );

    console.log("check-doc-cites --self-test: Layer 2b (heading-anchor end-to-end RED/GREEN) — passed.");
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

/** Impl-audit safety finding (BLOCKER 1): path-traversal / symlink-escape
 *  containment had ZERO self-test coverage. Proves all three vectors the
 *  audit demonstrated are now blocked: a `../`-escaping covers citation, a
 *  `../`-escaping heading-anchor link, and an in-repo symlink pointing
 *  outside the repo (no `..` in doc text at all). Each must produce a
 *  violation naming the escape attempt, never a silent PASS. */
function runSelfTestLayer2PathTraversal() {
  const scratchRoot = mkdtempSync(join(tmpdir(), "check-doc-cites-selftest-traversal-"));
  const outsideRoot = mkdtempSync(join(tmpdir(), "check-doc-cites-selftest-outside-"));
  try {
    const docsAreaDir = join(scratchRoot, "docs", "area");
    mkdirSync(docsAreaDir, { recursive: true });

    // A "secret" file OUTSIDE the scratch repo entirely.
    const outsideSecretPath = join(outsideRoot, "secret.ts");
    writeFileSync(outsideSecretPath, "export const OUTSIDE_TOKEN = 1;\n", "utf8");
    const outsideSecretMdPath = join(outsideRoot, "secret-notes.md");
    writeFileSync(outsideSecretMdPath, "## Totally Fine Heading\n\nNothing to see.\n", "utf8");

    const config = {
      ...DEFAULT_CONFIG,
      scopedDocDirs: ["docs/area"],
      docsRoot: "docs",
      headingSlugAlgorithm: "github",
    };

    // Vector 1: `../`-escaping covers citation reading real content outside
    // the repo. Compute a relative `../../../...` path from the scratch
    // repo root to the outside secret file (depth-agnostic, robust to
    // os.tmpdir()'s actual nesting depth).
    const relEscape = relativeEscapePath(scratchRoot, outsideSecretPath);
    const citingPath = join(docsAreaDir, "README.md");
    writeFileSync(
      citingPath,
      `---\ncovers:\n  - "${relEscape} § OUTSIDE_TOKEN"\nrelated: []\nstatus: current\n---\n\n# Area\n\nBody.\n`,
      "utf8",
    );
    let violations = main(scratchRoot, config);
    const blockedCitation = violations.some(
      (v) => v.startsWith("[cited-file-exists]") && v.includes("resolves outside the repository root"),
    );
    assert(
      blockedCitation,
      `a \`../\`-escaping covers citation was NOT blocked (path-traversal vulnerability): ${JSON.stringify(violations)}`,
    );
    assert(
      !violations.some((v) => v.includes("OUTSIDE_TOKEN") && v.startsWith("[symbol-appears-in-file]")),
      `the escaping citation reached symbol-existence checking against the outside file — containment check did not stop it early enough`,
    );

    // Vector 2: `../`-escaping heading-anchor link. The heading-anchor
    // resolver bases relative link targets on `dirname(<citing doc's abs
    // path>)` (docsAreaDir), NOT the repo root — so the escape path must be
    // computed relative to docsAreaDir, not scratchRoot.
    const relEscapeMd = relativeEscapePath(docsAreaDir, outsideSecretMdPath);
    writeFileSync(
      citingPath,
      `---\ncovers:\n  - "thing-placeholder.ts"\nrelated: []\nstatus: current\n---\n\n# Area\n\nSee [x](${relEscapeMd}#totally-fine-heading) for details.\n`,
      "utf8",
    );
    // (thing-placeholder.ts doesn't need to exist for this vector — the
    // heading-anchor violation is what's under test; suppress the unrelated
    // cited-file-exists noise by checking only for the heading-anchor one.)
    violations = main(scratchRoot, config);
    const blockedHeading = violations.some(
      (v) => v.startsWith("[heading-anchor]") && v.includes("resolves outside the repository root"),
    );
    assert(
      blockedHeading,
      `a \`../\`-escaping heading-anchor link was NOT blocked (path-traversal vulnerability): ${JSON.stringify(violations)}`,
    );

    // Vector 3: an IN-REPO symlink pointing outside the repo (no `..` in
    // doc text at all — proves the fix is a real containment/realpath
    // check, not merely "reject literal `..`").
    const symlinkPath = join(scratchRoot, "inside-symlink-secret.ts");
    try {
      symlinkSync(outsideSecretPath, symlinkPath);
    } catch (e) {
      // Symlink creation can fail in some sandboxed/restricted environments
      // (e.g. no CAP_SYMLINK on some CI runners) — skip this one vector
      // rather than fail the whole suite on an environment limitation, but
      // say so loudly rather than silently passing.
      console.error(
        `check-doc-cites --self-test: WARNING — could not create a symlink in this environment (${e.message}); skipping the symlink-escape vector of the path-traversal self-test. Vectors 1 and 2 (../-escape for citations and heading-anchors) still ran and passed.`,
      );
      writeFileSync(
        citingPath,
        '---\ncovers:\n  - "thing-placeholder.ts"\nrelated: []\nstatus: current\n---\n\n# Area\n\nBody.\n',
        "utf8",
      );
      console.log("check-doc-cites --self-test: Layer 2c (path-traversal containment) — passed (2/3 vectors; symlink unavailable in this environment).");
      return;
    }
    writeFileSync(
      citingPath,
      '---\ncovers:\n  - "inside-symlink-secret.ts § OUTSIDE_TOKEN"\nrelated: []\nstatus: current\n---\n\n# Area\n\nBody.\n',
      "utf8",
    );
    violations = main(scratchRoot, config);
    const blockedSymlink = violations.some(
      (v) => v.startsWith("[cited-file-exists]") && v.includes("inside-symlink-secret.ts") && v.includes("resolves outside the repository root"),
    );
    assert(
      blockedSymlink,
      `an in-repo symlink pointing outside the repo was NOT blocked (symlink-escape vulnerability): ${JSON.stringify(violations)}`,
    );

    console.log("check-doc-cites --self-test: Layer 2c (path-traversal containment, all 3 vectors) — passed.");
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
    rmSync(outsideRoot, { recursive: true, force: true });
  }
}

/** Builds a `../`-chained relative path from `fromDir` to `targetAbsPath`,
 *  independent of how deeply `fromDir` happens to be nested under
 *  os.tmpdir() on this machine (self-test-only helper). */
function relativeEscapePath(fromDir, targetAbsPath) {
  const depth = fromDir.split(sep).filter(Boolean).length;
  const ups = Array.from({ length: depth + 1 }, () => "..").join("/");
  return `${ups}${targetAbsPath}`;
}

function runSelfTest() {
  runSelfTestLayer1();
  runSelfTestLayer2();
  runSelfTestLayer2HeadingAnchorEndToEnd();
  runSelfTestLayer2PathTraversal();
  console.log("check-doc-cites --self-test: ALL LAYERS PASSED.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const config = loadConfig();
assertScriptInstallDirIsSingleSegment(config);
const REPO_ROOT = resolve(__dirname, "..");
const violations = main(REPO_ROOT, config);
if (violations.length > 0) {
  console.error(`check-doc-cites: FAIL — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("check-doc-cites: PASS — all citations/frontmatter/exceptions verified.");
