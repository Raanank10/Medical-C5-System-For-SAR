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

## Current Demo

Open [`index.html`](index.html) in a browser to run the standalone Hebrew prototype.

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

The analytics package shows how the event log becomes command insight and after-action learning.

Location: [`analytics/c5_sentinel_sar_analytics_v1_1`](analytics/c5_sentinel_sar_analytics_v1_1)

It includes:

- KPI computation engine
- SQLite demo database
- command summary metrics
- vitals reassessment compliance
- Golden Hour compliance
- high-risk clinical violation tracking
- data freshness and sync health
- stockout risk analysis
- self-contained HTML AAR report generator

See [`docs/METRICS_DICTIONARY.md`](docs/METRICS_DICTIONARY.md) for the analyst-facing metric definitions.

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
`-- Docs/
    `-- Readme C5 Sentinel for SAR - Medical Command & Control.md
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
