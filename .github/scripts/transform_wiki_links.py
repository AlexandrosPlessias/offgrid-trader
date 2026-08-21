#!/usr/bin/env python3
"""Transform docs/wiki markdown links for GitHub Wiki rendering.

GitHub Wiki pages must link to each other *without* the .md extension, and
relative paths like ../../SETUP.md are not resolved — they must be full URLs.

Usage:
    python3 scripts/transform_wiki_links.py <src_dir> <out_dir> [--repo <owner/repo>]

Example (used by the sync-wiki CI action):
    python3 scripts/transform_wiki_links.py docs/wiki _wiki_out \
        --repo AlexandrosPlessias/offgrid-trader
"""

from __future__ import annotations

import argparse
import re
import shutil
from pathlib import Path

# ---------------------------------------------------------------------------
# Substitution rules (applied in order)
# ---------------------------------------------------------------------------
# Each entry: (compiled_regex, replacement_template)
# The replacement may reference named groups from the regex.
#
# Rule 1 — repo-relative links (../../foo.md or ../foo.md) → full GitHub URL
# Rule 2 — wiki-internal links (foo.md or foo.md#anchor) → strip .md
# ---------------------------------------------------------------------------

REPO_LINK_RE = re.compile(r"\]\((?:\.\.\/)*\.\.\/(?P<path>[^)]+\.md(?:#[^)]*)?)\)")

# Non-.md repo-relative links (../../.vscode/foo.json, ../../tests/lint/bar.txt, …)
# These are valid repo paths but the wiki renderer can't traverse up; convert to BLOB URLs.
# Require a real file extension ([A-Za-z][A-Za-z0-9]*) so that bare directory paths
# like ../../infra/ (which have no extension) are NOT matched.
REPO_NONMD_LINK_RE = re.compile(r"\]\((?:\.\.\/)*\.\.\/(?P<path>[^)]+\.[A-Za-z][A-Za-z0-9]*)\)")

# Images under ../screenshots/ (one level up from docs/wiki) → raw GitHub URL.
# Matches both plain links ](../screenshots/foo.png) and markdown images
# ![alt](../screenshots/foo.png) — the ]( token is the same in both.
SCREENSHOT_LINK_RE = re.compile(
    r"\]\(\.\./screenshots/(?P<filename>[^)]+\.(?:png|jpg|jpeg|gif|svg|webp))\)"
)

WIKI_LINK_RE = re.compile(r"\]\((?P<page>[A-Za-z0-9_\-]+)\.md(?P<anchor>#[^)]*)?\)")


def transform(text: str, repo: str) -> str:
    blob_base = f"https://github.com/{repo}/blob/main"
    raw_base = f"https://raw.githubusercontent.com/{repo}/main"

    # Rule 1: ../../SETUP.md  →  https://github.com/.../blob/main/SETUP.md
    def _repo_link(m: re.Match) -> str:
        return f"]({blob_base}/{m.group('path')})"

    text = REPO_LINK_RE.sub(_repo_link, text)

    # Rule 2: ../screenshots/foo.png → raw GitHub URL under docs/screenshots/
    # NOTE: must run BEFORE Rule 1b — REPO_NONMD_LINK_RE also matches one-level
    # relative paths like ../screenshots/foo.png (because (?:\.\.\/)*\.\.\/
    # allows a single ../), which would convert them to wrong /blob/ URLs.
    # Processing screenshots first prevents that mis-match.
    def _screenshot_link(m: re.Match) -> str:
        return f"]({raw_base}/docs/screenshots/{m.group('filename')})"

    text = SCREENSHOT_LINK_RE.sub(_screenshot_link, text)

    # Rule 1b: ../../.vscode/foo.json  →  https://github.com/.../blob/main/.vscode/foo.json
    # Handles non-.md repo-relative links that the wiki renderer can't traverse.
    # Runs after screenshot links are already converted to absolute raw URLs.
    def _repo_nonmd_link(m: re.Match) -> str:
        return f"]({blob_base}/{m.group('path')})"

    text = REPO_NONMD_LINK_RE.sub(_repo_nonmd_link, text)

    # Rule 3: architecture.md  →  architecture
    #         indicators.md#rsi  →  indicators#rsi
    def _wiki_link(m: re.Match) -> str:
        anchor = m.group("anchor") or ""
        return f"]({m.group('page')}{anchor})"

    text = WIKI_LINK_RE.sub(_wiki_link, text)

    return text


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src", help="Source wiki directory (docs/wiki)")
    parser.add_argument("out", help="Output directory for transformed files")
    parser.add_argument(
        "--repo", default="AlexandrosPlessias/offgrid-trader", help="GitHub owner/repo slug"
    )
    args = parser.parse_args()

    src = Path(args.src)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    changed = 0
    for src_file in src.iterdir():
        dst_file = out / src_file.name
        if src_file.suffix == ".md":
            original = src_file.read_text(encoding="utf-8")
            transformed = transform(original, args.repo)
            dst_file.write_text(transformed, encoding="utf-8")
            if original != transformed:
                changed += 1
                print(f"  transformed: {src_file.name}")
            else:
                print(f"  unchanged:   {src_file.name}")
        else:
            # Copy non-.md files (.order, etc.) verbatim
            shutil.copy2(src_file, dst_file)
            print(f"  copied:      {src_file.name}")

    print(f"\nDone — {changed} file(s) had link substitutions.")


if __name__ == "__main__":
    main()
