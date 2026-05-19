**[Live Interactive Demo ->](https://raanank10.github.io/Medical-C5-System-For-SAR/)**

![C5 Sentinel-SAR Command Dashboard](./assets/mockups/command_dashboard.png)

# C5 Sentinel-SAR

Mission-critical Medical Command and Control for Search and Rescue mass-casualty operations.

C5 Sentinel-SAR is an offline-first prototype for medical SAR teams operating in rubble, missile-impact, and mass-casualty scenarios. It turns field actions into structured operational data so medics, platoon commanders, logistics officers, company command, and Chamal can answer the questions that usually disappear into radio traffic:

- How many casualties are active right now?
- Where are the red patients?
- Who has not had vitals reassessed on time?
- Which tourniquets need review?
- Which medics have gone silent?
- What supplies are being consumed faster than expected?
- What happened, in what order, for the After-Action Report?

The project is intentionally built along two tracks:

1. **Portfolio / analyst case study** - demonstrates product thinking, event modeling, KPI design, analytics, operational dashboards, and decision support.
2. **MVP field demo** - a practical Hebrew RTL prototype that can be shown to a Platoon Commander as a realistic command-and-control workflow.

## Skills & Technologies Demonstrated

| Layer | Technology / Concept |
|---|---|
| Data Modeling | Event-sourced PostgreSQL schema, append-only inventory ledger |
| Analytics | Python KPI engine, Golden Hour compliance, burn rate forecasting |
| API Design | Sync-log-first REST, offline-first conflict resolution |
| Database | PostgreSQL, PLpgSQL triggers, materialized views, RLS policies |
| Product | Role-based access design, MSTART/JumpSTART triage algorithm |
| Frontend | Hebrew RTL interface, offline-capable PWA prototype |
| Domain | IDF SAR operations, mass-casualty triage, field medical logistics |

## Current Demo

Use the **[Live Demo](https://raanank10.github.io/Medical-C5-System-For-SAR/)** for the fastest walkthrough.

You can also open [`index.html`](index.html) locally after cloning the repo.

The same demo is also available at [`demo/rescue-app.html`](demo/rescue-app.html).

The prototype includes:

- incident/site setup
- rapid patient intake
- location and access status
- tourniquet capture
- stepper-based vitals matching the mockups
- MSTART-style triage support
- treatment and patient status capture
- reassessment alerts
- deterioration detection
- commander view across active sites
- external report capture

## Product Architecture

The v1.1 design is local-first and event-sourced.

- Mobile writes first to local SQLite.
- Operational screens read local SQLite, not remote REST state.
- Sync is log-first through `POST /sync/log` and `GET /sync/log`.
- Valid events in a batch are accepted even if another event is malformed.
- Poison events are quarantined in `sync_ingestion_errors`.
- Clinical history is preserved; risky documentation is flagged and escalated rather than silently blocked.
- Command dashboards read precomputed command state rather than repeatedly joining raw clinical events.
- `pc` is the schema/auth role for Platoon Commander, which is the field Supervisor role in the product language.
- Draft incidents use `incidents.status = 'draft'` as the only source of truth; there is no separate `is_draft` flag.

Core technical docs:

- [`docs/C5_SENTINEL_SAR_MVP_SPEC_v1.1.md`](docs/C5_SENTINEL_SAR_MVP_SPEC_v1.1.md)
- [`docs/API_SURFACE_v1.1.md`](docs/API_SURFACE_v1.1.md)
- [`database/001_postgresql_schema_v1.1.sql`](database/001_postgresql_schema_v1.1.sql)
- [`database/002_seed_demo_data_v1.1.sql`](database/002_seed_demo_data_v1.1.sql)
- [`database/003_mci_ui_alignment.sql`](database/003_mci_ui_alignment.sql)

## Analytics And AAR

The analytics package is a standalone Python layer showing how the event log becomes command insight and after-action learning.

Location: [`analytics/c5_sentinel_sar_analytics_v1_1`](analytics/c5_sentinel_sar_analytics_v1_1)

It includes a SQLite demo database, KPI computation engine, tactical charts, and a self-contained HTML AAR report generator.

| KPI | Definition | Alert Threshold / Target |
|---|---|---|
| Golden Hour compliance % | Patients handed over within 60 minutes of injury | Target >= 70% |
| Triage accuracy % | MSTART/JumpSTART algorithm match rate vs. override log | Track override rate |
| Tourniquet violation | Active tourniquet age from `tourniquets` and event timestamps | > 120 minutes = immediate alert |
| Stockout risk | Minutes to empty at current `inventory_ledger` burn rate | < 30 minutes = critical |
| Sync latency p95 | 95th percentile local-to-server event delay | > 300 seconds = stale |
| Vitals reassessment compliance | `patients.last_vitals_at` compared with triage interval | Red: 10 minutes; Yellow: 30 minutes |
| Dead Man's Switch | Device heartbeat silence from `device_presence` | > 5 minutes = supervisor alert |

Example output:

- [`analytics/c5_sentinel_sar_analytics_v1_1/aar_report_v1_1.html`](analytics/c5_sentinel_sar_analytics_v1_1/aar_report_v1_1.html)
- [`analytics/c5_sentinel_sar_analytics_v1_1/analytics_demo.ipynb`](analytics/c5_sentinel_sar_analytics_v1_1/analytics_demo.ipynb)
- [`docs/METRICS_DICTIONARY.md`](docs/METRICS_DICTIONARY.md)

This is the portfolio-facing proof that the project is not only a UI mockup: it defines operational metrics, computes them from event data, and translates them into command decisions.

## Version History

The `Previous versions/` folder preserves the product and architecture progression before the current v1.1 package:

- [`Previous versions/v0.6`](<Previous versions/v0.6>) - earlier MVP specification and schema baseline.
- [`Previous versions/v0.7`](<Previous versions/v0.7>) - architecture hardening pass, including offline sync, event-sourcing, inventory ledger, realtime outbox, Quick Patient mode, and SQLite-first mobile storage.

The current v1.1 specification lives in the root `docs/`, `database/`, and `analytics/` folders.

## Repository Structure

```text
.
|-- index.html                         # standalone field/command prototype
|-- demo/
|   `-- rescue-app.html                # same prototype, kept as explicit demo artifact
|-- docs/
|   |-- C5_SENTINEL_SAR_MVP_SPEC_v1.1.md
|   |-- API_SURFACE_v1.1.md
|   |-- CHANGELOG_v1.1.md
|   |-- PC_DEMO_SCRIPT.md
|   |-- METRICS_DICTIONARY.md
|   `-- ROADMAP.md
|-- database/
|   |-- 001_postgresql_schema_v1.1.sql
|   |-- 002_seed_demo_data_v1.1.sql
|   `-- 003_mci_ui_alignment.sql
|-- analytics/
|   `-- c5_sentinel_sar_analytics_v1_1/
|-- assets/
|   `-- mockups/
`-- Previous versions/
    |-- v0.6/
    `-- v0.7/
```

## Interview Narrative

This project frames a mass-casualty event as a data pipeline with a life-or-death SLA.

Every patient is a record. Every vital sign is an event. Every handover is a status transition. Every logistics action is inventory movement. The fog of war is missing data, stale data, and broken observability.

That makes C5 Sentinel-SAR a product/data case study, not just an app mockup:

- product discovery from a real operational gap
- role-based workflow design
- offline-first architecture
- event modeling
- operational KPIs
- command dashboards
- AAR analytics
- safety and privacy tradeoffs

## Status

Prototype and specification phase, v1.1.

This repository is not a certified medical device and is not operationally deployed. It is a portfolio and MVP demonstration package. Do not use it with real patient-identifiable data without organizational authorization, privacy controls, security review, and clinical governance.

## Author

Raanan Kelner  
Data Analyst | IDF Reserve SAR Team Member

Built from the field up. Every feature exists because a real operational gap made it necessary.
