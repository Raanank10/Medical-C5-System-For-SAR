# C5 Sentinel-SAR

Development repository for an offline-first medical command-and-control prototype for search-and-rescue mass-casualty operations.

[Live demo](https://raanank10.github.io/Medical-C5-System-For-SAR/) | [Development guide](docs/DEVELOPMENT.md) | [Architecture](docs/ARCHITECTURE.md) | [Tactical UI](docs/TACTICAL_UI_GUIDELINES.md) | [Field gaps](docs/FIELD_EXPERIMENT_GAPS.md) | [Production readiness](docs/PRODUCTION_READINESS.md)

![C5 Sentinel-SAR Command Dashboard](assets/mockups/command_dashboard.png)

## Purpose

This repository is the active development home for C5 Sentinel-SAR. The goal is to turn a field-tested product idea into a maintainable prototype that can evolve toward:

- a local-first medic workflow
- a platoon/company command dashboard
- an event-sourced sync model
- analytics and after-action review reporting
- eventually, separate production-grade mobile, web, API, and database layers

The current implementation is intentionally lightweight: a standalone HTML prototype, SQL schema drafts, and a Python analytics package. That keeps iteration fast while the product, data model, and operational workflow are still being validated.

## Current State

| Area | Status | Notes |
| --- | --- | --- |
| Field/command prototype | Active Demo 2.995 (`APP_VERSION 2.99.5`) | `index.html` and `demo/rescue-app.html` (byte-identical) |
| Product specification | Active V2.8 role/command model | `docs/ROLE_COMMAND_MODEL_v2.8.md`, `docs/ALERT_OWNERSHIP_v1.3.md`, `docs/C5_SENTINEL_SAR_MVP_SPEC_v1.2.md` |
| API contract | v1.2, sync endpoints implemented | `docs/API_SURFACE_v1.2.md` — `/sync/log` push/pull is a real deployed Edge Function; Command Actions and most of the AAR API are still unbuilt |
| Data model | Deployed to a live Supabase project, RLS enabled and audited | `database/001_postgresql_schema_v1.2.sql` + incremental fixes `004`-`017`; see `docs/RLS_AUDIT_v1.md` |
| Demo data | Draft seed data | `database/002_seed_demo_data_v1.2.sql` |
| Analytics/AAR | Working local package, with a pytest suite and a real-incident export path | `analytics/c5_sentinel_sar_analytics_v1_1/` |
| Production backend | Deployed | Real Supabase Auth, RLS-enforced Postgres, `/sync/log` Edge Function; see `docs/ARCHITECTURE.md`'s "Backend Deployment Status" |
| Native mobile app | Not implemented | Planned as a PWA in `apps/field-mobile`, see `docs/PHASE_4_PLAN.md` (not started) |

## Quick Start

Clone the repo:

```bash
git clone https://github.com/Raanank10/Medical-C5-System-For-SAR.git
cd Medical-C5-System-For-SAR
```

Open the standalone prototype:

```bash
start index.html
```

Run the repository health check:

```bash
python scripts/check_repo.py
```

Run the domain-rule regression tests:

```bash
node tests/domain-rules.test.js
```

Run the analytics demo:

```bash
cd analytics/c5_sentinel_sar_analytics_v1_1
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python seed_demo_db.py
python -m pytest
python -c "from db import DB; from kpis import KPIEngine; from report import ReportGenerator; db=DB('rescue_demo_v1_1.db'); kpi=KPIEngine(db); ReportGenerator(kpi).save('aar_report_v1_1.html')"
```

Run the real-browser smoke test (optional, requires `npm install` once — the only place in the repo with an npm dependency):

```bash
npm install
npm run test:browser-smoke
```

See `CLAUDE.md` for the full command reference, including what CI actually runs.

## Repository Map

```text
.
|-- index.html                         # standalone prototype entry point
|-- demo/
|   `-- rescue-app.html                # byte-identical demo artifact
|-- docs/
|   |-- ARCHITECTURE.md                # system design, module boundaries, backend deployment status
|   |-- DEVELOPMENT.md                 # local setup and contribution workflow
|   |-- TACTICAL_UI_GUIDELINES.md      # field UI principles and New Patient guardrails
|   |-- PRODUCTION_READINESS.md        # path from prototype to pilot/production readiness
|   |-- OPERATIONS_SAFETY.md           # safety/privacy boundaries
|   |-- ROLE_COMMAND_MODEL_v2.8.md
|   |-- API_SURFACE_v1.2.md
|   |-- C5_SENTINEL_SAR_MVP_SPEC_v1.2.md
|   |-- THREAT_MODEL.md                # Phase 5: threat model
|   |-- AUTH_AND_ROLE_MODEL.md         # Phase 5: identity/session/role layer
|   |-- RLS_AUDIT_v1.md                # Phase 5: full RLS policy audit
|   |-- AUDIT_AND_RETENTION_POLICY.md  # Phase 5: retention classes proposal
|   |-- PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md
|   |-- CLINICAL_GOVERNANCE_REVIEW_FRAMEWORK.md
|   |-- FIELD_USABILITY_TEST_PLAN.md
|   |-- FAILURE_MODE_REVIEW.md
|   |-- PHASE_4_PLAN.md                # plan for splitting into apps/packages/services
|   |-- MULTI_AGENT_DEV_PLAN.md        # how work on this repo is actually planned
|   |-- METRICS_DICTIONARY.md
|   `-- ROADMAP.md
|-- database/
|   |-- 001_postgresql_schema_v1.2.sql # base schema, deployed to a live Supabase project
|   |-- 002_seed_demo_data_v1.2.sql
|   |-- 003_mci_ui_alignment.sql
|   `-- 004_...sql - 017_...sql        # incremental fixes applied against the live project
|-- supabase/
|   `-- functions/sync-log/index.ts   # deployed Edge Function implementing /sync/log
|-- src/
|   `-- domain/rules.js               # testable triage, vitals, alert, and timing rules
|-- tests/
|   `-- domain-rules.test.js
|-- analytics/
|   `-- c5_sentinel_sar_analytics_v1_1/  # DB/KPIEngine/ReportGenerator + pytest suite
|-- assets/
|   `-- mockups/
|-- scripts/
|   |-- check_repo.py
|   |-- browser_smoke_test.js         # Playwright real-browser smoke test
|   `-- smoke_v2_*.js                 # string-assertion smoke checks, one per milestone
`-- archive/
    |-- v0.6/
    `-- v0.7/
```

## Development Direction

`docs/ROADMAP.md` tracks five phases. Phases 1 (dev-surface stabilization), 2 (domain rules extracted), 3 (local-first hardening — real sync/auth/RLS, not simulated), and 5 (operational-readiness research — threat model, RLS audit, encrypted local storage, privacy/audit/governance docs) are done or substantially done. Phase 4 — splitting `index.html` into `apps/field-mobile`, `apps/command-web`, `packages/domain`, `packages/fixtures`, `services/sync-api`, and real `database/migrations` — is planned (`docs/PHASE_4_PLAN.md`) but not started; `index.html` keeps working unmodified until that split reaches feature parity.

See [docs/ROADMAP.md](docs/ROADMAP.md) for the active build plan and [docs/MULTI_AGENT_DEV_PLAN.md](docs/MULTI_AGENT_DEV_PLAN.md) for how work on this repo is actually planned and reviewed.

## Core Concepts

| Concept | Meaning in this repo |
| --- | --- |
| Offline-first | Field users must keep working without reliable connectivity. |
| Event-sourced sync | Devices append operational events; command state is projected from the log. |
| Poison event quarantine | Invalid sync events are preserved for review instead of blocking the whole batch. |
| Command snapshot | Dashboards should read precomputed state, not reconstruct every view from raw history. |
| AAR analytics | The event log becomes incident learning: timelines, metrics, bottlenecks, and gaps. |

## Useful Links

- [Development guide](docs/DEVELOPMENT.md)
- [Architecture, incl. Backend Deployment Status](docs/ARCHITECTURE.md)
- [Tactical UI guidelines](docs/TACTICAL_UI_GUIDELINES.md)
- [Production readiness path](docs/PRODUCTION_READINESS.md)
- [Operations and safety notes](docs/OPERATIONS_SAFETY.md)
- [Role-based medical command model V2.8](docs/ROLE_COMMAND_MODEL_v2.8.md)
- [API surface v1.2](docs/API_SURFACE_v1.2.md)
- [Phase 4 plan: splitting into apps/packages/services](docs/PHASE_4_PLAN.md)
- [Multi-agent development plan](docs/MULTI_AGENT_DEV_PLAN.md)

### Phase 5 operational-readiness docs

- [Threat model](docs/THREAT_MODEL.md)
- [Auth and role model](docs/AUTH_AND_ROLE_MODEL.md)
- [RLS audit v1](docs/RLS_AUDIT_v1.md)
- [Audit and retention policy](docs/AUDIT_AND_RETENTION_POLICY.md)
- [Privacy and data-minimization review](docs/PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md)
- [Clinical governance review framework](docs/CLINICAL_GOVERNANCE_REVIEW_FRAMEWORK.md)
- [Failure-mode review](docs/FAILURE_MODE_REVIEW.md)
- [Field usability test plan](docs/FIELD_USABILITY_TEST_PLAN.md)

### Reference

- [Metrics dictionary](docs/METRICS_DICTIONARY.md)
- [Field experiment gap register](docs/FIELD_EXPERIMENT_GAPS.md)
- [Demo script](docs/PC_DEMO_SCRIPT.md)
- [Latest changelog (v2.995)](docs/CHANGELOG_v2.995.md)

## Safety Status

C5 Sentinel-SAR is a prototype. It is not a certified medical device, is not operationally deployed, and must not be used with real patient-identifiable data without organizational authorization, privacy controls, security review, and clinical governance.

## Maintainer

Raanan Kelner
