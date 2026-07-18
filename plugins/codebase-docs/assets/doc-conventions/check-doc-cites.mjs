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
//
// 0.5.1 GUARDRAIL (D2, §2.1): this class deliberately does NOT admit space,
// unlike the `covers`-frontmatter regexes below (COVERS_CITATION_RE /
// COVERS_BARE_PATH_RE), which were widened to admit space in 0.5.1. This
// regex is scanned via `matchAll` over free body PROSE (unanchored,
// re-attempted at every offset) — admitting space here risks a greedy path
// class globbing unrelated dot-extension words across a sentence into one
// bogus "path," and was independently measured at ~50x slower (~400-500ms
// vs ~8ms on a 280,000-char adversarial body, linear-scaling to ~2.8s at
// 2,000,000 chars) for a hypothetical space-admitting variant of this exact
// unanchored-scan mechanism. A future change admitting space here MUST be
// re-verified against this exact adversarial-timing shape first — do not
// assume the `covers`-side widening below transfers safely to this regex.
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
  // 0.5.1 (D1 Fix 1A): "fun"/"func" are the real, fixed leading method
  // keywords for Kotlin/Swift (structurally identical to how `function`
  // already works for the JS/TS family) — "record" never existed as a
  // keyword in either language and is removed as a deliberate, small,
  // separately-flagged scope addition (see the plugin's 0.5.1 changelog).
  ".kt": ["class", "interface", "enum", "fun"],
  ".swift": ["class", "interface", "enum", "func"],
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

// ---------------------------------------------------------------------------
// 0.5.1 (D1 Fix 1B) — C#/Java method declarations + C#/Java/Kotlin/Swift
// enum-member declarations. `LANGUAGE_DECL_KEYWORDS` above only covers
// TYPE-level declarations (class/interface/enum); C# and Java method
// declarations have a variable return-type token instead of a fixed leading
// keyword, and enum members have no keyword at all — both need a dedicated
// fallback, checked only after the type-level table above has already
// failed to resolve the symbol (§1 of the 0.5.1 hardening plan).
// ---------------------------------------------------------------------------

const CSHARP_JAVA_METHOD_EXTS = new Set([".cs", ".java"]);
const ENUM_MEMBER_EXTS = new Set([".cs", ".java", ".kt", ".swift"]);

/** Shared preprocessing for both the method-decl and enum-member fallbacks
 *  (§1.3.0). A plain character-by-character state-machine scanner — linear
 *  O(n) by construction, NOT a regex, so it cannot itself exhibit
 *  backtracking-driven blowup. Blanks every `//…`/`/*…*\/`/`"…"`/`'…'`
 *  region with spaces (newlines preserved) so a comment- or string-embedded
 *  decl-shaped fragment (`// enum Fake { NotReal }`) can never be mistaken
 *  for a real declaration.
 *
 *  DOCUMENTED BOUNDARY (best-effort only, not a full lexer):
 *  - C#'s verbatim strings (`@"..."`, `""`-escaped) and interpolated strings
 *    (`$"..."`) are not specially handled — ordinary, well-formed code
 *    usually self-corrects the scanner's state by the time it reaches the
 *    true end of the token stream, but a verbatim string containing an
 *    embedded `""` (or other malformed/edge-case quoting) can leave the
 *    scanner's STRING state mistracked, either exposing string-fragment text
 *    as fake code or swallowing real code into a phantom string region.
 *  - An UNTERMINATED string/char literal or block comment anywhere in the
 *    file puts the scanner into that state for the remainder of the file —
 *    every subsequent line is blanked, including genuinely real,
 *    otherwise-detectable declarations. This is fail-closed (a citation
 *    against genuinely malformed/mid-edit source declines to resolve rather
 *    than false-matching), not a false positive — accepted for this patch,
 *    not fixed. */
function stripCFamilyCommentsAndStrings(sourceText) {
  const NORMAL = 0, LINE_COMMENT = 1, BLOCK_COMMENT = 2, STRING = 3, CHAR = 4;
  let state = NORMAL;
  const out = new Array(sourceText.length);
  for (let i = 0; i < sourceText.length; i++) {
    const c = sourceText[i];
    if (state === NORMAL) {
      const next = sourceText[i + 1];
      if (c === "/" && next === "/") { state = LINE_COMMENT; out[i] = " "; continue; }
      if (c === "/" && next === "*") { state = BLOCK_COMMENT; out[i] = " "; continue; }
      if (c === '"') { state = STRING; out[i] = " "; continue; }
      if (c === "'") { state = CHAR; out[i] = " "; continue; }
      out[i] = c;
    } else if (state === LINE_COMMENT) {
      if (c === "\n") { state = NORMAL; out[i] = "\n"; } else out[i] = " ";
    } else if (state === BLOCK_COMMENT) {
      if (c === "*" && sourceText[i + 1] === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        state = NORMAL;
        i++;
      } else {
        out[i] = c === "\n" ? "\n" : " ";
      }
    } else if (state === STRING || state === CHAR) {
      const closer = state === STRING ? '"' : "'";
      if (c === "\\") {
        out[i] = " ";
        if (i + 1 < sourceText.length) {
          out[i + 1] = sourceText[i + 1] === "\n" ? "\n" : " ";
          i++;
        }
        continue;
      }
      if (c === closer) { state = NORMAL; out[i] = " "; continue; }
      out[i] = c === "\n" ? "\n" : " ";
    }
  }
  return out.join("");
}

// --- D1 Fix 1B(a): C#/Java method-declaration detection ---------------------
//
// Regex body (§1.2's Design block): an optional bounded [Attribute] line,
// zero-or-more modifiers, a positive-allowlist return type, the symbol name,
// an optional bounded <T> generic-args suffix, then the opening paren. Tested
// per-window WITHOUT the `m` flag (§1.2.1) — never as a single whole-file
// `m`-flag `.test()` call, which is the O(n^2) shape that made round 2's
// design unsafe (the `\s+` separators match `\n`, so a single match attempt
// starting at one line can grow to span the whole remaining file across
// consecutive modifier-shaped lines, e.g. an EF/ORM-scaffolded C# entity
// class's auto-properties).
const CSHARP_JAVA_MODIFIER_ALT_SRC =
  "public|private|protected|internal|static|virtual|override|abstract|sealed|async|readonly|new|extern|unsafe|partial|final|synchronized|native|default|strictfp";
