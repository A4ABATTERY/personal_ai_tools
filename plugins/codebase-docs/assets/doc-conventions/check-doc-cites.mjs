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

const PATH_RE_SRC = String.raw`[\w./@-]+\.\w+`;
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

function checkOneCitation(repoRoot, config, relPath, context, citationText, violations, seenOut) {
  const parsed = /^([\w./-]+\.\w+)\s§\s(.+)$/.exec(citationText.trim());
  let path, symbol;
  if (parsed) {
    [, path, symbol] = parsed;
  } else if (/^[\w./-]+\.\w+$/.test(citationText.trim())) {
    path = citationText.trim();
    symbol = null;
  } else {
    return; // not a citation shape
  }

  seenOut.push({ relPath, context, path, symbol });

  const absTarget = join(repoRoot, path);
  if (isGeneratedPath(path, config)) return;
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
      if (!("covers" in data) || !Array.isArray(data.covers) || data.covers.length === 0) {
        violations.push(`[frontmatter] ${relPath}: \`covers\` must be a non-empty list`);
      }
      if (!("related" in data) || !Array.isArray(data.related)) {
        violations.push(`[frontmatter] ${relPath}: \`related\` must be a list (may be empty [])`);
      }
      if (!("status" in data) || (data.status !== "current" && data.status !== "historical")) {
        violations.push(
          `[frontmatter] ${relPath}: \`status\` must be exactly "current" or "historical" (found ${JSON.stringify(data.status)})`,
        );
      }
      if (Array.isArray(data.covers)) {
        for (const entry of data.covers) {
          checkOneCitation(repoRoot, config, relPath, `frontmatter covers: ${entry}`, entry, violations, allCitationsSeen);
        }
      }
    }

    let m;
    const bodyRe = new RegExp(CITATION_RE.source, "g");
    while ((m = bodyRe.exec(text))) {
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
  const extAlternation = config.knownCiteExtensions.map(escapeRegex).join("|");
  const oldStyleCiteRe = new RegExp(
    "`?([\\w./@-]+\\.(?:" + extAlternation + ")):(\\d+(?:[-–]\\d+)?(?:,\\s*\\d+(?:[-–]\\d+)?)*)`?",
    "g",
  );
  const exceptionTexts = new Set(exceptionRows.map((r) => r.citeText));
  for (const relPath of files) {
    const absPath = join(repoRoot, relPath);
    const text = readFileSync(absPath, "utf8");
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

    console.log("check-doc-cites --self-test: Layer 2 (real-filesystem RED/GREEN) — passed.");
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function runSelfTest() {
  runSelfTestLayer1();
  runSelfTestLayer2();
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

const REPO_ROOT = resolve(__dirname, "..");
const config = loadConfig();
const violations = main(REPO_ROOT, config);
if (violations.length > 0) {
  console.error(`check-doc-cites: FAIL — ${violations.length} violation(s):\n`);
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}
console.log("check-doc-cites: PASS — all citations/frontmatter/exceptions verified.");
