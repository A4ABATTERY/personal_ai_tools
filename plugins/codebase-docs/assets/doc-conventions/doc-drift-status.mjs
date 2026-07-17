#!/usr/bin/env node
// codebase-docs plugin asset — doc-drift-status.mjs
// codebase-docs-plugin-asset-version: {{PLUGIN_ASSET_VERSION}}
//
// A zero-dependency, zero-network Node ESM script that answers "WHEN have
// docs drifted" by comparing git timestamps of a doc against the code it
// `covers` (L3-vs-L2), and a doc's own git history against its L1 sibling's
// (L2-vs-L1). Report-only by default (never mutates anything, always exits
// 0 — an informational tool); a local-only `--write` flag opts into writing
// `status`/`status_note` back into frontmatter (NEVER pass --write in CI).
//
// Linkage model (how L1<->L2<->L3 is declared — no new frontmatter keys):
//   - L2 -> L3: the doc's own frontmatter `covers` list, exactly as already
//     written for the citation lint (a `path` or `path § symbol` string; the
//     `§ symbol` suffix is stripped to the bare path — this tool operates at
//     FILE-LEVEL granularity in v1, never symbol-body granularity).
//   - L2 -> L1: DIRECTORY ADJACENCY, not a frontmatter key. An L2's L1 is the
//     README.md in the SAME directory. `related` is deliberately NOT part of
//     this linkage graph (a repo's real `related` lists are commonly
//     incomplete/inconsistent in both directions — directory-adjacency is
//     the only design that needs zero new frontmatter and works against a
//     repo's existing frontmatter AS-IS).
//
// v1 known limitations (named here, not silently assumed away):
//   - `--follow` rename tracking is a git heuristic (content-similarity
//     based) — breaks on directory renames or heavily-rewritten files.
//   - File-level granularity only; symbol-level diffing is a documented v2
//     idea.
//   - Minor/major thresholds are a reasoned starting point, not empirically
//     tuned against a large corpus of real minor/major examples.
//
// Usage: node doc-drift-status.mjs [--out <path>] [--format=md] [--write]
//   Report-only by default: prints JSON to stdout (or writes it to --out),
//   always exits 0. --format=md additionally prints a human-readable table.
//   --write (LOCAL ONLY, never in CI): for every major/minor verdict, writes
//   status_note (minor) or leaves status for a human to change (major) back
//   into the covering L2's frontmatter.
// Usage: node doc-drift-status.mjs --self-test
//   Runs this asset's own correctness self-test (pure-function + a scratch
//   git-repo RED/GREEN proof) and exits 0/1. Never touches the real target
//   repo when this flag is passed.

import {
  readFileSync,
  existsSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_THRESHOLDS = {
  l2MinorPct: 15,
  l2MajorPct: 40,
  minAbsoluteLinesChanged: 5,
};

const DEFAULT_CONFIG = {
  scopedDocDirs: [],
  docsRoot: "docs",
};

function loadConfig() {
  const configPath = join(__dirname, "doc-cite-config.json");
  if (!existsSync(configPath)) return { ...DEFAULT_CONFIG, ...DEFAULT_THRESHOLDS };
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    return { ...DEFAULT_CONFIG, ...DEFAULT_THRESHOLDS, ...raw };
  } catch (e) {
    console.error(
      `doc-drift-status: doc-cite-config.json failed to parse (${e.message}) — falling back to built-in defaults`,
    );
    return { ...DEFAULT_CONFIG, ...DEFAULT_THRESHOLDS };
  }
}

// ---------------------------------------------------------------------------
// Frontmatter parsing/writing — the same restricted flat grammar the lint
// engine uses (list-of-strings + one scalar + one optional scalar).
// ---------------------------------------------------------------------------

