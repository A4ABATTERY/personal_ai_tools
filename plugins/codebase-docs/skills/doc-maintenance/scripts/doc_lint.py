#!/usr/bin/env python3
"""Generic Markdown link linter for a tiered docs/ tree.

Scans <docs>/**/*.md, extracts every markdown link, and verifies that each
relative link target resolves to a real file on disk. Links into the codebase
(relative paths to source files) are validated like any other path. This is the
verification gate referenced by the `doc-maintenance` skill: it must report
0 broken links before committing.

Codebase-agnostic: pass the docs root(s) as arguments. With no path argument it
defaults to ./docs relative to the current working directory.

Usage:
    python3 doc_lint.py                 # lint ./docs ; exit 1 if any broken link
    python3 doc_lint.py path/to/docs    # lint a specific docs root
    python3 doc_lint.py docs other/docs # lint several roots in one run
    python3 doc_lint.py --strict        # also fail on in-docs links pointing at a directory

On Windows you can substitute `py` for `python3`.
"""
import os
import re
import sys

# [text](target)  — capture target, ignoring optional "title"
LINK_RE = re.compile(r"\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+\"[^\"]*\")?\s*\)")


def is_external(target: str) -> bool:
    return bool(re.match(r"^(https?:|mailto:|tel:|ftp:|//|#)", target, re.I))


def lint_root(docs: str, strict: bool) -> tuple[int, int, int]:
    """Lint one docs root. Returns (n_md_files, n_checked, n_broken)."""
    docs = os.path.abspath(docs)
    if not os.path.isdir(docs):
        print(f"docs/ not found at {docs}")
        return (0, 0, 1)  # treat a missing root as one failure

    broken, dirlinks, checked = [], [], 0
    md_files = []
    for dirpath, _dirs, files in os.walk(docs):
        for f in files:
            if f.lower().endswith(".md"):
                md_files.append(os.path.join(dirpath, f))

    for md in md_files:
        with open(md, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
        base = os.path.dirname(md)
        for m in LINK_RE.finditer(text):
            target = m.group(1).strip().strip("<>")
            if is_external(target) or not target:
                continue
            # strip anchor / query
            path = target.split("#", 1)[0].split("?", 1)[0]
            if not path:
                continue
            checked += 1
            resolved = os.path.normpath(os.path.join(base, path))
            if not os.path.exists(resolved):
                broken.append((os.path.relpath(md, docs), target))
            elif os.path.isdir(resolved) and resolved.startswith(docs):
                dirlinks.append((os.path.relpath(md, docs), target))

    print(f"[{docs}] scanned {len(md_files)} markdown files, checked {checked} relative links.")
    if dirlinks:
        print(f"  {len(dirlinks)} in-docs directory link(s) (nudge: point at a specific .md):")
        for src, tgt in dirlinks:
            print(f"    {src} -> {tgt}")
    if broken:
        print(f"  {len(broken)} BROKEN link(s):")
        for src, tgt in broken:
            print(f"    {src} -> {tgt}")
    else:
        print("  0 broken links.")

    n_broken = len(broken)
    if strict:
        n_broken += len(dirlinks)
    return (len(md_files), checked, n_broken)


def main() -> int:
    argv = sys.argv[1:]
    strict = "--strict" in argv
    roots = [a for a in argv if not a.startswith("-")]
    if not roots:
        roots = ["docs"]

    total_md, total_checked, total_broken = 0, 0, 0
    for root in roots:
        md, checked, broken = lint_root(root, strict)
        total_md += md
        total_checked += checked
        total_broken += broken

    if len(roots) > 1:
        print(f"\nTotal: {total_md} files, {total_checked} links checked, {total_broken} failing.")

    return 1 if total_broken else 0


if __name__ == "__main__":
    sys.exit(main())
