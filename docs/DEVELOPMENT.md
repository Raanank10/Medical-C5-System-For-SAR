# Development Guide

This repository is optimized for fast product and system iteration. Keep the standalone prototype useful while gradually moving logic into testable modules.

## Prerequisites

- Git
- Python 3.10 or newer
- Node.js 18 or newer for JavaScript rule tests
- A modern browser
- Optional: PostgreSQL 15+ for testing the SQL drafts

No package install is required to open or use the UI prototype — it's plain HTML/CSS/JavaScript, and the domain tests use Node's built-in assertion library. The one exception is the root `package.json`, which exists solely to run an optional real-browser smoke test via Playwright (see "Browser Smoke Test" below); it's dev-only and manual.

## Local Setup

```bash
git clone https://github.com/Raanank10/Medical-C5-System-For-SAR.git
cd Medical-C5-System-For-SAR
python scripts/check_repo.py
node tests/domain-rules.test.js
start index.html
```

## Browser Smoke Test

`scripts/browser_smoke_test.js` loads `index.html` and `demo/rescue-app.html` in headless Chromium via Playwright and checks the app actually renders and initializes (no uncaught page errors, `window.C5DomainRules` loads with its expected functions, `APP_VERSION` is set, exactly one `.screen.active` element and it's `screen-login` on a fresh load). This is a deeper check than the string-assertion `scripts/smoke_*.js` scripts, which only grep the HTML text. Manual-only, not wired into CI, and the only place in the repo with an npm dependency:

```bash
npm install
npm run test:browser-smoke            # or: node scripts/browser_smoke_test.js
```

## Validating SQL Drafts

`database/*.sql` are draft files, not an executable migration chain (see "Current Technical Debt" below), so there's no automated migration runner to check them against. Two layers of validation exist:

1. **`python scripts/check_repo.py` (stdlib only, runs in CI on every PR)** — cheap structural checks, not a real parser:
   - every `(` is matched by a `)` and every `$$` dollar-quoted block is closed by end of file (skipping `--`/`/* */` comments and `'...'` string contents, so a stray paren in a comment or literal doesn't trip it)
   - every `references some_table(...)` foreign key target is an actual `create table` name somewhere under `database/*.sql` (catches typos and stale references after a rename)

   These catch the most common hand-editing mistakes (an unclosed paren in a 2,500-line file, a renamed table with a dangling reference) but say nothing about real SQL syntax, types, or semantics.

2. **A real PostgreSQL instance** — the only way to fully validate a draft. Locally:

   ```bash
   createdb c5_sentinel_sar_check
   psql -d c5_sentinel_sar_check -v ON_ERROR_STOP=1 -f database/001_postgresql_schema_v1.2.sql
   psql -d c5_sentinel_sar_check -v ON_ERROR_STOP=1 -f database/002_seed_demo_data_v1.2.sql
   psql -d c5_sentinel_sar_check -v ON_ERROR_STOP=1 -f database/003_mci_ui_alignment.sql
   # then each numbered file after it, in order, e.g. 004_..., 005_..., up to the latest
   dropdb c5_sentinel_sar_check
   ```

   `-v ON_ERROR_STOP=1` makes `psql` exit non-zero on the first error instead of continuing past it. This project's live Supabase instance is the actual source of truth for whether a given file applies cleanly — when in doubt, that's what changes get validated against before merging.

## Analytics Setup

```bash
cd analytics/c5_sentinel_sar_analytics_v1_1
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python seed_demo_db.py
```

Run the analytics test suite (`db.py`/`kpis.py`/`charts.py`/`report.py`):

```bash
python -m pytest
```

Generate the sample AAR report:

```bash
python -c "from db import DB; from kpis import KPIEngine; from report import ReportGenerator; db=DB('rescue_demo_v1_1.db'); kpi=KPIEngine(db); ReportGenerator(kpi).save('aar_report_v1_1.html')"
```

## Development Workflow

1. Open or create an issue for the change.
2. Keep product, schema, API, analytics, and demo changes aligned.
3. Run `python scripts/check_repo.py` before opening a pull request.
4. Run `node tests/domain-rules.test.js` when triage, vitals, alert, sync, or timing rules change.
5. Run `python -m pytest` in `analytics/c5_sentinel_sar_analytics_v1_1/` when `db.py`, `kpis.py`, `charts.py`, or `report.py` change.
6. Run `npm run test:browser-smoke` when UI initialization, `src/domain/rules.js`, or the app's startup/login flow changes.
7. Update docs when behavior, terminology, roles, or metrics change.
8. Keep all demo data synthetic.

## Branch Naming

Use short, descriptive branch names:

- `feature/quick-patient-mode`
- `fix/vitals-reassessment-alert`
- `docs/sync-architecture`
- `analytics/stockout-risk`

## Change Checklist

Use this checklist for every meaningful change:

- The prototype still opens from `index.html`.
- Development docs still match the repo layout.
- Any API or schema change is reflected in both docs and SQL.
- Analytics changes include a generated or described AAR output.
- Safety/privacy assumptions did not become weaker.
- `python scripts/check_repo.py` passes.
- `node tests/domain-rules.test.js` passes if domain rules changed.
- `python -m pytest` (from `analytics/c5_sentinel_sar_analytics_v1_1/`) passes if analytics code changed.
- `npm run test:browser-smoke` passes if UI initialization or domain-rules loading changed.

## Coding Guidelines

- Prefer small, testable modules under `src/` as code moves out of `index.html`.
- Keep operational terminology consistent with the MVP spec.
- Do not introduce production dependencies until there is a clear module boundary. The root `package.json`'s Playwright dev dependency is a deliberate, scoped exception for the manual browser smoke test only — see `CLAUDE.md`.
- Preserve historical versions under `archive/`.
- Avoid real patient, unit, location, or operational identifiers.

## Current Technical Debt

- The UI prototype is still a large single HTML file, although core domain rules now live in `src/domain/rules.js`.
- Demo artifacts are duplicated between `index.html` and `demo/rescue-app.html`.
- SQL migrations are draft files rather than an executable migration chain.

These are acceptable for the current stage, but new work should reduce this debt where practical.
