# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

C5 Sentinel-SAR is a development prototype for an offline-first medical command-and-control system for search-and-rescue mass-casualty incidents (MCI). It is **not** a certified medical device and must never be used with real patient-identifiable data — all data in this repo must stay synthetic (see "Safety and data policy" below).

The field/command UI is still a single-file HTML/JS prototype and there is no mobile app yet, but the backend is no longer a draft: the PostgreSQL schema is deployed to a real Supabase project with RLS enforced and audited, real Supabase Auth, and a real `/sync/log` Edge Function that `index.html` pushes to and pulls from. See `docs/ARCHITECTURE.md`'s "Backend Deployment Status" for the full detail and `docs/PHASE_4_PLAN.md` for the plan to split the repo into `apps/`, `packages/`, `services/` (not started yet — `index.html` must keep working unmodified until that split reaches parity).

## Commands

The prototype itself has no build step — plain HTML/CSS/JS loaded directly in a browser — and its core tests use each language's standard library only. The one exception is a root `package.json` that exists solely to run a real-browser smoke test via Playwright (see below); it is dev-only, manual, and not required to open or use the prototype.

```bash
# Open the prototype (no build step)
start index.html                      # or just open the file in a browser

# Repository health check (required before any PR) — stdlib only, no deps
python scripts/check_repo.py

# Domain rule unit tests (required when triage/vitals/alert/timing rules change)
node tests/domain-rules.test.js

# Manual smoke tests against the built HTML (string-assertion checks, run individually as needed)
node scripts/smoke_v2_991_medic_cc.js
node scripts/smoke_v2_992_decision_support.js
# ...other scripts/smoke_*.js files follow the same pattern, one per feature milestone

# Real-browser smoke test (Playwright, headless Chromium) — loads index.html and
# demo/rescue-app.html and checks they actually render, not just that the HTML text
# contains expected strings. Manual-only, not wired into CI, requires `npm install` once.
npm install
npm run test:browser-smoke            # or: node scripts/browser_smoke_test.js

# Analytics package
cd analytics/c5_sentinel_sar_analytics_v1_1
python -m venv .venv
.venv\Scripts\activate            # Windows; use `source .venv/bin/activate` on macOS/Linux
pip install -r requirements.txt
python seed_demo_db.py
python -m pytest                  # pytest suite for db.py/kpis.py/charts.py/report.py — seeds its own temp DBs, doesn't touch rescue_demo_v1_1.db
python -c "from db import DB; from kpis import KPIEngine; from report import ReportGenerator; db=DB('rescue_demo_v1_1.db'); kpi=KPIEngine(db); ReportGenerator(kpi).save('aar_report_v1_1.html')"
```