const CSHARP_JAVA_PRIMITIVE_ALT_SRC =
  "void|int|long|short|byte|char|bool|string|object|dynamic|decimal|double|float|uint|ulong|sbyte|ushort|boolean";

const CSHARP_JAVA_METHOD_RE_CACHE = new Map();
function csharpJavaMethodDeclRegexFor(symbol, ext) {
  const cacheKey = `${ext}::${symbol}`;
  if (CSHARP_JAVA_METHOD_RE_CACHE.has(cacheKey)) return CSHARP_JAVA_METHOD_RE_CACHE.get(cacheKey);
  const escaped = escapeRegex(symbol);
  const src = String.raw`^[ \t]*(?:\[[^\]\n]{0,200}\]\s*)*(?:(?:${CSHARP_JAVA_MODIFIER_ALT_SRC})\s+)*(?:[A-Z][\w<>\[\],.\? ]{0,119}|(?:${CSHARP_JAVA_PRIMITIVE_ALT_SRC})\??)\s+${escaped}\s*(?:<[^>\n]{0,80}>)?\s*\(`;
  // NO "m" flag: each window (below) is already positioned at its own true
  // start, so a bare `^` already means exactly "start of this candidate
  // line" — no `m`-flag whole-file scan is ever performed.
  const re = new RegExp(src);
  CSHARP_JAVA_METHOD_RE_CACHE.set(cacheKey, re);
  return re;
}

// K=4 window rationale: the regex only needs to see from the start of a
// declaration line through the opening `(` — it never needs the full
// parameter list or body. The realistic wrapping shapes are a 2-line
// return-type-then-name split (long generic return types) or a 2-3-line
// attribute-then-modifiers-then-signature spread; K=4 gives a full extra
// line of headroom beyond that. DOCUMENTED BOUNDARY: the false-negative
// trigger this window size can miss is precisely ">4-line gap between the
// RETURN-TYPE line and the SYMBOL line" (not merely "a signature exceeding 4
// total lines" — the window can start at any line, so anything closer
// together than that gap is still caught). Not observed in any real or
// adversarial C#/Java sample across three audit rounds.
const WINDOW_LINES = 4;
// Defensive per-window char cap (applied to the joined window's total
// length, not a single physical line, so one pathological multi-megabyte
// line can't inflate a window's cost) — far beyond any realistic method
// signature, same "generous, not tight" philosophy as PATH_RE_SRC's {1,240}.
const MAX_WINDOW_LINE_CHARS = 2000;

function csharpJavaMethodDeclOccursIn(strippedText, symbol, ext) {
  const re = csharpJavaMethodDeclRegexFor(symbol, ext);
  const lines = strippedText.split("\n");
  const cap = WINDOW_LINES * MAX_WINDOW_LINE_CHARS;
  for (let i = 0; i < lines.length; i++) {
    let window = lines[i];
    for (let k = 1; k < WINDOW_LINES && i + k < lines.length; k++) window += "\n" + lines[i + k];
    if (window.length > cap) window = window.slice(0, cap);
    if (re.test(window)) return true;
  }
  return false;
}

// --- D1 Fix 1B(b): C#/Java/Kotlin/Swift enum-member detection ---------------
//
// Four independently-testable units (§1.3): a per-ext enum-opener regex
// (bounded, cached), a depth-counting body-span locator with a defensive
// per-span char cap (the genuine ReDoS guard on this path), a nested-brace
// masking pass (closes the false-positive where an assignment inside a
// rich-enum constant's own method body, or a static/instance initializer
// block, was mistaken for a top-level enum member), and a follower-set
// search run against the masked span only.
const ENUM_OPENER_RE_SRC = {
  // C# enums may declare an underlying-type inheritance clause (`: byte`).
  ".cs": String.raw`\benum\s+[A-Za-z_$][\w$]*(?:\s*:\s*[\w,\s<>]{0,200})?\s*\{`,
  // Java "rich enums" may implement interfaces.
  ".java": String.raw`\benum\s+[A-Za-z_$][\w$]*(?:\s+implements\s+[\w,\s<>]{0,200})?\s*\{`,
  // Kotlin: `enum class Foo(ctorArgs) : Interfaces {` — bounded constructor-
  // args and interface-list classes, matching this file's own bounded-
  // quantifier convention.
  ".kt": String.raw`\benum\s+class\s+[A-Za-z_$][\w$]*(?:\s*\([^)\n]{0,200}\))?(?:\s*:\s*[\w,\s<>]{0,200})?\s*\{`,
  // Swift enums may declare a raw-value type or protocol conformance list.
  ".swift": String.raw`\benum\s+[A-Za-z_$][\w$]*(?:\s*:\s*[\w,\s<>]{0,200})?\s*\{`,
};

const ENUM_OPENER_RE_CACHE = new Map();
function enumOpenerRegexFor(ext) {
  if (ENUM_OPENER_RE_CACHE.has(ext)) return ENUM_OPENER_RE_CACHE.get(ext);
  const src = ENUM_OPENER_RE_SRC[ext];
  const re = src ? new RegExp(src, "g") : null;
  ENUM_OPENER_RE_CACHE.set(ext, re);
  return re;
}

// The genuine ReDoS guard on this path (§1.3.1) — a plain, per-span,
// linear-cost circuit breaker against an unclosed/pathological enum opener
// (many unclosed openers, each followed by a long non-terminating body,
// would otherwise each walk to end-of-file).
const ENUM_SPAN_CHAR_CAP = 50_000;

/** Locates every enum body in `strippedText` (already comment/string-
 *  stripped) for the given extension, depth-counting forward from each
 *  opener's own `{` to find the TRUE matching `}` (correctly handling
 *  nested braces from a Java rich-enum per-constant body). Each returned
 *  span is `{start, end}` where `start` is the index immediately AFTER the
 *  enum's own opening `{` and `end` is the index OF the matching closing
 *  `}` itself — the enum's own outer delimiting braces are never included,
 *  so `strippedText.slice(span.start, span.end)` is always the body's
 *  INTERIOR only (this is what makes `maskNestedBraceRegions`'s depth-0
 *  reading unambiguous — see its own comment below). An opener whose body
 *  never closes within `ENUM_SPAN_CHAR_CAP` characters is skipped (no span
 *  emitted) rather than scanned unboundedly. */
