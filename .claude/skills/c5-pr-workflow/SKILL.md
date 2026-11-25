---
name: c5-pr-workflow
description: Ship a change to C5 Sentinel-SAR as a PR - branch name, APP_VERSION and label bump, which checks and browser tests to run, docs to update in the same change, and the PR body. Use for any code, UI, rules or docs change in this repo, and before opening or updating any PR.
---

# Shipping a change in C5 Sentinel-SAR

The owner's rules in `CLAUDE.md` ("Owner rules") apply throughout: find before delete, no RPC or schema change without approval, drill data treated as real, verify by running.

Sources this skill is built from: `CLAUDE.md`, `docs/DEVELOPMENT.md` (Development Workflow, Change Checklist), `docs/GAP_CLOSURE_PLAN.md` (Rules for every WP, Numbering in this round), `docs/MULTI_AGENT_DEV_PLAN.md`, `.github/pull_request_template.md`. If one of them disagrees with this file, the source wins; say so and fix this file in the same PR.

## 1. Before writing code

1. Pull `main` fresh. Line numbers in docs and plans drift; re-check every line a plan or issue cites against the current code and tell the owner what moved.
2. If the change touches triage, vitals, alerts, handover, roles or command logic, read the matching doc first (`docs/TACTICAL_UI_GUIDELINES.md`, `docs/ROLE_COMMAND_MODEL_v2.8.md`, `docs/C5_SENTINEL_SAR_MVP_SPEC_v1.2.md`, `docs/API_SURFACE_v1.2.md`). Docs are the spec.
3. If a decision is ambiguous or architecturally significant, or a WP lists an open owner decision, ask before implementing.
4. If the change needs anything on the database or `sync-log`, stop and use the `c5-db-change` skill for that part.

## 2. Branch

`feature/...`, `fix/...`, `docs/...` or `analytics/...`, short and descriptive. One WP or one concern per PR.

## 3. Implementing

- `index.html` is the only prototype file. UI copy is Hebrew and uses existing terminology (for example נאפ״ל for the evacuation point).
- Product rules go into `src/domain/rules.js` plus `tests/domain-rules.test.js`, not new inline logic. The inlined copy in `index.html` must stay identical; `check_repo.py` checks the drift.
- A new event type is added in four places at once: the `event_type` enum (migration, via `c5-db-change`), `ROLE_ALLOWED_EVENT_TYPES` in `supabase/functions/sync-log/index.ts`, `SYNC_ELIGIBLE_EVENT_TYPES` in `index.html`, and `src/domain/event-contract.json`. A type that finishes a WP leaves `known_gaps`.
- Never hide stale-data, sync-failure or missing-vitals states, and never remove audit history.
- No new production dependencies. Synthetic data only in anything committed.

## 4. Version

Take the next free `APP_VERSION` from `main` right before merging, not when starting (parallel sessions have collided: #110, #119, #120, #125-#127). Bump `const APP_VERSION` and the three visible labels together ("Demo V2.99NN", "ROLE // V2.99NN", "Role-Based Medical Command System V2.99NN"). One version per merged PR.

## 5. Checks (run them; report real output)

Always:

```bash
python scripts/check_repo.py
node tests/domain-rules.test.js
node tests/debt-labels.test.js
npm run test:browser-smoke
```

Then the feature tests that cover what you changed: pick them from `browser-tests.md` in this folder (one line per test, what it covers). Add or extend a browser test when no existing one exercises the change; a change without an executed DOM-level test is not verified. Before handing over, run the whole suite once with `npm test` (about 4 minutes, what CI runs).

Only when analytics code changed: `python -m pytest` in `analytics/c5_sentinel_sar_analytics_v1_1/` (not in CI).

If a check fails, fix it or report it plainly. Do not weaken a test to make it pass.

## 6. Docs in the same PR

Update whatever the change makes wrong: `docs/ARCHITECTURE.md` "Backend Deployment Status", `docs/FIELD_EXPERIMENT_GAPS.md`, `docs/API_SURFACE_v1.2.md`, `docs/TACTICAL_UI_GUIDELINES.md`, the WP's status row in `docs/GAP_CLOSURE_PLAN.md`, and `CLAUDE.md` or `browser-tests.md` when commands or tests change. New core docs go into `REQUIRED_PATHS` in `scripts/check_repo.py`. Relative markdown links must resolve (`check_repo.py` fails on broken ones).

## 7. The PR

Fill `.github/pull_request_template.md`: Summary, Operational Workflow Affected, Validation (tick only what you actually ran), Safety Review. Also state: the version taken, the tests run and their result, anything verified live versus only in stubbed tests, and any owner decision still open.

Stop there. Clinical, sync-conflict and RLS changes are never auto-merged; the owner verifies them live and merges.