CI (`.github/workflows/validate.yml`) runs exactly two things on every PR and push to `main`: `python scripts/check_repo.py` and `node tests/domain-rules.test.js`. The smoke scripts under `scripts/smoke_*.js`, `scripts/browser_smoke_test.js` (Playwright), and the analytics package's `pytest` suite are not wired into CI — they're run manually (string-assertion smoke scripts and the Playwright smoke test against `index.html` / `demo/rescue-app.html`; pytest requires the analytics venv/dependencies CI doesn't install).

`scripts/check_repo.py` enforces (stdlib only, no deps):
- a fixed list of required paths exist (`REQUIRED_PATHS` in the script — update it when adding/renaming core docs, schema files, or archive folders)
- `index.html` and `demo/rescue-app.html` have a doctype and closing `</html>`
- every relative markdown link across the repo resolves to a real file (no broken/external-repo links)
- the domain-rules module inlined in `index.html`/`demo/rescue-app.html` hasn't drifted from `src/domain/rules.js`
- `database/*.sql` structural sanity: balanced parens/`$$` dollar-quoted blocks, and every `references table(...)` target resolves to a real `create table` — see docs/DEVELOPMENT.md's "Validating SQL Drafts" for what this does and doesn't catch (it's not a real SQL parser; a Postgres instance is still the only full validation)
- every `*.py` file parses without a syntax error

## Architecture

### The prototype is one HTML file, duplicated

`index.html` and `demo/rescue-app.html` are **byte-identical** (verify with `diff` before assuming otherwise). Both are ~8,600 lines of self-contained HTML/CSS/JS — no bundler, no framework, no `<script src>` to other JS files except `src/domain/rules.js`-equivalent logic that is inlined directly into the HTML (the standalone `src/domain/rules.js` module is a separately extracted, testable copy of a subset of that logic — see below). When you change prototype behavior, **you almost always need to edit both `index.html` and `demo/rescue-app.html` identically** unless a doc explicitly says they should diverge (currently they should not).

Inside the HTML, look for:
- `const APP_VERSION = '2.99.5';` — bump this and the visible "Demo X.Y" / "ROLE // X.Y" label strings together when shipping a version; smoke scripts assert on these exact strings.
- `const ROLE_LABELS` / `const ROLE_DEFS` — defines the role-based views. Eight roles exist in the live `user_role` enum: `medic`, `pc` (חוג"ד — platoon commander), `cc` (מ״פ רפואה — company/command medical), `logistics`, `chamal` (command system), `rpc`/`rcc` (rescue-chain platoon/company commander — site-authority actions per `docs/ROLE_COMMAND_MODEL_v2.8.md`, added in `database/006`/`007`), and `admin`.
- `render*` functions (e.g. `renderDashboard`, `renderCommander`, `renderMstartSweep`, `renderAar`, `renderCcHeroDashboard`, `renderLogisticsOfficer`) — each is a self-contained view renderer for one role/screen. Grep for `^function render` to find the current screen inventory before adding a new one.
- A legacy step-based New Patient flow (`screen-step1`..`screen-step8`, guarded by a `LEGACY_FULL_ASSESSMENT_DO_NOT_DELETE_WITHOUT_TESTS` comment) coexists with the newer Quick/Extended patient flows — don't delete it without checking what still depends on it (smoke scripts assert on its presence).

### Extracted domain rules (`src/domain/rules.js`)

This is the one piece of logic that has been pulled out of the HTML prototype into a standalone, testable module. It's written as a UMD-style wrapper (`module.exports` under Node, `window.C5DomainRules` in the browser) specifically so the same file can be `require()`d by `tests/domain-rules.test.js` **and** loaded unmodified by the HTML prototype with no build step.

It owns:
- vitals reassessment timing (`vitalsTimer`, interval varies by triage color — red 10m / yellow 20m / green 30m — 1-minute warning buffer before each)
- tourniquet timing (`tourniquetTimer`, 45-minute heads-up notice / 60-minute warning / 120-minute critical)
- device-silence detection (`isDeviceSilent`, 10-minute threshold, one shared constant across the medic load board, command-view device panel, and Dead Man's Switch watchdog row)
- MSTART triage computation (`computeMstartTriage`, `suggestMstartTriage`) — the auto-triage suggestion logic from vitals/SABCDE
- pediatric detection and high-risk medication dose guardrails (`isPediatricPatient`, `isHighRiskDose` — age cutoff 8, dose limits currently hardcoded for morphine/fentanyl)
- deterioration detection (`detectDeterioration`) and alert classification (`isRoutineAlert`/`isCriticalAlert`)
- inventory burn-rate / stock-out risk (`supplyBurnRatePer10Min`, `minutesToStockout`, `supplyBurnAlertLevel`, `supplyCriticalThreshold`/`supplyRiskTier`) — burn rate is items consumed per 10 minutes from real `SUPPLY_CONSUMED` events, matching `docs/C5_SENTINEL_SAR_MVP_SPEC_v1.2.md` §10.3's KPI definitions

When product rules like these change, prefer extending `src/domain/rules.js` and its test file over adding more inline logic to the HTML — this is the stated direction in `docs/ROADMAP.md` (Phase 2: "Extract Product Rules").

### Event-sourced data model — deployed to a real Supabase project

The architecture (`docs/ARCHITECTURE.md`) is an append-only event log: field devices (medic/logistics/commander) write local events first, sync them to a Postgres `events` table, and command views read *projected* state (`incident_command_state`) rather than replaying raw history. This is now real, not aspirational: `database/001_postgresql_schema_v1.2.sql` is deployed to a live Supabase project (`c5-sentinel-sar`), RLS is enabled and audited (`docs/RLS_AUDIT_v1.md` — 86 policies across 32 tables), and `index.html` does real login, real sync push/pull, and real pull-side state projection against it. Two events worth knowing because they're referenced across docs, schema, and UI guidelines:
- `PATIENT_HANDED_OVER` — MIST handover, idempotent by `device_id + local_event_id`, clears `needs_full_assessment` and resolves patient watchdog alerts.
- `PATIENT_TRIAGED_EXPECTANT` — black/expectant triage fast-exit; bypasses remaining forms, sets `current_triage='black'`, `current_status='deceased'`.

Invalid/dependency-blocked sync events go to `sync_ingestion_errors` / `sync_event_dependencies` rather than blocking the whole batch ("poison event quarantine") — don't design new sync logic that fails a whole batch on one bad event. Both are now readable in-app: a command-only "אירועים חסומים / סיכון גבוה" review panel reads unresolved `sync_ingestion_errors` and `high_risk_flags` from each sync push response.

`/sync/log` (`docs/API_SURFACE_v1.2.md`) is implemented as a Supabase Edge Function, `supabase/functions/sync-log/index.ts` — not a literal HTTP path, deployed as `https://btvvjmuwdzirjyauyijx.supabase.co/functions/v1/sync-log` (POST = push, GET = pull). The Command Dashboard read side has one real slice, `get_incident_command_state()`, a `SECURITY DEFINER` RPC (`database/014_command_dashboard_state_rpc.sql`) rather than a literal `GET /command/...` endpoint. Command Actions and most of the AAR API (`docs/API_SURFACE_v1.2.md` sections 5-7) are still unbuilt. See `docs/ARCHITECTURE.md`'s "Backend Deployment Status" for the full account, including real gaps found only by deploying and testing against live accounts (RLS bypassed by views until fixed, missing `SECURITY DEFINER` on trigger functions, no `profiles` row auto-created on signup, an invite-link flow that silently logged people in without ever setting a password).

`database/001_postgresql_schema_v1.2.sql` is the base schema (`create table if not exists`, no migration framework yet — Phase 4 plans to convert to real Supabase CLI migrations, see `docs/PHASE_4_PLAN.md` 4C). `002_seed_demo_data_v1.2.sql` is matching synthetic seed data, `003_mci_ui_alignment.sql` a small delta on top, and `004` through `017` are the incremental fixes applied directly against the live project during deployment/RLS-audit work (RLS gaps, `rpc`/`rcc` roles and their site-authority RLS, auto-create-profile-on-signup, new rescue-chain event types, the command-dashboard RPC, incident-scoping the sync-error read policy, locking out inactive profiles, etc. — each file's name says what it fixes). Older `_v1.1` files and `archive/v0.6`, `archive/v0.7` are kept for history — don't edit them; add a new numbered file instead.

### Analytics package (`analytics/c5_sentinel_sar_analytics_v1_1/`)

A standalone local Python package (`DB`, `KPIEngine`, `ReportGenerator`) that reads a SQLite DB and produces AAR (after-action review) HTML reports and KPIs (triage funnel, vitals/tourniquet timers, inventory burn, stale-data/sync-gap metrics), with a pytest suite (`tests/`) covering all four modules. It mirrors concepts from the Postgres schema in its own SQLite schema (`seed_demo_db.SCHEMA`) rather than sharing one, and normally runs against `rescue_demo_v1_1.db`, seeded via `seed_demo_db.py`. `export_live_incident.py` (stdlib-only, no new dependency) can also export a real incident from the live Supabase database into a SQLite file shaped like that same schema, so the same `DB`/`KPIEngine`/`ReportGenerator` code runs against real event data unmodified — see its module docstring for the per-table mapping and the deliberately-skipped `incident_command_state` table (schema mismatch; `KPIEngine.command_summary()` already falls back to computing it from real exported data).

### Docs are the spec — read before changing behavior

This repo's actual product/API/data contracts live in `docs/`, not in code comments, and several are versioned (e.g. `ROLE_COMMAND_MODEL_v2.8.md`, `API_SURFACE_v1.2.md`, `C5_SENTINEL_SAR_MVP_SPEC_v1.2.md`). Before changing triage, vitals, alerting, handover, or role/command logic, check the matching doc — `docs/TACTICAL_UI_GUIDELINES.md` in particular encodes hard product rules (e.g. "pending must never share the green/minor visual treatment", Quick Patient must set `needs_full_assessment=true`, tourniquet timer must stay visible everywhere) that the UI is expected to enforce. Update the doc in the same change if behavior, terminology, roles, or metrics shift (required by `docs/DEVELOPMENT.md`'s change checklist).

### Roadmap status and how work on this repo actually gets planned

`docs/ROADMAP.md` tracks five phases with `[x]`/`[~]`/`[ ]` markers. As of the last update, Phases 1 (dev-surface stabilization), 2 (domain rules extracted), 3 (local-first hardening — real sync/auth/RLS/device-presence, not simulated), and 5 (operational-readiness research: threat model, auth/role model, RLS audit, encrypted local storage, privacy review, audit/retention policy, failure-mode review, clinical-governance framework, field-usability plan) are done or substantially done. Phase 4 — splitting the single-file prototype into `apps/field-mobile` (PWA, not Expo — no-cost iOS distribution was the deciding constraint), `apps/command-web` (React), `packages/domain`, `packages/fixtures`, `services/sync-api`, and real `database/migrations` — is planned but not started; read `docs/PHASE_4_PLAN.md` in full before touching it, it records six architectural decisions already made with the user so a fresh session doesn't re-litigate them.

`docs/MULTI_AGENT_DEV_PLAN.md` documents the actual working pattern for this repo: one human owner, Claude Code sessions doing bounded work (research → present findings → ask before ambiguous/architecturally-significant decisions → implement → verify live against real accounts/data → ship in small focused PRs → wait for explicit merge approval), not autonomous agents. Medical-logic changes (`src/domain/rules.js`) and RLS changes are explicitly called out as never auto-merged and always human-verified against real accounts.

## Safety and data policy

- All data committed to this repo (fixtures, seeds, screenshots, examples) must be synthetic — no real names, IDs, phone numbers, operational locations, unit rosters, or medical records (`docs/OPERATIONS_SAFETY.md`).
- Changes to triage color assignment, pediatric triage logic, tourniquet timing, vitals reassessment intervals, handover status, patient status transitions, inventory criticality thresholds, device-silence thresholds, sync conflict resolution, or audit/event retention need extra-careful review even when small.
- Never remove audit history or hide stale-data/sync-failure/missing-vitals states to make a workflow look cleaner.
- Clinically-relevant `localStorage` is now encrypted at rest: a device PIN (never persisted) derives an AES-256-GCM key via PBKDF2, gated by `screen-pin-gate` ahead of login on every fresh load. The Supabase session token itself is a deliberately deferred follow-up — see `docs/THREAT_MODEL.md` T2.
- `docs/OPERATIONS_SAFETY.md`'s Phase 5 security/privacy checklist is now mostly checked off against real docs (threat model, auth/role model, RLS audit, encrypted local storage, audit/retention policy, privacy/data-minimization review) — only a backup/incident-response plan and full clinical/legal governance sign-off remain open. Read the relevant doc before assuming a gap still exists.

## Conventions

- Branch names: `feature/...`, `fix/...`, `docs/...`, `analytics/...` (short, descriptive).
- UI strings are in Hebrew (RTL); the app is field-tested in Hebrew, so keep new UI copy consistent with existing terminology rather than introducing English strings.
- No new production dependencies until there's a clear module boundary (per `docs/DEVELOPMENT.md`); the prototype and its core tests are meant to run with nothing beyond Python stdlib, Node stdlib (`node:assert/strict`), and a browser. The one deliberate, scoped exception is the root `package.json`'s Playwright dev dependency, used only by `scripts/browser_smoke_test.js` — it's manual-only, not wired into CI, and not required to open or use the prototype.
- Preserve historical versions under `archive/` rather than deleting superseded docs/schema.