function findAllEnumBodySpans(strippedText, ext) {
  const openerRe = enumOpenerRegexFor(ext);
  if (!openerRe) return [];
  openerRe.lastIndex = 0;
  const spans = [];
  let m;
  while ((m = openerRe.exec(strippedText))) {
    const braceStart = m.index + m[0].length;
    const limit = Math.min(strippedText.length, braceStart + ENUM_SPAN_CHAR_CAP);
    let depth = 1;
    let i = braceStart;
    let closed = false;
    for (; i < limit; i++) {
      const c = strippedText[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { closed = true; break; }
      }
    }
    if (closed) spans.push({ start: braceStart, end: i });
    if (openerRe.lastIndex <= braceStart) openerRe.lastIndex = braceStart + 1; // safety: guarantee forward progress
  }
  return spans;
}

/** Blanks (replaces with spaces, preserving `{`/`}` and newlines) every
 *  character at brace-nesting depth greater than zero relative to the
 *  enum's own top-level body, so a rich-enum constant's own overridden-
 *  method body, or a static/instance initializer block, can never be
 *  mistaken for a top-level enum member by the follower-set search below.
 *  `spanText` is always the enum body's INTERIOR ONLY (see
 *  `findAllEnumBodySpans`'s own span definition — the enum's own outer
 *  braces are structurally never part of it), which is what makes
 *  `depth === 0` at the very first character unambiguously mean "a
 *  top-level member of the enum body": every `{`/`}` pair this function can
 *  ever encounter is necessarily a NESTED structure, never the enum's own
 *  delimiting braces (already excluded upstream). A plain linear char-scan,
 *  not a regex — cannot itself become a ReDoS surface. */
function maskNestedBraceRegions(spanText) {
  let depth = 0;
  const out = new Array(spanText.length);
  for (let i = 0; i < spanText.length; i++) {
    const c = spanText[i];
    if (c === "{") { out[i] = c; depth++; }
    else if (c === "}") { depth = Math.max(0, depth - 1); out[i] = c; }
    else out[i] = depth === 0 ? c : (c === "\n" ? "\n" : " ");
  }
  return out.join("");
}

const ENUM_MEMBER_RE_CACHE = new Map();
function enumMemberRegexFor(symbol, ext) {
  const cacheKey = `${ext}::${symbol}`;
  if (ENUM_MEMBER_RE_CACHE.has(cacheKey)) return ENUM_MEMBER_RE_CACHE.get(cacheKey);
  const escaped = escapeRegex(symbol);
  let re;
  if (ext === ".swift") {
    // Bounded repetition, scoped to the masked span — a same-named
    // switch-statement `case` label elsewhere in the file (or inside a
    // nested closure within the span) can never match.
    re = new RegExp(String.raw`\bcase\s+(?:[\w]+\s*,\s*){0,20}?\b${escaped}\b`);
  } else {
    // C#/Java/Kotlin bare comma-list form: preceded (after skipping
    // whitespace/attributes) by start-of-span, `{`, `,`, or `;`; followed
    // (after skipping whitespace) by `,` `;` `}` `(` `{` `=`, OR the end of
    // the span itself (`$`). `;`/`=` are safe against the masked-out
    // nested-body case above (§1.3.2) — every nested candidate was already
    // removed before this regex ever runs. The `$` alternative is REQUIRED,
    // not cosmetic: `findAllEnumBodySpans`'s span is the enum body's
    // INTERIOR ONLY (its own closing `}` is deliberately excluded from the
    // sliced text — see that function's own comment), so the LAST member
    // in a comma-separated list with no trailing comma before the closing
    // brace (the ordinary, common `enum Foo { A, B, C }` shape — `C` here)
    // has no punctuation character left in the span after it at all; `$`
    // (matched without the `m` flag, so it's the true end of this
    // already-isolated span string) is what makes that ordinary case
    // resolve instead of false-negatively requiring a trailing separator
    // that valid syntax never puts on the last member.
    re = new RegExp(String.raw`(?:^|[{,;])\s*(?:\[[^\]\n]{0,200}\]\s*)*\b${escaped}\b\s*(?:,|;|\}|\(|\{|=|$)`);
  }
  ENUM_MEMBER_RE_CACHE.set(cacheKey, re);
  return re;
}

function searchEnumBodyForMember(maskedSpanText, symbol, ext) {
  return enumMemberRegexFor(symbol, ext).test(maskedSpanText);
}