function parseFrontmatter(text) {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    return { error: "missing opening `---` frontmatter delimiter" };
  }
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return { error: "missing opening `---` frontmatter delimiter" };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { error: "missing closing `---` frontmatter delimiter" };
  const block = lines.slice(1, end);
  const data = {};
  const order = [];
  let currentKey = null;
  for (const raw of block) {
    if (raw.trim() === "") continue;
    const listItemMatch = /^\s*-\s+(.*)$/.exec(raw);
    if (listItemMatch && currentKey) {
      data[currentKey].push(stripQuotes(listItemMatch[1].trim()));
      continue;
    }
    const kvMatch = /^([A-Za-z_]+):\s*(.*)$/.exec(raw);
    if (kvMatch) {
      const key = kvMatch[1];
      const rest = kvMatch[2].trim();
      order.push(key);
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
  return { data, order, bodyStartLine: end + 1, rawLines: lines, delimiterEndIdx: end };
}

function stripQuotes(s) {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/** Lossless-ish round-trip writer: re-serializes a parsed frontmatter block
 *  back to the same flat grammar, preserving key order. Used only by
 *  --write. */
function serializeFrontmatter(data, order) {
  const lines = ["---"];
  const seen = new Set();
  const keysInOrder = [...order.filter((k) => !seen.has(k) && seen.add(k))];
  for (const key of Object.keys(data)) {
    if (!keysInOrder.includes(key)) keysInOrder.push(key);
  }
  for (const key of keysInOrder) {
    const val = data[key];
    if (Array.isArray(val)) {
      if (val.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of val) lines.push(`  - "${item}"`);
      }
    } else if (val === null) {
      lines.push(`${key}: null`);
    } else {
      const needsQuotes = /[:#]/.test(String(val)) || String(val).trim() !== String(val);
      lines.push(needsQuotes ? `${key}: "${val}"` : `${key}: ${val}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}

function writeFrontmatterUpdate(absPath, mutateFn) {
  const text = readFileSync(absPath, "utf8");
  const fm = parseFrontmatter(text);
  if (fm.error) return { error: fm.error };
  mutateFn(fm.data);
  const newBlock = serializeFrontmatter(fm.data, fm.order);
  const bodyLines = fm.rawLines.slice(fm.delimiterEndIdx + 1);
  const newText = newBlock + "\n" + bodyLines.join("\n");
  writeFileSync(absPath, newText, "utf8");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(repoRoot, args) {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  } catch (e) {
    return e.stdout ? e.stdout.toString() : "";
  }
}

function isGitRepo(repoRoot) {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

function isShallowRepo(repoRoot) {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** Case table (on-disk existence x git history) — resolves the "deleted
 *  but once tracked" vs "never existed" vs "untracked but present" cases
 *  BEFORE any timestamp comparison happens, per the design's §4.2 case
 *  table. Returns { case: "normal"|"deletedTracked"|"neverExisted"|"untracked", hash, ts }. */
function resolvePathHistory(repoRoot, relPath) {
  const absExists = existsSync(join(repoRoot, relPath));
  const out = git(repoRoot, ["log", "-1", "--follow", "--format=%H%x09%ct", "--", relPath]).trim();
  const hasHistory = out.length > 0;
  if (absExists && hasHistory) {
    const [hash, ts] = out.split("\t");
    return { case: "normal", hash, ts: Number(ts) };
  }
  if (!absExists && hasHistory) {
    const [hash, ts] = out.split("\t");
    return { case: "deletedTracked", hash, ts: Number(ts) };
  }
  if (!absExists && !hasHistory) {
    return { case: "neverExisted" };
  }
  return { case: "untracked" };
}

/** Undamped "last touched" — used for a doc's OWN timestamp (a doc's own
 *  edit, even whitespace-only, is a real "someone touched this doc" signal). */
function lastTouched(repoRoot, relPath) {
  const info = resolvePathHistory(repoRoot, relPath);
  if (info.case !== "normal") return null;
  return { hash: info.hash, ts: info.ts, iso: new Date(info.ts * 1000).toISOString() };
}

/** Header-boundary block parser for `git log -w --numstat --format='%H%x09%ct'`
 *  output — recognizes header lines by their fixed shape as the sole block
 *  boundary (never by counting a fixed number of following lines), robust
 *  to git-version variance in blank-line-separator presence. A block with
 *  ZERO numstat-shaped data lines inside it is the churn-damped skip case
 *  (a whitespace-only commit), by construction. */
function parseNumstatBlocks(raw) {
  const lines = raw.split("\n");
  const HEADER_RE = /^[0-9a-f]{40}\t\d+$/;
  const DATA_RE = /^\d+\t\d+\t.+$/;
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (HEADER_RE.test(line)) {
      if (current) blocks.push(current);
      const [hash, ts] = line.split("\t");
      current = { hash, ts: Number(ts), dataLines: [] };
      continue;
    }
    if (current && DATA_RE.test(line)) {
      current.dataLines.push(line);
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

/** Damped "last touched" for the CODE side of the L3-vs-L2 check only:
 *  walks commits newest-first and returns the timestamp of the first block
 *  with at least one real numstat data line — skipping past any newest-
 *  first run of whitespace-only commits to the nearest genuine content
 *  change. */
function lastTouchedDamped(repoRoot, relPath) {
  const info = resolvePathHistory(repoRoot, relPath);
  if (info.case !== "normal") return null;
  const raw = git(repoRoot, ["log", "--follow", "-w", "--numstat", "--format=%H%x09%ct", "--", relPath]);
  const blocks = parseNumstatBlocks(raw);
  for (const block of blocks) {
    if (block.dataLines.length > 0) {
      return { hash: block.hash, ts: block.ts, iso: new Date(block.ts * 1000).toISOString() };
    }
  }
  // Every commit on this path was whitespace-only (or history is empty
  // despite `resolvePathHistory` reporting "normal" — defensive fallback):
  // fall back to the undamped newest commit rather than reporting nothing.
  if (blocks.length > 0) {
    const b = blocks[0];
    return { hash: b.hash, ts: b.ts, iso: new Date(b.ts * 1000).toISOString() };
  }
  return lastTouched(repoRoot, relPath);
}

/** Lines-changed-since-a-timestamp for the L2-vs-L1 check, using the SAME
 *  -w whitespace-damping + header-boundary parsing as the L3 check (a
 *  heading-anchor-fix's 2-line diff must not register as "major" just
 *  because it crossed the timestamp line). `sinceTs` is exclusive (caller
 *  passes d1Ts+1 to correctly exclude a boundary commit that touched both
 *  the L1 and L2 at the same instant). */
function linesChangedSince(repoRoot, relPath, sinceTsExclusiveArg) {
  const raw = git(repoRoot, [
    "log",
    "--follow",
    "-w",
    "--numstat",
    "--format=%H%x09%ct",
    `--since=@${sinceTsExclusiveArg}`,
    "--",
    relPath,
  ]);
  const blocks = parseNumstatBlocks(raw);
  let total = 0;
  for (const block of blocks) {
    for (const dataLine of block.dataLines) {
      const [added, deleted] = dataLine.split("\t");
      const a = Number(added);
      const d = Number(deleted);
      if (!Number.isNaN(a)) total += a;
      if (!Number.isNaN(d)) total += d;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Discovery — scoped docs, `covers`, and L1 (directory-adjacency) siblings.
// ---------------------------------------------------------------------------

function listScopedMarkdownFiles(repoRoot, config) {
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

function stripCiteSuffix(coversEntry) {
  const m = /^([\w./-]+\.\w+)\s§\s.+$/.exec(coversEntry.trim());
  return m ? m[1] : coversEntry.trim();
}

function dedupeCovers(coversList) {
  const byPath = new Map();
  for (const entry of coversList) {
    const path = stripCiteSuffix(entry);
    byPath.set(path, (byPath.get(path) || 0) + 1);
  }
  return [...byPath.entries()].map(([path, citationCount]) => ({ path, citationCount }));
}

function l1SiblingFor(relDocPath) {
  const dir = dirname(relDocPath);
  const base = relDocPath.slice(dir.length + 1);
  if (base === "README.md") return null; // this doc IS the L1
  return join(dir, "README.md");
}

// ---------------------------------------------------------------------------
// The two checks
// ---------------------------------------------------------------------------

function runL3Drift(repoRoot, config, docs, integrityIssues, historicalOut) {
  const results = [];
  for (const relDoc of docs) {
    const text = readFileSync(join(repoRoot, relDoc), "utf8");
    const fm = parseFrontmatter(text);
    if (fm.error) {
      integrityIssues.push(`"${relDoc}" has no frontmatter yet (mid-migration?) — excluded from drift analysis`);
      continue;
    }
    if (!Array.isArray(fm.data.covers) || fm.data.covers.length === 0) {
      integrityIssues.push(`"${relDoc}" has an empty 'covers' list (also a lint violation) — excluded from L3-drift analysis`);
      continue;
    }
    const docInfo = lastTouched(repoRoot, relDoc);
    const deduped = dedupeCovers(fm.data.covers);
    const coversOut = [];
    let overallVerdict = "fresh";
    for (const { path, citationCount } of deduped) {
      const info = resolvePathHistory(repoRoot, path);
      if (info.case === "deletedTracked") {
        integrityIssues.push(
          `"${relDoc}" covers references '${path}', which no longer exists on disk (deleted in commit ${info.hash} at ${new Date(info.ts * 1000).toISOString()})`,
        );
        continue;
      }
      if (info.case === "neverExisted") {
        integrityIssues.push(
          `"${relDoc}" covers references '${path}', which has no git history and doesn't exist on disk (likely a typo or stale citation)`,
        );
        continue;
      }
      if (info.case === "untracked") {
        integrityIssues.push(
          `"${relDoc}" covers references '${path}', which exists on disk but has no git history (untracked?)`,
        );
        continue;
      }
      const codeInfo = lastTouchedDamped(repoRoot, path);
      const verdict = docInfo && codeInfo && codeInfo.ts > docInfo.ts ? "needs-maintenance" : "fresh";
      if (verdict === "needs-maintenance") overallVerdict = "needs-maintenance";
      coversOut.push({ path, codeLastTouched: codeInfo, verdict, citationCount });
    }
    const entry = {
      doc: relDoc,
      status: fm.data.status ?? null,
      docLastTouched: docInfo,
      covers: coversOut,
      overallVerdict,
    };
    if (fm.data.status === "historical") {
      historicalOut.push(entry);
    } else {
      results.push(entry);
    }
  }
  return results;
}

function runL1L2Drift(repoRoot, config, docs, integrityIssues) {
  const results = [];
  const docSet = new Set(docs);
  for (const relDoc of docs) {
    const l1 = l1SiblingFor(relDoc);
    if (l1 === null) continue; // this doc IS the L1
    if (!docSet.has(l1) || !existsSync(join(repoRoot, l1))) continue; // no L1 sibling — skipped, not an error
    const l1Info = lastTouched(repoRoot, l1);
    if (!l1Info) continue;
    const sinceExclusive = l1Info.ts + 1;
    const linesChanged = linesChangedSince(repoRoot, relDoc, sinceExclusive);
    const currentLineCount = readFileSync(join(repoRoot, relDoc), "utf8").split(/\r?\n/).length;
    const pctChanged = (100 * linesChanged) / Math.max(currentLineCount, 1);
    let verdict;
    if (linesChanged === 0) {
      continue; // no commit on D2 after D1 at all -> no drift on this axis
    } else if (linesChanged < config.minAbsoluteLinesChanged) {
      verdict = "trivial";
    } else if (pctChanged >= config.l2MajorPct) {
      verdict = "major";
    } else if (pctChanged >= config.l2MinorPct) {
      verdict = "minor";
    } else {
      verdict = "trivial";
    }
    results.push({
      l2: relDoc,
      l1,
      l1LastTouched: l1Info,
      linesChangedSinceL1: linesChanged,
      currentLineCount,
      pctChanged: Math.round(pctChanged * 100) / 100,
      verdict,
    });
  }
  return results;
}

function buildReport(repoRoot, config) {
  const integrityIssues = [];
  const historical = [];
  const docs = listScopedMarkdownFiles(repoRoot, config);
  const l3Drift = runL3Drift(repoRoot, config, docs, integrityIssues, historical);
  const l1l2Drift = runL1L2Drift(repoRoot, config, docs, integrityIssues);

  const summary = { needsMaintenance: 0, major: 0, minor: 0, trivial: 0, fresh: 0, historical: historical.length };
  for (const d of l3Drift) {
    if (d.overallVerdict === "needs-maintenance") summary.needsMaintenance++;
    else summary.fresh++;
  }
  for (const d of l1l2Drift) {
    if (d.verdict === "major") summary.major++;
    else if (d.verdict === "minor") summary.minor++;
    else summary.trivial++;
  }

  return {
    generatedAt: new Date().toISOString(),
    config: {
      l2MinorPct: config.l2MinorPct,
      l2MajorPct: config.l2MajorPct,
      minAbsoluteLinesChanged: config.minAbsoluteLinesChanged,
      shallowClone: isShallowRepo(repoRoot),
    },
    l3Drift,
    l3DriftHistorical: historical,
    l1l2Drift,
    integrityIssues,
    summary,
  };
}

function formatMarkdown(report) {
  const lines = [];
  lines.push(`# Doc drift status — generated ${report.generatedAt}`);
  lines.push("");
  lines.push(
    `Summary: ${report.summary.needsMaintenance} needs-maintenance, ${report.summary.major} major, ${report.summary.minor} minor, ${report.summary.trivial} trivial, ${report.summary.fresh} fresh, ${report.summary.historical} historical.`,
  );
  lines.push("");
  lines.push("## L3 (code) vs L2 (doc)");
  for (const d of report.l3Drift) {
    lines.push(`- **${d.doc}** — ${d.overallVerdict}`);
    for (const c of d.covers) {
      lines.push(`  - ${c.path}: ${c.verdict}`);
    }
  }
  lines.push("");
  lines.push("## L2 vs L1");
  for (const d of report.l1l2Drift) {
    lines.push(`- **${d.l2}** vs ${d.l1}: ${d.verdict} (${d.pctChanged}%, ${d.linesChangedSinceL1} lines)`);
  }
  if (report.integrityIssues.length > 0) {
    lines.push("");
    lines.push("## Integrity issues");
    for (const i of report.integrityIssues) lines.push(`- ${i}`);
  }
  return lines.join("\n");
}

function applyWrite(repoRoot, report) {
  for (const d of report.l1l2Drift) {
    if (d.verdict === "minor") {
      const absPath = join(repoRoot, d.l2);
      writeFrontmatterUpdate(absPath, (data) => {
        data.status_note = `drift: ${d.pctChanged}% changed since L1 last touched (${d.l1LastTouched.iso}) — minor, consider a status_note update`;
      });
    }
    // major: the tool never picks a new status value itself — leaves
    // `status` for a human to change, per the settled design.
  }
}

// ---------------------------------------------------------------------------
// Self-test (--self-test flag only; never touches a real target repo).
// ---------------------------------------------------------------------------

function assert(cond, msg) {
  if (!cond) {
    console.error(`SELF-TEST FAILED: ${msg}`);
    process.exit(1);
  }
}

function runSelfTestLayer1() {
  // %-changed math + threshold classification.
  const cfg = { ...DEFAULT_THRESHOLDS };
  const classify = (linesChanged, currentLineCount) => {
    const pct = (100 * linesChanged) / Math.max(currentLineCount, 1);
    if (linesChanged === 0) return "none";
    if (linesChanged < cfg.minAbsoluteLinesChanged) return "trivial";
    if (pct >= cfg.l2MajorPct) return "major";
    if (pct >= cfg.l2MinorPct) return "minor";
    return "trivial";
  };
  assert(classify(2, 500) === "trivial", "a 2-line change on a 500-line file must classify as trivial (below minAbsoluteLinesChanged floor)");
  assert(classify(80, 500) === "minor", `an 80/500=16% change must classify as minor, got ${classify(80, 500)}`);
  assert(classify(250, 500) === "major", `a 250/500=50% change must classify as major, got ${classify(250, 500)}`);
  assert(classify(6, 500) === "trivial", `a 6/500=1.2% change (above the 5-line floor but below 15%) must classify as trivial, got ${classify(6, 500)}`);

  // Header-boundary numstat parser — both "data line present" and "data
  // line absent" (whitespace-only commit) block shapes.
  const rawWithData = "abc123\t1000\n\n5\t2\tfile.md\n\ndef456\t1100\n\n3\t0\tfile.md\n";
  const blocksWithData = parseNumstatBlocks(rawWithData.replace("abc123", "a".repeat(40)).replace("def456", "b".repeat(40)));
  assert(blocksWithData.length === 2, `expected 2 blocks with data, got ${blocksWithData.length}`);
  assert(blocksWithData[0].dataLines.length === 1, "first block should have 1 data line");
  assert(blocksWithData[1].dataLines.length === 1, "second block should have 1 data line");

  const hashA = "a".repeat(40);
  const hashB = "b".repeat(40);
  const rawWhitespaceOnly = `${hashA}\t1000\n\n${hashB}\t1100\n\n5\t2\tfile.md\n`;
  const blocksWs = parseNumstatBlocks(rawWhitespaceOnly);
  assert(blocksWs.length === 2, `expected 2 blocks (one whitespace-only), got ${blocksWs.length}`);
  assert(blocksWs[0].dataLines.length === 0, "the whitespace-only (first, newest) block must have ZERO data lines — this is the damping signal");
  assert(blocksWs[1].dataLines.length === 1, "the second block must have its real data line");

  // Frontmatter round-trip: parse -> mutate -> write -> re-parse must be lossless.
  const fmText = '---\ncovers:\n  - "src/x.ts § foo"\nrelated:\n  - "docs/y.md"\nstatus: current\n---\n\nbody text\n';
  const parsed = parseFrontmatter(fmText);
  assert(!parsed.error, `frontmatter parse failed unexpectedly: ${parsed.error}`);
  const serialized = serializeFrontmatter(parsed.data, parsed.order);
  const reparsed = parseFrontmatter(serialized + "\n\nbody text\n");
  assert(!reparsed.error, `round-tripped frontmatter failed to re-parse: ${reparsed.error}`);
  assert(JSON.stringify(reparsed.data.covers) === JSON.stringify(parsed.data.covers), "round-trip lost/changed `covers`");
  assert(reparsed.data.status === parsed.data.status, "round-trip lost/changed `status`");

  console.log("doc-drift-status --self-test: Layer 1 (pure-function) — all assertions passed.");
}

function initScratchRepo() {
  const scratchRoot = mkdtempSync(join(tmpdir(), "doc-drift-status-selftest-"));
  execFileSync("git", ["init", "-q"], { cwd: scratchRoot });
  execFileSync("git", ["config", "user.email", "selftest@example.com"], { cwd: scratchRoot });
  execFileSync("git", ["config", "user.name", "selftest"], { cwd: scratchRoot });
  return scratchRoot;
}

function commitAt(scratchRoot, tsSeconds, message) {
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: `${tsSeconds} +0000`,
    GIT_COMMITTER_DATE: `${tsSeconds} +0000`,
  };
  execFileSync("git", ["add", "-A"], { cwd: scratchRoot, env });
  execFileSync("git", ["commit", "-q", "-m", message, "--allow-empty"], { cwd: scratchRoot, env });
}

