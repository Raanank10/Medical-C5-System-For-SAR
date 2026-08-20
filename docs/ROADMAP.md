# Roadmap

The project should advance as a development repo while preserving one reliable demo story. The immediate goal is not production scale; it is a cleaner prototype with testable product rules and a path toward real implementation.

## Phase 1: Stabilize the Development Surface

Goal: make the repository easy to clone, inspect, validate, and change.

- Keep `index.html` as the stable demo entry point.
- Keep `demo/rescue-app.html` only if it serves a distinct demo purpose.
- Add browser smoke tests for loading the prototype.
- Add analytics KPI tests with pytest.
- Add SQL validation notes for the schema and seed files.
- Keep `python scripts/check_repo.py` passing in CI.
- Replace outdated portfolio language with development status and build priorities.

## Phase 2: Extract Product Rules

Goal: move critical logic out of one large prototype file into documented, testable rules.

- Define triage state transitions.
- Define vitals reassessment intervals by triage color.
- Define tourniquet review thresholds.
- Define patient status and handover transitions.
- Define inventory burn-rate and stockout-risk rules.
- Define stale-data and device-silence thresholds.
- Add synthetic fixtures for repeatable incident scenarios.

## Phase 3: Local-First Prototype Hardening

Goal: prove the core offline-first architecture before introducing production services.

`[x]` done, `[~]` partially done (see the note), `[ ]` not started.

- [x] Local persistence for patients, vitals, treatments, inventory, and handovers — `index.html`'s `patients[]`/`state.localEvents` in `localStorage`. See `docs/ARCHITECTURE.md`'s "Backend Deployment Status".
- [x] Local event log — `state.localEvents` / the `c5_local_sqlite_outbox` outbox. Replay path for *locally created* events is done (outbox → push); replay of *pulled* remote events into local state is not (see next item).
- [x] Real (not simulated) sync push/pull — `index.html` pushes to and pulls from a deployed Supabase Edge Function (`supabase/functions/sync-log`), cursor-tracked, idempotent, with dependency-blocked-event handling. Exceeds the original "simulated" framing of this bullet.
- [ ] Pull-side state projection — server-pulled events currently only render into the AAR timeline; they don't update `patients[]`, so cross-device patient state isn't actually visible outside that one feed. The core remaining offline-first gap.
- [ ] Real command-dashboard reads — `docs/API_SURFACE_v1.2.md`'s `GET /command/incidents/:incidentId/state` (precomputed `incident_command_state` snapshot) isn't built; command views (pc/cc/chamal) read the same local-only state as medic screens.
- [~] Sync freshness and device presence in the command view — freshness pills are wired to real push/pull success; the device panel's "devices" are inferred from local patients' `lastTouchedBy` fields, not a real heartbeat/presence signal.
- [~] Poison-event and high-risk-violation concepts — real server-side (`sync_ingestion_errors`, `blocked_dependency`, `high_risk_flags` from `watchdog_alerts`); client only shows a numeric "rejected" count, no dedicated review panel.
- [~] AAR output from the same event stream — the in-app AAR screen already blends local + server-pulled events. The standalone `analytics/c5_sentinel_sar_analytics_v1_1` package is still fully disconnected, reading only its own synthetic SQLite seed.

## Phase 4: Split Into Implementation Packages

Goal: introduce real app boundaries after the workflow stabilizes.

- `apps/field-mobile`: Expo or native mobile field workflow.
- `apps/command-web`: command dashboard.
- `packages/domain`: triage, vitals, inventory, sync, and alert rules.
- `packages/fixtures`: synthetic incidents and demo scenarios.
- `services/sync-api`: event ingestion and pull API.
- `services/projectors`: command-state projection workers.
- `database/migrations`: executable database migrations.
- `analytics/`: KPI and AAR package.

## Phase 5: Operational Readiness Research

Goal: identify what would be required before any real-world pilot discussion.

- Threat model.
- Privacy and data minimization review.
- Authentication and role model.
- Encrypted local storage design.
- Audit and retention policy.
- Failure-mode review for stale data and sync conflicts.
- Clinical governance review.
- Field usability testing with synthetic scenarios only.

## Guiding Constraint

Do not let production architecture slow down learning too early. The next useful version should be judged by whether developers can change it safely, the workflow can be validated repeatedly, and field reviewers can ask sharper questions after seeing the demo.