function enumMemberDeclOccursIn(strippedText, symbol, ext) {
  for (const span of findAllEnumBodySpans(strippedText, ext)) {
    const masked = maskNestedBraceRegions(strippedText.slice(span.start, span.end));
    if (searchEnumBodyForMember(masked, symbol, ext)) return true;
  }
  return false;
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
    // 0.5.1 (D1 Fix 1B): checked only after the type-level table and any
    // repo-supplied extraDeclarationPatterns have both failed to resolve
    // the symbol — a fallback, never a replacement, for `.cs`/`.java`
    // method declarations and `.cs`/`.java`/`.kt`/`.swift` enum members.
    // Both share the same comment/string-stripped text (computed once).
    if (CSHARP_JAVA_METHOD_EXTS.has(ext) || ENUM_MEMBER_EXTS.has(ext)) {
      const strippedText = stripCFamilyCommentsAndStrings(sourceText);
      if (CSHARP_JAVA_METHOD_EXTS.has(ext) && csharpJavaMethodDeclOccursIn(strippedText, segs[0], ext)) return true;
      if (ENUM_MEMBER_EXTS.has(ext) && enumMemberDeclOccursIn(strippedText, segs[0], ext)) return true;
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
//
// 0.5.1 (D2, §2.1-§2.3): space admitted into the leading path class — a real
// MSSQL/Windows-tooling-shaped path (e.g. a `Stored Procedures` folder
// segment) previously truncated silently after the last space, producing a
// false "file does not exist." Scoped deliberately to ONLY these two
// `covers`-frontmatter regexes (and the drift tool's mirrored
// STRIP_CITE_SUFFIX_RE) — NOT PATH_RE_SRC/CITATION_RE (see that regex's own
// guardrail comment above for why). This is safe here specifically because
// both regexes are `^...$`-anchored and run via a single `.exec()`/`.test()`
// against one already-isolated `covers:` entry string — never `matchAll`
// over free prose — so they were never exposed to the O(n^2)
// unanchored-rescan mechanism that made admitting space into PATH_RE_SRC
// unsafe. The `{1,240}`/`{1,20}` bounds are kept as defensive-consistency
// hygiene only, not a ReDoS closure (this shape was never vulnerable — see
// the file-header note above §0's original ReDoS fix). No `\s§\s` ambiguity:
// the path capture always ends in `\.\w{1,20}` (word characters only, never
// whitespace), so the character immediately following is guaranteed to be
// the mandatory separator space, never an internal path space.
const COVERS_CITATION_RE = /^([\w./@ -]{1,240}\.\w{1,20})\s§\s(.+)$/;
const COVERS_BARE_PATH_RE = /^[\w./@ -]{1,240}\.\w{1,20}$/;

// 0.5.1 (D3, §3): a BARE (unquoted, unwrapped) `doc.md § SectionName`
// reference is a doc-section cross-reference, not a code citation, even
// though its "symbol" doesn't start with a quote character (the thing that
// normally excludes the quoted form — see the file-header comment on the
// two citation conventions). `.md` has no declaration table in
// LANGUAGE_DECL_KEYWORDS (nor any of D1's new method/enum-member paths), so
// a `.md § symbol` cite has never had valid symbol-existence semantics under
// this tool — treating it as a doc-section cross-reference instead of a
// `[symbol-appears-in-file]` violation cannot swallow a real code cite by
// construction. `.mdx` is deliberately excluded — matches this tool's
// existing `.md`-only convention everywhere else (see e.g.
// `listScopedMarkdownFiles`).
function isDocSectionCarveoutPath(path) {
  return path.endsWith(".md");
}

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

  if (isDocSectionCarveoutPath(path)) return; // D3 — bare `.md § Section` is a doc-section cross-reference, not a code cite

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
    // 0.5.1 fix (surfaced by D2's own self-test, not a design change to
    // D1/D2/D3 themselves — see the 0.5.1 change log's "deviations"
    // section): the body-citation scan below previously ran over the
    // WHOLE file text, including the raw frontmatter YAML block. Every
    // `covers:` entry is already checked via the dedicated frontmatter
    // path above, so re-scanning the identical raw text with the
    // unanchored, deliberately-space-less CITATION_RE was always
    // redundant — and, once COVERS_CITATION_RE/COVERS_BARE_PATH_RE admit
    // space (D2), actively WRONG: a real, valid, space-containing
    // `covers:` entry's own raw YAML text (e.g.
    // `"Legacy Utils/helpers.ts § doThing"`) would be independently
    // re-matched by the never-widened CITATION_RE, truncated at the first
    // space (`"Utils/helpers.ts § doThing"`), and reported as a spurious
    // second, bogus [cited-file-exists] violation on a citation the
    // frontmatter-covers path had already correctly resolved. Excluding
    // the frontmatter block from the body-scan closes this without
    // touching PATH_RE_SRC/CITATION_RE at all.
    let bodyOnlyText = text;
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
      bodyOnlyText = text.split(/\r?\n/).slice(fm.bodyStartLine).join("\n");
    }

    // Strip fenced code blocks before scanning (ReDoS defense-in-depth +
    // avoids false-flagging an illustrative citation shown inside a fence).
    const strippedBody = stripFencedCodeBlocksOnly(bodyOnlyText);
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

// ---------------------------------------------------------------------------
// 0.5.1 hardening — D1 (C#/Java method + enum-member detection) self-tests.
// All fixtures are synthetic (Planet/MERCURY/VENUS/MARS-style generic
// names) per the hardening plan's hard rule — never a literal string from
// real evidence.
// ---------------------------------------------------------------------------

function runSelfTestLayer1CSharpJavaMethodDecl() {
  const emptyConfig = { ...DEFAULT_CONFIG };

  // Interface method with no modifier, a modifier-bearing class method, a
  // multi-line wrapped-return-type method, a generic method, nullable-
  // primitive returns, and a call-site rejection matrix (receiver-qualified,
  // bare unqualified, await-assigned, ternary-branch) — all in one source so
  // the "no regression on already-working shapes" and "no new false
  // positives" assertions share one realistic file.
  const csSource = `
public interface IWidgetService {
    Task<WidgetResponse> GetWidgetAsync(int id);
}

public class WidgetService : IWidgetService {
    public async Task<WidgetResponse> GetWidgetAsync(int id) {
        return await _repo.FindAsync(id);
    }

    public Task<List<WidgetResponse>>
        GetWidgetsAsync(WidgetQuery query) {
        return _repo.ListAsync(query);
    }

    public T Method<T>() { return default(T); }

    int? MaybeGetCount() { return null; }
    bool? IsValid() { return null; }

    void CallSites(bool flag) {
        var a = _repo.NeverDeclaredReceiverCall();
        var b = NeverDeclaredBareCall();
        var c = await NeverDeclaredAwaitCall();
        var result = flag ? GetSomething() : GetOther();
    }
}
`;
  assert(symbolExistsInSource(csSource, "GetWidgetAsync", ".cs", emptyConfig) === true, "no-modifier interface method decl not found");
  assert(symbolExistsInSource(csSource, "GetWidgetsAsync", ".cs", emptyConfig) === true, "multi-line wrapped-return-type method decl not found (return type and symbol on separate lines)");
  assert(symbolExistsInSource(csSource, "Method", ".cs", emptyConfig) === true, "generic method decl (Method<T>()) not found");
  assert(symbolExistsInSource(csSource, "MaybeGetCount", ".cs", emptyConfig) === true, "nullable-primitive (int?) return method decl not found");
  assert(symbolExistsInSource(csSource, "IsValid", ".cs", emptyConfig) === true, "nullable-primitive (bool?) return method decl not found");
  for (const callSite of ["NeverDeclaredReceiverCall", "NeverDeclaredBareCall", "NeverDeclaredAwaitCall", "GetSomething", "GetOther"]) {
    assert(
      symbolExistsInSource(csSource, callSite, ".cs", emptyConfig) === false,
      `call-site shape "${callSite}" was incorrectly resolved as a declaration (false-positive-on-call-site regression)`,
    );
  }

  // Mutation-mandate target (§5.1(b)): RETURN_TYPE's positive allowlist
  // (uppercase-starting token, or an exact primitive keyword) is what makes
  // a bare, lowercase-starting token immediately preceding a symbol across
  // a line-wrap correctly REJECTED. None of the call-site shapes above
  // cross a line-wrap the way a widened ("any identifier") allowlist could
  // exploit — this adversarial (deliberately not "realistic" C#) fixture
  // isolates exactly that boundary: a bare lowercase identifier on its own
  // line, immediately followed (whitespace/newline only, no receiver dot)
  // by a symbol-shaped token and `(`. Widening RETURN_TYPE to accept any
  // identifier (not just uppercase-starting/primitive) makes this resolve
  // true; the allowlist's uppercase/primitive restriction is what keeps it
  // false.
  const lowercaseAdjacentSource = "count\nNeverDeclaredWrappedTarget();\n";
  assert(
    symbolExistsInSource(lowercaseAdjacentSource, "NeverDeclaredWrappedTarget", ".cs", emptyConfig) === false,
    "a lowercase-starting token immediately preceding a symbol across a line-wrap was incorrectly resolved as a declaration (RETURN_TYPE allowlist regression)",
  );

  // Round-3 Blocker 4(b) — the method-decl fallback's OWN block-comment
  // immunity, dedicated and distinct from the enum-path F1 test below (the
  // shared stripper closes this for method-decl too, but round 2 never had
  // a fixture proving it specifically on this path).
  const blockCommentSource = `
/*
public Task<FakeResponse> NeverDeclaredMethod() { }
*/
public class RealHolderClass {
    public void ActualMethod() { }
}
`;
  assert(
    symbolExistsInSource(blockCommentSource, "NeverDeclaredMethod", ".cs", emptyConfig) === false,
    "a method-shaped declaration inside a /* ... */ block comment was incorrectly resolved true",
  );
  assert(
    symbolExistsInSource(blockCommentSource, "ActualMethod", ".cs", emptyConfig) === true,
    "a real method declaration outside the block comment was not found",
  );

  // Stripper verbatim-string-boundary case (safety re-audit, non-blocking,
  // §1.3.0) — asserts the CURRENT, accepted (not "fixed") behavior: an
  // embedded `""`-escape pair inside a C#-verbatim-string-shaped input, in
  // the common well-formed case, restores quote parity by the time the
  // scanner reaches the real closing quote, so real code AFTER the string
  // is still found normally. This is the documented boundary made visible
  // in the test suite, not left only in prose.
  const verbatimStringSource = `
string s = @"embedded ""quote"" here";
public class RealAfterVerbatimHolder {
    public void RealAfterVerbatimMethod() { }
}
`;
  assert(
    symbolExistsInSource(verbatimStringSource, "RealAfterVerbatimMethod", ".cs", emptyConfig) === true,
    "documented stripper boundary regression: a real declaration after a well-formed verbatim-string-shaped input with an embedded \"\" pair was not found (current accepted behavior expects quote-parity to self-correct here)",
  );

  console.log("check-doc-cites --self-test: Layer 1 (D1 C#/Java method-decl) — all assertions passed.");
}

function runSelfTestLayer1EnumMember() {
  const emptyConfig = { ...DEFAULT_CONFIG };

  // F1 — comment/string-embedded fake enum-member text must never resolve.
  const commentTrapSource = `
// enum FakeType { NotReal }
string s = "enum FakeType { Injected }";
public enum RealKind { Alpha, Beta }
`;
  assert(symbolExistsInSource(commentTrapSource, "NotReal", ".cs", emptyConfig) === false, "F1: a line-comment-embedded fake enum member incorrectly resolved true");
  assert(symbolExistsInSource(commentTrapSource, "Injected", ".cs", emptyConfig) === false, "F1: a string-literal-embedded fake enum member incorrectly resolved true");
  assert(symbolExistsInSource(commentTrapSource, "Alpha", ".cs", emptyConfig) === true, "F1 test setup: a real enum member outside the comment/string must still resolve true");

  // F2 — rich Java enum, semicolon-terminated last constant. Also the
  // round-3 Blocker 2 depth-restriction case: a rich-enum constant's own
  // overridden method body assigns an instance field (`color = "...";`
  // inside MERCURY's own `hex()` override) — must NOT resolve as a
  // top-level enum member (the round-2 NEW-F1 regression this closes).
  const richEnumSource = `
public enum Planet {
    MERCURY(3.3e23) {
        public double hex() {
            color = "#8C7853";
            return 1.0;
        }
    },
    VENUS(4.9e24) {
        public double hex() { return 2.0; }
    },
    MARS(6.4e23) {
        public double hex() {
            color = "#B22222";
            return 3.0;
        }
    };

    private double mass;
    private String color;

    Planet(double mass) { this.mass = mass; }
    public abstract double hex();
}
`;
  for (const name of ["MERCURY", "VENUS", "MARS"]) {
    assert(symbolExistsInSource(richEnumSource, name, ".java", emptyConfig) === true, `F2: real Java rich-enum constant "${name}" not found`);
  }
  assert(
    symbolExistsInSource(richEnumSource, "color", ".java", emptyConfig) === false,
    "round-3 Blocker 2 (NEW-F1): a rich-enum constant's own method-body field assignment incorrectly resolved as a top-level enum member",
  );

  // Round-3 Blocker 2, second depth-restriction fixture: a static
  // initializer block's own assignment target must not resolve either.
  const staticInitSource = `
public enum Status {
    A, B, C;
    static { x = 5; }
    static int x;
}
`;
  assert(
    symbolExistsInSource(staticInitSource, "x", ".java", emptyConfig) === false,
    "round-3 Blocker 2 (NEW-F1): a static/instance initializer block's own assignment target incorrectly resolved as a top-level enum member",
  );
  for (const name of ["A", "B", "C"]) {
    assert(symbolExistsInSource(staticInitSource, name, ".java", emptyConfig) === true, `real enum constant "${name}" not found alongside the static-initializer-block fixture`);
  }

  // C# explicit-value enum (the other F2 closure) + a plain C# enum with no
  // trailing members (the shape used again at Layer 2, see below).
  const csEnumSource = `
public enum TaskState {
    Active = 1,
    Inactive = 2,
}
`;
  assert(symbolExistsInSource(csEnumSource, "Active", ".cs", emptyConfig) === true, "C# explicit-value enum member 'Active' not found");
  assert(symbolExistsInSource(csEnumSource, "Inactive", ".cs", emptyConfig) === true, "C# explicit-value enum member 'Inactive' not found");
  const csPlainEnumSource = "public enum WidgetKind { Small, Medium, Large }\n";
  assert(symbolExistsInSource(csPlainEnumSource, "Medium", ".cs", emptyConfig) === true, "plain C# enum member 'Medium' (no trailing members) not found");
  // Real bug found while executing the 0.5.1 mutation mandate (not in the
  // hardening plan's own fixture list): the LAST member in a comma-
  // separated list with no trailing comma before the closing brace — the
  // ordinary, ubiquitous `enum Foo { A, B, C }` shape — has no follower
  // punctuation left inside the interior span at all (the span's own
  // closing `}` is deliberately excluded from the sliced text). Without
  // the `$`-end-of-span follower alternative, "Large" here false-
  // negatively resolved false.
  assert(symbolExistsInSource(csPlainEnumSource, "Large", ".cs", emptyConfig) === true, "plain C# enum's LAST member 'Large' (no trailing comma before the closing brace) not found");

  // Swift `case`-vs-switch-collision case — an identically-named switch
  // `case` label elsewhere in the file must not gate/confuse the result,
  // AND (the actual regression this guards against, per §1.3.3/§5.2(b)) a
  // switch-statement `case` label for a symbol that is NEVER a real enum
  // member must not be mistaken for one just because it textually matches
  // `case <name>` somewhere outside any enum body.
  const swiftSource = `
enum Direction {
    case north, south
}

func describe(d: Direction) -> String {
    switch d {
    case north:
        return "N"
    default:
        return "?"
    }
}

func classify(code: Int) -> String {
    switch code {
    case notARealDirectionMember:
        return "special"
    default:
        return "normal"
    }
}
`;
  assert(
    symbolExistsInSource(swiftSource, "north", ".swift", emptyConfig) === true,
    "Swift enum case 'north' not found (real declaration inside the enum body)",
  );
  assert(
    symbolExistsInSource(swiftSource, "notARealDirectionMember", ".swift", emptyConfig) === false,
    "a switch-statement `case` label for a symbol that is NEVER a real enum member was incorrectly resolved true (body-span scoping regression — the collision this test exists to catch)",
  );

  console.log("check-doc-cites --self-test: Layer 1 (D1 enum-member) — all assertions passed.");
}

// Adversarial-timing proofs (§1.6) — sandboxed by the hardening plan's
// planner before being written up; re-asserted here against the actual
// shipped implementation. Each of these has a corresponding MUTATION (see
// the 0.5.1 change log's mutation transcript) that must make the relevant
// assertion below go RED: (a) disabling the windowed scan (feeding the
// whole stripped file to the method-decl regex with the `m` flag restored),
// (b) removing the 50,000-char per-span cap on the enum-body depth-counter.
function runSelfTestTimingCSharpJavaMethodDecl() {
  const emptyConfig = { ...DEFAULT_CONFIG };

  // (i) thousands of pathological modifier-only lines, at BOTH a typical
  // (~3,000) AND a stress (50,000+) size — never test at only one
  // line-count, per the round-2 safety re-audit's explicit recommendation.
  const modifierLine = "    public static async override readonly partial\n";
  for (const n of [3000, 50000]) {
    const pathological = modifierLine.repeat(n) + "public void NeverDeclaredTarget_XYZ() {}\n";
    const start = Date.now();
    const found = symbolExistsInSource(pathological, "SomeSymbolThatIsNeverDeclaredAnywhere", ".cs", emptyConfig);
    const elapsed = Date.now() - start;
    assert(found === false, `timing fixture setup: an undeclared symbol unexpectedly resolved true at n=${n} pathological modifier-only lines`);
    assert(
      elapsed < 3000,
      `csharpJavaMethodDeclOccursIn took ${elapsed}ms against ${n} pathological modifier-only lines (expected <3000ms, bounded) — possible O(n^2) regression in the windowed scan`,
    );
  }

  // (ii) a single ~2MB pathological line — proves the per-window char cap
  // (not just the line-count) bounds the cost.
  {
    const hugeLine = "public static async ".repeat(100_000);
    const start = Date.now();
    const found = symbolExistsInSource(hugeLine, "NeverDeclaredOnHugeSingleLine", ".cs", emptyConfig);
    const elapsed = Date.now() - start;
    assert(found === false, "timing fixture setup: unexpectedly resolved true on the ~2MB single-line fixture");
    assert(elapsed < 3000, `csharpJavaMethodDeclOccursIn took ${elapsed}ms against a ~2MB single pathological line (expected <3000ms — capped by the window's own MAX_WINDOW_LINE_CHARS)`);
  }

  // (iii) thousands of near-miss [Attribute]-prefixed lines.
  {
    const attrLine = '    [SomeAttribute("value")]\n    public void AlsoNeverTheTarget() {}\n';
    const pathological = attrLine.repeat(50_000);
    const start = Date.now();
    const found = symbolExistsInSource(pathological, "NeverDeclaredAmongAttributes", ".cs", emptyConfig);
    const elapsed = Date.now() - start;
    assert(found === false, "timing fixture setup: unexpectedly resolved true among attribute-prefixed lines");
    assert(elapsed < 3000, `csharpJavaMethodDeclOccursIn took ${elapsed}ms against 50,000 attribute-prefixed near-miss lines (expected <3000ms)`);
  }

  console.log("check-doc-cites --self-test: Timing (D1 method-decl windowed scan, §1.6a) — all assertions passed.");
}

function runSelfTestTimingEnumSpanCap() {
  const emptyConfig = { ...DEFAULT_CONFIG };
  // Many unclosed/pathological enum openers, each followed by a long
  // non-terminating (brace-free) body — the 50,000-char per-span cap is the
  // genuine ReDoS guard on this path (§1.3.1); removing it (mutation
  // target) reproduces a real, dramatic blowup on this exact fixture shape.
  // A 20,000-char (well over the 50,000-char cap once summed across a
  // handful of openers, and enough that an UNCAPPED scan's per-opener cost
  // is dominated by the filler rather than the cap) non-terminating body
  // per opener — chosen for a wide, environment-noise-resistant timing
  // margin between the capped (fast) and uncapped (catastrophic) cases,
  // not merely "passes once."
  const unit = "enum NeverClosedKind {\n" + "x".repeat(20000) + "\n";
  for (const n of [500, 1000]) {
    const pathological = unit.repeat(n);
    const start = Date.now();
    const found = symbolExistsInSource(pathological, "NeverAMemberOfAnyOfThese", ".java", emptyConfig);
    const elapsed = Date.now() - start;
    assert(found === false, `timing fixture setup: unexpectedly resolved true at n=${n} unclosed enum openers`);
    assert(
      elapsed < 3000,
      `findAllEnumBodySpans took ${elapsed}ms against ${n} unclosed/pathological enum openers (expected <3000ms — the 50,000-char per-span cap must bound each opener's scan) — possible ReDoS regression`,
    );
  }
  console.log("check-doc-cites --self-test: Timing (D1 enum-span 50,000-char cap, §1.6b) — all assertions passed.");
}

function runSelfTestLayer2CSharpMemberDecl() {
  const scratchRoot = mkdtempSync(join(tmpdir(), "check-doc-cites-selftest-csharp-"));
  try {
    const docsAreaDir = join(scratchRoot, "docs", "area");
    mkdirSync(docsAreaDir, { recursive: true });

    writeFileSync(
      join(scratchRoot, "IWidgetService.cs"),
      "public interface IWidgetService {\n    Task<WidgetResponse> GetWidgetAsync(int id);\n}\n",
      "utf8",
    );
    writeFileSync(
      join(scratchRoot, "WidgetService.cs"),
      "public class WidgetService : IWidgetService {\n    public async Task<WidgetResponse> GetWidgetAsync(int id) {\n        return await _repo.FindAsync(id);\n    }\n}\n",
      "utf8",
    );
    writeFileSync(join(scratchRoot, "WidgetKind.cs"), "public enum WidgetKind { Small, Medium, Large }\n", "utf8");

    const readmePath = join(docsAreaDir, "README.md");
    const goodBody =
      '---\ncovers:\n  - "IWidgetService.cs § GetWidgetAsync"\n  - "WidgetService.cs § GetWidgetAsync"\n  - "WidgetKind.cs § Medium"\nrelated: []\nstatus: current\n---\n\n# Widgets\n\nBody.\n';
    writeFileSync(readmePath, goodBody, "utf8");

    const config = { ...DEFAULT_CONFIG, scopedDocDirs: ["docs/area"], docsRoot: "docs" };

    let violations = main(scratchRoot, config);
    assert(violations.length === 0, `D1 Core Layer 2 PASS case unexpectedly failed: ${JSON.stringify(violations)}`);

    // Mutate one citation to a genuine, never-declared call-site-shaped
    // name -> must go RED.
    const badBody = goodBody.replace('"WidgetService.cs § GetWidgetAsync"', '"WidgetService.cs § NeverDeclaredCallSite"');
    writeFileSync(readmePath, badBody, "utf8");
    violations = main(scratchRoot, config);
    assert(
      violations.some((v) => v.startsWith("[symbol-appears-in-file]") && v.includes("NeverDeclaredCallSite")),
      `mutated citation to a never-declared symbol did not go RED as expected: ${JSON.stringify(violations)}`,
    );

    // Revert -> GREEN.
    writeFileSync(readmePath, goodBody, "utf8");
    violations = main(scratchRoot, config);
    assert(violations.length === 0, `D1 Core Layer 2 GREEN (post-revert) case unexpectedly failed: ${JSON.stringify(violations)}`);

    console.log("check-doc-cites --self-test: Layer 2 (D1 C#/enum member decl, PASS/RED/GREEN) — passed.");
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 0.5.1 hardening — D2 (space-containing `covers` paths) self-tests. Each
// of the two check-doc-cites.mjs regexes gets its own isolating fixture and
// mutation (round-3 Blocker 4(a)) — see doc-drift-status.mjs for the third
// (STRIP_CITE_SUFFIX_RE).
// ---------------------------------------------------------------------------

function runSelfTestLayer2SpacePathBare() {
  const scratchRoot = mkdtempSync(join(tmpdir(), "check-doc-cites-selftest-spacepath-bare-"));
  try {
    const docsAreaDir = join(scratchRoot, "docs", "area");
    mkdirSync(docsAreaDir, { recursive: true });
    const routinesDir = join(scratchRoot, "Some_Reports_DB", "Stored Routines");
    mkdirSync(routinesDir, { recursive: true });
    writeFileSync(join(routinesDir, "GetSummary.sql"), "-- synthetic fixture\nSELECT 1;\n", "utf8");

    const readmePath = join(docsAreaDir, "README.md");
    const goodBody =
      '---\ncovers:\n  - "Some_Reports_DB/Stored Routines/GetSummary.sql"\nrelated: []\nstatus: current\n---\n\n# Reports\n\nBody.\n';
    writeFileSync(readmePath, goodBody, "utf8");

    const config = { ...DEFAULT_CONFIG, scopedDocDirs: ["docs/area"], docsRoot: "docs" };

    let violations = main(scratchRoot, config);
    assert(violations.length === 0, `D2 bare space-path (COVERS_BARE_PATH_RE) PASS case unexpectedly failed: ${JSON.stringify(violations)}`);

    // Mutate to a nonexistent space-containing path -> must go RED with
    // [cited-file-exists] (NOT a truncated-path message).
    const badBody = goodBody.replace("GetSummary.sql", "GetSummaryNonexistent.sql");
    writeFileSync(readmePath, badBody, "utf8");
    violations = main(scratchRoot, config);
    assert(
      violations.some((v) => v.startsWith("[cited-file-exists]") && v.includes("Stored Routines") && v.includes("GetSummaryNonexistent.sql")),
      `a nonexistent space-containing bare path did not go RED with a full, untruncated [cited-file-exists] path as expected: ${JSON.stringify(violations)}`,
    );

    writeFileSync(readmePath, goodBody, "utf8");
    violations = main(scratchRoot, config);
    assert(violations.length === 0, `D2 bare space-path GREEN (post-revert) case unexpectedly failed: ${JSON.stringify(violations)}`);

    console.log("check-doc-cites --self-test: Layer 2 (D2 COVERS_BARE_PATH_RE space admission) — passed.");
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function runSelfTestLayer2SpacePathCitation() {
  const scratchRoot = mkdtempSync(join(tmpdir(), "check-doc-cites-selftest-spacepath-citation-"));
  try {
    const docsAreaDir = join(scratchRoot, "docs", "area");
    mkdirSync(docsAreaDir, { recursive: true });
    const legacyDir = join(scratchRoot, "Legacy Utils");
    mkdirSync(legacyDir, { recursive: true });
    // Deliberately a plain, already-proven .ts declaration, isolating this
    // test from any D1 complexity.
    writeFileSync(join(legacyDir, "helpers.ts"), "export function doThing() {}\n", "utf8");

    const readmePath = join(docsAreaDir, "README.md");
    const goodBody =
      '---\ncovers:\n  - "Legacy Utils/helpers.ts § doThing"\nrelated: []\nstatus: current\n---\n\n# Legacy\n\nBody.\n';
    writeFileSync(readmePath, goodBody, "utf8");

    const config = { ...DEFAULT_CONFIG, scopedDocDirs: ["docs/area"], docsRoot: "docs" };

    let violations = main(scratchRoot, config);
    assert(violations.length === 0, `D2 covers-citation space-path (COVERS_CITATION_RE) PASS case unexpectedly failed: ${JSON.stringify(violations)}`);

    // Mutate the SYMBOL (not the path) to a never-declared name -> must go
    // RED with [symbol-appears-in-file], proving the space-containing path
    // itself was correctly parsed (not truncated) — the file-exists check
    // already had to pass to reach the symbol check at all.
    const badBody = goodBody.replace("§ doThing", "§ neverDeclaredThing");
    writeFileSync(readmePath, badBody, "utf8");
    violations = main(scratchRoot, config);
    assert(
      violations.some((v) => v.startsWith("[symbol-appears-in-file]") && v.includes("neverDeclaredThing")),
      `mutated symbol on a space-containing covers citation did not go RED with [symbol-appears-in-file] as expected: ${JSON.stringify(violations)}`,
    );

    writeFileSync(readmePath, goodBody, "utf8");
    violations = main(scratchRoot, config);
    assert(violations.length === 0, `D2 covers-citation space-path GREEN (post-revert) case unexpectedly failed: ${JSON.stringify(violations)}`);

    console.log("check-doc-cites --self-test: Layer 2 (D2 COVERS_CITATION_RE space admission) — passed.");
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function runSelfTestLayer2MdSectionCarveout() {
  const scratchRoot = mkdtempSync(join(tmpdir(), "check-doc-cites-selftest-mdcarveout-"));
  try {
    const docsAreaDir = join(scratchRoot, "docs", "area");
    mkdirSync(docsAreaDir, { recursive: true });
    // Deliberately OUTSIDE scopedDocDirs — this is the referenced target,
    // not itself linted for frontmatter well-formedness (that's a separate,
    // unrelated check this test doesn't want to also exercise).
    const referenceDir = join(scratchRoot, "docs", "reference");
    mkdirSync(referenceDir, { recursive: true });
    writeFileSync(join(referenceDir, "Overview.md"), "# Overview\n\nSome text.\n", "utf8");

    const readmePath = join(docsAreaDir, "README.md");
    const goodBody =
      '---\ncovers:\n  - "docs/reference/Overview.md § Overview"\nrelated: []\nstatus: current\n---\n\n# Area\n\nBody.\n';
    writeFileSync(readmePath, goodBody, "utf8");

    const config = { ...DEFAULT_CONFIG, scopedDocDirs: ["docs/area"], docsRoot: "docs" };

    let violations = main(scratchRoot, config);
    assert(
      !violations.some((v) => v.startsWith("[symbol-appears-in-file]")),
      `a bare .md § Section doc-section cross-reference was incorrectly treated as a code citation: ${JSON.stringify(violations)}`,
    );

    // Negative case: a nonexistent .md path must still fire
    // [cited-file-exists] — the carve-out must not swallow THAT check.
    const badBody = goodBody.replace("docs/reference/Overview.md", "docs/reference/NonexistentDoc.md");
    writeFileSync(readmePath, badBody, "utf8");
    violations = main(scratchRoot, config);
    assert(
      violations.some((v) => v.startsWith("[cited-file-exists]") && v.includes("NonexistentDoc.md")),
      `a nonexistent .md path in a bare § Section reference did not still fire [cited-file-exists]: ${JSON.stringify(violations)}`,
    );

    writeFileSync(readmePath, goodBody, "utf8");
    violations = main(scratchRoot, config);
    assert(violations.length === 0, `D3 GREEN (post-revert) case unexpectedly failed: ${JSON.stringify(violations)}`);

    console.log("check-doc-cites --self-test: Layer 2 (D3 bare .md § Section carve-out) — passed.");
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function runSelfTest() {
  runSelfTestLayer1();
  runSelfTestLayer1CSharpJavaMethodDecl();
  runSelfTestLayer1EnumMember();
  runSelfTestTimingCSharpJavaMethodDecl();
  runSelfTestTimingEnumSpanCap();
  runSelfTestLayer2();
  runSelfTestLayer2CSharpMemberDecl();
  runSelfTestLayer2SpacePathBare();
  runSelfTestLayer2SpacePathCitation();
  runSelfTestLayer2MdSectionCarveout();
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