function runSelfTestLayer2() {
  const scratchRoot = initScratchRepo();
  try {
    const docsDir = join(scratchRoot, "docs", "area");
    mkdirSync(docsDir, { recursive: true });
    const codePath = join(scratchRoot, "code.ts");
    const docPath = join(docsDir, "docA.md");

    writeFileSync(codePath, "export function real() {}\n", "utf8");
    writeFileSync(
      docPath,
      '---\ncovers:\n  - "code.ts"\nrelated: []\nstatus: current\n---\n\n# Doc A\n',
      "utf8",
    );
    const baseTs = 1_700_000_000;
    commitAt(scratchRoot, baseTs, "initial: docA + code.ts");

    const config = { ...DEFAULT_CONFIG, ...DEFAULT_THRESHOLDS, scopedDocDirs: ["docs/area"] };

    // RED case: edit code.ts AFTER the doc's commit -> needs-maintenance.
    writeFileSync(codePath, "export function real() {}\nexport function real2() {}\n", "utf8");
    commitAt(scratchRoot, baseTs + 1000, "edit code.ts (real change)");

    let report = buildReport(scratchRoot, config);
    const docEntry = report.l3Drift.find((d) => d.doc === "docs/area/docA.md");
    assert(docEntry, "docs/area/docA.md missing from l3Drift report");
    assert(
      docEntry.overallVerdict === "needs-maintenance",
      `expected needs-maintenance after a real code edit postdating the doc, got ${docEntry.overallVerdict}`,
    );

    // Churn-damping proof: a whitespace-only edit to code.ts, timestamped
    // even later, must NOT flip the verdict.
    writeFileSync(codePath, "export function real() {}\nexport function real2() {}   \n", "utf8");
    commitAt(scratchRoot, baseTs + 2000, "whitespace-only edit to code.ts");

    report = buildReport(scratchRoot, config);
    const docEntry2 = report.l3Drift.find((d) => d.doc === "docs/area/docA.md");
    assert(
      docEntry2.overallVerdict === "needs-maintenance",
      `verdict must remain needs-maintenance (unchanged) after a whitespace-only edit, got ${docEntry2.overallVerdict} — churn-damping is not working`,
    );
    const codeCoverEntry = docEntry2.covers.find((c) => c.path === "code.ts");
    assert(
      codeCoverEntry.codeLastTouched.ts === baseTs + 1000,
      `damped codeLastTouched.ts should still point at the REAL edit (${baseTs + 1000}), got ${codeCoverEntry.codeLastTouched.ts} — the whitespace-only commit was not damped`,
    );

    // Deleted-but-tracked proof: git rm code.ts, timestamped later still.
    execFileSync("git", ["rm", "-q", "code.ts"], { cwd: scratchRoot });
    commitAt(scratchRoot, baseTs + 3000, "delete code.ts");

    report = buildReport(scratchRoot, config);
    const hasIntegrityIssue = report.integrityIssues.some(
      (i) => i.includes("docs/area/docA.md") && i.includes("code.ts") && i.includes("no longer exists on disk"),
    );
    assert(
      hasIntegrityIssue,
      `expected an integrityIssues entry for the deleted-but-tracked code.ts, got: ${JSON.stringify(report.integrityIssues)}`,
    );
    const docEntry3 = report.l3Drift.find((d) => d.doc === "docs/area/docA.md");
    assert(
      !docEntry3 || docEntry3.overallVerdict !== "needs-maintenance",
      "a deleted-but-tracked covers path must NOT produce a needs-maintenance verdict using the deletion commit's timestamp",
    );

    console.log("doc-drift-status --self-test: Layer 2 (real-git RED/GREEN incl. deleted-path case) — passed.");
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

function runSelfTest() {
  runSelfTestLayer1();
  runSelfTestLayer2();
  console.log("doc-drift-status --self-test: ALL LAYERS PASSED.");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { out: null, format: "json", write: false, selfTest: false };
  for (const arg of argv) {
    if (arg === "--self-test") out.selfTest = true;
    else if (arg === "--write") out.write = true;
    else if (arg === "--format=md") out.format = "md";
    else if (arg.startsWith("--out=")) out.out = arg.slice("--out=".length);
    else if (arg === "--out") out.out = "__NEXT__";
    else if (out.out === "__NEXT__") out.out = arg;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.selfTest) {
  runSelfTest();
  process.exit(0);
}

const REPO_ROOT = resolve(__dirname, "..");

if (!isGitRepo(REPO_ROOT)) {
  console.error("doc-drift-status: not a git repository (or git is unavailable) — cannot compute timestamp-based drift.");
  process.exit(1);
}
if (isShallowRepo(REPO_ROOT)) {
  console.error(
    "doc-drift-status: WARNING — this is a shallow clone; git-history-based verdicts near the shallow boundary may be inaccurate (reported as config.shallowClone: true).",
  );
}

const config = loadConfig();
const report = buildReport(REPO_ROOT, config);

if (args.write) {
  console.error(
    "doc-drift-status: --write passed — writing status_note updates to frontmatter (LOCAL-ONLY; never pass --write in CI).",
  );
  applyWrite(REPO_ROOT, report);
}

const jsonOut = JSON.stringify(report, null, 2);
if (args.out) {
  writeFileSync(args.out, jsonOut, "utf8");
  console.error(`doc-drift-status: report written to ${args.out}`);
} else {
  console.log(jsonOut);
}
if (args.format === "md") {
  console.log("\n" + formatMarkdown(report));
}
process.exit(0); // informational tool — always exits 0 (CI never auto-fails on this)
