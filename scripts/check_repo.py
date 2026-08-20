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
        if ".git" in path.parts or "node_modules" in path.parts:
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


DOMAIN_RULES_FACTORY_MARKER = "function buildDomainRules() {"


def extract_domain_rules_factory_body(text: str, rel: str, errors: list[str]) -> str | None:
    """Pull the body of buildDomainRules() out of a file's text.

    Both src/domain/rules.js and the copy inlined into index.html /
    demo/rescue-app.html define the exact same factory function; this is how
    the app avoids a build step while still having one tested module. If the
    inlined copy and the standalone file ever diverge (as happened once
    already, silently, with the SABCDE airway branch) the app's real
    behavior stops matching what the tests verify.
    """
    marker_count = text.count(DOMAIN_RULES_FACTORY_MARKER)
    if marker_count != 1:
        fail(
            f"{rel}: expected exactly one '{DOMAIN_RULES_FACTORY_MARKER}', found {marker_count} "
            "(domain-rules sync check assumptions no longer hold, update check_repo.py)",
            errors,
        )
        return None
    body_start = text.find(DOMAIN_RULES_FACTORY_MARKER) + len(DOMAIN_RULES_FACTORY_MARKER)
    body_end = text.find("\n});", body_start)
    if body_end == -1 or body_end - body_start < 1000:
        fail(f"{rel}: could not locate a plausible buildDomainRules() body for the sync check", errors)
        return None
    return text[body_start:body_end]


def normalize_js_body(snippet: str) -> str:
    # Whitespace and trailing commas (e.g. `{a, b,}` vs `{a, b}`) are harmless
    # JS formatting choices with no behavioral effect - normalize both away so
    # this check only fires on actual logic drift, not reformatting.
    text = re.sub(r"\s+", "", snippet)
    text = re.sub(r",(?=[}\]])", "", text)
    return text


def check_domain_rules_sync(errors: list[str]) -> None:
    rules_path = ROOT / "src/domain/rules.js"
    if not rules_path.exists():
        return
    canonical_body = extract_domain_rules_factory_body(
        rules_path.read_text(encoding="utf-8", errors="ignore"), "src/domain/rules.js", errors
    )
    if canonical_body is None:
        return
    canonical_norm = normalize_js_body(canonical_body)

    for rel in ["index.html", "demo/rescue-app.html"]:
        path = ROOT / rel
        if not path.exists():
            continue
        inlined_body = extract_domain_rules_factory_body(
            path.read_text(encoding="utf-8", errors="ignore"), rel, errors
        )
        if inlined_body is None:
            continue
        if normalize_js_body(inlined_body) != canonical_norm:
            fail(
                f"{rel}: the domain-rules module inlined in this file has drifted from "
                "src/domain/rules.js (the buildDomainRules() body differs). The inlined copy is "
                "what actually runs in the app; src/domain/rules.js is what the tests cover. Keep "
                "them identical (aside from the browser/CommonJS export wrapper) or the two will "
                "silently disagree about triage/vitals/dosing behavior.",
                errors,
            )


SQL_TOKEN_RE = re.compile(
    r"--[^\n]*"          # line comment
    r"|/\*.*?\*/"        # block comment
    r"|\$\$"             # dollar-quote delimiter (this repo only uses untagged $$)
    r"|'(?:[^']|'')*'"   # single-quoted string, '' is an escaped quote
    r"|[()]",            # a paren
    re.DOTALL,
)


def check_sql_structure(errors: list[str]) -> None:
    """Lightweight structural sanity checks for the SQL drafts under database/.

    This is not a real SQL parser - it can't be, with stdlib only - so it only
    checks two cheap, high-value invariants that are easy to get wrong when
    hand-editing a 2,500-line file: parens balance, and every quoted string /
    dollar-quoted block is actually closed by EOF. It skips comments and
    string contents so a stray '(' inside a comment or literal doesn't trip
    it. Full syntax/semantic validation still requires a real Postgres
    instance - see docs/DEVELOPMENT.md's "Validating SQL Drafts" section.
    """
    sql_dir = ROOT / "database"
    if not sql_dir.exists():
        return

    known_tables: set[str] = set()
    file_texts: dict[Path, str] = {}
    for path in sorted(sql_dir.glob("*.sql")):
        text = path.read_text(encoding="utf-8", errors="ignore")
        file_texts[path] = text
        known_tables.update(m.lower() for m in re.findall(
            r"create\s+table\s+(?:if\s+not\s+exists\s+)?\"?([a-zA-Z_][a-zA-Z0-9_]*)\"?", text, re.IGNORECASE
        ))

    for path, text in file_texts.items():
        rel = path.relative_to(ROOT)
        depth = 0
        in_dollar_quote = False
        for match in SQL_TOKEN_RE.finditer(text):
            tok = match.group(0)
            if tok == "$$":
                in_dollar_quote = not in_dollar_quote
            elif in_dollar_quote:
                continue
            elif tok == "(":
                depth += 1
            elif tok == ")":
                depth -= 1
                if depth < 0:
                    fail(f"{rel}: unbalanced ')' at offset {match.start()} (no matching '(')", errors)
                    depth = 0
        if depth != 0:
            fail(f"{rel}: {depth} unclosed '(' by end of file", errors)
        if in_dollar_quote:
            fail(f"{rel}: unterminated $$ dollar-quoted block by end of file", errors)

        for m in re.finditer(r"\breferences\s+\"?([a-zA-Z_][a-zA-Z0-9_]*)\"?\s*\(", text, re.IGNORECASE):
            target = m.group(1).lower()
            if target not in known_tables:
                fail(
                    f"{rel}: 'references {m.group(1)}(...)' targets a table not defined by any "
                    "'create table' in database/*.sql (typo, or the table was renamed/dropped "
                    "without updating this reference)",
                    errors,
                )


def check_python_syntax(errors: list[str]) -> None:
    for path in ROOT.rglob("*.py"):
        if any(part in {".git", ".venv", "venv", "__pycache__", "node_modules"} for part in path.parts):
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
    check_domain_rules_sync(errors)
    check_sql_structure(errors)
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
