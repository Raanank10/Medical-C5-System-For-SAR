# Contributing

This is an active development prototype. Contributions should make the system easier to build, validate, and reason about.

## Before You Start

Read:

- `README.md`
- `docs/DEVELOPMENT.md`
- `docs/ARCHITECTURE.md`
- `docs/TACTICAL_UI_GUIDELINES.md`
- `docs/PRODUCTION_READINESS.md`
- `docs/OPERATIONS_SAFETY.md`

## Pull Request Expectations

- Keep changes focused.
- Explain the operational workflow affected by the change.
- Update docs alongside behavior, schema, API, or metric changes.
- Use synthetic data only.
- Run `python scripts/check_repo.py`.

## Good First Areas

- Extract repeated JavaScript logic from `index.html`.
- Add browser smoke tests for the standalone prototype.
- Add pytest coverage for analytics KPIs.
- Add SQL validation examples.
- Improve synthetic fixtures and demo scenarios.
- Add screenshots or GIFs for current workflows.

## Review Standards

Changes that affect medical logic, alerting, sync, or audit history need careful review even when they look small.

Prefer explicit, boring, well-documented behavior over clever abstractions.
