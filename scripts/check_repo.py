"""Repository health checks for C5 Sentinel-SAR.

The checks intentionally use only the Python standard library so they can run
before any project-specific environment exists.
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]

REQUIRED_PATHS = [
    "README.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "index.html",
    "demo/rescue-app.html",
    "docs/DEVELOPMENT.md",
    "docs/ARCHITECTURE.md",
    "docs/TACTICAL_UI_GUIDELINES.md",
    "docs/PRODUCTION_READINESS.md",
    "docs/OPERATIONS_SAFETY.md",
    "docs/C5_SENTINEL_SAR_MVP_SPEC_v1.2.md",
    "docs/API_SURFACE_v1.2.md",
    "docs/CHANGELOG_v1.2.md",
    "docs/METRICS_DICTIONARY.md",
    "docs/ROADMAP.md",
    "database/001_postgresql_schema_v1.2.sql",
    "database/002_seed_demo_data_v1.2.sql",
    "database/003_mci_ui_alignment.sql",
    "src/domain/rules.js",
    "tests/domain-rules.test.js",
    "analytics/c5_sentinel_sar_analytics_v1_1/README.md",
    "analytics/c5_sentinel_sar_analytics_v1_1/requirements.txt",
    "archive/v0.6",
    "archive/v0.7",
]

MARKDOWN_LINK_RE = re.compile(r"(?<!!)\[[^\]]+\]\(([^)]+)\)")


def fail(message: str, errors: list[str]) -> None:
    errors.append(message)


def check_required_paths(errors: list[str]) -> None:
    for rel in REQUIRED_PATHS:
        if not (ROOT / rel).exists():
            fail(f"Missing required path: {rel}", errors)


def check_html_files(errors: list[str]) -> None:
    for rel in ["index.html", "demo/rescue-app.html"]:
        path = ROOT / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore").lower()
        if "<!doctype html" not in text:
            fail(f"{rel} is missing a doctype", errors)
        if "</html>" not in text:
            fail(f"{rel} is missing a closing html tag", errors)


def is_external_link(target: str) -> bool:
    lowered = target.lower()
    return (
        lowered.startswith("http://")
        or lowered.startswith("https://")
        or lowered.startswith("mailto:")
        or lowered.startswith("#")
        or lowered.startswith("data:")
    )


def clean_link_target(target: str) -> str:
    target = target.strip()
    target = target.split("#", 1)[0]
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    return unquote(target)


def check_markdown_links(errors: list[str]) -> None:
    for path in ROOT.rglob("*.md"):
        if ".git" in path.parts:
            continue
        rel_parent = path.parent
        text = path.read_text(encoding="utf-8", errors="ignore")
        for match in MARKDOWN_LINK_RE.finditer(text):
            raw_target = match.group(1)
            if is_external_link(raw_target):
                continue
            target = clean_link_target(raw_target)
            if not target:
                continue
            resolved = (rel_parent / target).resolve()
            try:
                resolved.relative_to(ROOT)
            except ValueError:
                fail(f"{path.relative_to(ROOT)} links outside repo: {raw_target}", errors)
                continue
            if not resolved.exists():
                fail(f"{path.relative_to(ROOT)} has a broken link: {raw_target}", errors)


def check_python_syntax(errors: list[str]) -> None:
    for path in ROOT.rglob("*.py"):
        if any(part in {".git", ".venv", "venv", "__pycache__"} for part in path.parts):
            continue
        try:
            ast.parse(path.read_text(encoding="utf-8"))
        except SyntaxError as exc:
            rel = path.relative_to(ROOT)
            fail(f"Python syntax error in {rel}:{exc.lineno}: {exc.msg}", errors)


def main() -> int:
    errors: list[str] = []
    check_required_paths(errors)
    check_html_files(errors)
    check_markdown_links(errors)
    check_python_syntax(errors)

    if errors:
        print("Repository check failed:")
        for error in errors:
            print(f"- {error}")
        return 1

    print("Repository check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
