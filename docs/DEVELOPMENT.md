# Development Guide

This repository is optimized for fast product and system iteration. Keep the standalone prototype useful while gradually moving logic into testable modules.

## Prerequisites

- Git
- Python 3.10 or newer
- Node.js 18 or newer for JavaScript rule tests
- A modern browser
- Optional: PostgreSQL 15+ for testing the SQL drafts

No package install is currently required because the UI prototype is plain HTML/CSS/JavaScript and the domain tests use Node's built-in assertion library.

## Local Setup

```bash
git clone https://github.com/Raanank10/Medical-C5-System-For-SAR.git
cd Medical-C5-System-For-SAR
python scripts/check_repo.py
node tests/domain-rules.test.js
start index.html
```

## Analytics Setup

```bash
cd analytics/c5_sentinel_sar_analytics_v1_1
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python seed_demo_db.py
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
5. Update docs when behavior, terminology, roles, or metrics change.
6. Keep all demo data synthetic.

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

## Coding Guidelines

- Prefer small, testable modules under `src/` as code moves out of `index.html`.
- Keep operational terminology consistent with the MVP spec.
- Do not introduce production dependencies until there is a clear module boundary.
- Preserve historical versions under `archive/`.
- Avoid real patient, unit, location, or operational identifiers.

## Current Technical Debt

- The UI prototype is still a large single HTML file, although core domain rules now live in `src/domain/rules.js`.
- Demo artifacts are duplicated between `index.html` and `demo/rescue-app.html`.
- There is no automated browser regression test yet.
- SQL migrations are draft files rather than an executable migration chain.
- Analytics has no formal pytest suite yet.

These are acceptable for the current stage, but new work should reduce this debt where practical.
