# C5 Sentinel-SAR

Mission-critical Medical Command and Control for Search and Rescue mass-casualty operations.

**[Live Demo ->](https://raanank10.github.io/Medical-C5-System-For-SAR/)**

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

## Current Demo

Use the **[Live Demo](https://raanank10.github.io/Medical-C5-System-For-SAR/)** for the fastest walkthrough.

You can also open [`index.html`](index.html) locally after cloning the repo.

The same demo is also available at [`demo/rescue-app.html`](demo/rescue-app.html).

The prototype includes:

- incident/site setup
- rapid patient intake
- location and access status
- tourniquet capture
- stepper-based vitals
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

Core technical docs:

- [`docs/C5_SENTINEL_SAR_MVP_SPEC_v1.1.md`](docs/C5_SENTINEL_SAR_MVP_SPEC_v1.1.md)
- [`docs/API_SURFACE_v1.1.md`](docs/API_SURFACE_v1.1.md)
- [`database/001_postgresql_schema_v1.1.sql`](database/001_postgresql_schema_v1.1.sql)
- [`database/002_seed_demo_data_v1.1.sql`](database/002_seed_demo_data_v1.1.sql)

## Analytics And AAR

The analytics package is a standalone Python layer showing how the event log becomes command insight and after-action learning.

Location: [`analytics/c5_sentinel_sar_analytics_v1_1`](analytics/c5_sentinel_sar_analytics_v1_1)

It includes a SQLite demo database, KPI computation engine, tactical charts, and a self-contained HTML AAR report generator.

| KPI | Source | Threshold / Interpretation |
|---|---|---|
| Command casualty picture | `patients`, `incident_command_state` | Current red/yellow/green/black counts for command decisions |
| Time to first vitals | `events` where `type = 'VITALS_RECORDED'` | Target: first vitals within 5 minutes of patient registration |
| Vitals reassessment compliance | `patients.last_vitals_at`, vitals events | Red target: 10 minutes; Yellow target: 30 minutes |
| Golden Hour compliance | `patients.t_injury`, `patients.handed_over_at` | Tracks handover within 60 minutes from injury time |
| Tourniquet reassessment due | `tourniquets.next_reassessment_due_at` | Due or overdue tourniquets require command/clinical attention |
| High-risk clinical violations | `watchdog_alerts`, `conflict_log` | Preserved and escalated, not silently blocked |
| Dead Man's Switch | `device_presence`, `watchdog_alerts` | Medic/device silent for more than 5 minutes |
| Sync freshness | `device_sync_state.last_successful_pull_at` | Fresh under 60s; stale over 60s; critical over 300s |
| Sync latency | local/server event timestamps | p95 latency indicates offline/sync degradation |
| Stockout risk | `inventory_ledger` burn rate | Flags negative stock and items at risk of depletion |

Example output:

- [`analytics/c5_sentinel_sar_analytics_v1_1/aar_report_v1_1.html`](analytics/c5_sentinel_sar_analytics_v1_1/aar_report_v1_1.html)
- [`analytics/c5_sentinel_sar_analytics_v1_1/analytics_demo.ipynb`](analytics/c5_sentinel_sar_analytics_v1_1/analytics_demo.ipynb)
- [`docs/METRICS_DICTIONARY.md`](docs/METRICS_DICTIONARY.md)

This is the portfolio-facing proof that the project is not only a UI mockup: it defines operational metrics, computes them from event data, and translates them into command decisions.

## Version History

The `versions/` folder preserves the product and architecture progression:

- [`versions/v0.6`](versions/v0.6) - earlier MVP specification and schema baseline.
- [`versions/v0.7`](versions/v0.7) - architecture hardening pass, including offline sync, event-sourcing, inventory ledger, realtime outbox, Quick Patient mode, and SQLite-first mobile storage.
- [`versions/v1.1`](versions/v1.1) - current production-ready specification package with sync-log-first API, command/AAR endpoints, scoped RLS baseline, analytics alignment, and PC demo package.

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
|   `-- 002_seed_demo_data_v1.1.sql
|-- analytics/
|   `-- c5_sentinel_sar_analytics_v1_1/
|-- assets/
|   `-- mockups/
`-- versions/
    |-- v0.6/
    |-- v0.7/
    `-- v1.1/
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
