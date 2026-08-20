# Production Readiness Path

C5 Sentinel-SAR is still a development prototype. This document names the gap between the current repo and any future production or pilot-ready system.

## Current Position

The repo currently contains:

- standalone HTML prototype
- shared domain-rule module
- SQL schema draft
- sync/API specification
- analytics/AAR package
- synthetic demo data
- development docs and validation checks

This is enough for workflow validation and engineering iteration. It is not enough for operational deployment.

## Required Before Production

`[x]` done, `[~]` partially done (see the note), `[ ]` not started. Status current as of `docs/ROADMAP.md` Phase 3's completion — see that file and `docs/ARCHITECTURE.md`'s "Backend Deployment Status" for the underlying evidence; nothing below is marked done without a specific verified artifact behind it.

### Engineering

- [ ] Split prototype into app/service packages — `docs/ROADMAP.md` Phase 4, not started; this is the next major undertaking, not something folded into Phase 3.
- [~] Add automated browser tests for New Patient, command dashboard, and AAR flows — `scripts/browser_smoke_test.js` (Playwright) verifies the app actually loads and initializes in a real browser, but only checks startup state (login screen, `C5DomainRules` loaded), not full interaction through any of these three flows.
- [~] Add unit tests for all domain rules — `tests/domain-rules.test.js` covers triage, vitals, tourniquet, device-silence, patient-status guards, and inventory burn-rate rules substantially, but "all" is a stronger claim than has been verified; new rules added to `src/domain/rules.js` need matching tests, not an automatic guarantee.
- [ ] Add executable database migrations — still versioned draft SQL files applied by hand (`database/001_...sql` through `016_...sql`), no migration framework or `up`/`down` tooling.
- [x] Implement real local persistence — `index.html`'s `patients[]`/`state.localEvents` in `localStorage`.
- [x] Implement sync push/pull with conflict and poison-event handling — real, deployed `supabase/functions/sync-log` Edge Function; poison events land in `sync_ingestion_errors` and are now visible in a dedicated command review panel, not just a numeric count.
- [x] Enforce idempotent sync by `device_id + local_event_id` at the database layer — `unique (device_id, local_event_id)` on `events`.
- [x] Preserve dependency-aware sync ordering for offline batches — `depends_on`/`blocked_dependency` handling in the sync-log function, verified live with a real blocked-dependency case.
- [~] Implement handover with signed QR tokens — `patients.handover_token`/`handover_token_used_at`/`handover_token_expires_at` columns and a `patient_handover_tokens` table exist server-side; a full signed-QR generate/scan/consume flow tested end to end has not been verified in this pass.
- [x] Implement Black triage fast exit with `PATIENT_TRIAGED_EXPECTANT` — real, with a terminal-status guard verified live (blocks re-triage of an already-handed-over patient).
- [x] Drive `patients.current_status` from event projections rather than manual status dropdowns — `project_patient_state()` (`database/013_consolidate_patient_status_projection.sql`), one consolidated trigger after fixing a racing-trigger bug.
- [x] Ensure handover projection resolves patient-specific watchdog alerts and closes Quick Patient assessment debt — part of the same consolidated projection function.
- [~] Keep Chamal/command dashboards on `incident_command_state` — real now (`get_incident_command_state` RPC, `database/014`), but supplementary: the command view still primarily reads local state, with the server snapshot shown as a labeled cross-check, not yet the dashboard's primary/exclusive source.
- [~] Add structured logging and audit traces — `conflict_log`, `sync_ingestion_errors`, and `watchdog_alerts` provide a real audit trail for their specific domains; no centralized structured-logging/observability system has been reviewed.

### Security and Privacy

- [x] Authentication and authorization model — real Supabase Auth, role-based RLS across every table, invite/password-set flow, verified end to end with real test accounts per role.
- [x] Row-level access control — RLS on every table that needs it; two real cross-incident/grant gaps were found and fixed live this session (`sync_ingestion_errors` incident-scoping, `handle_new_user()`'s direct-RPC grant) — see `docs/ARCHITECTURE.md`. Two INFO-level "RLS enabled, no policy" advisor findings on `patient_handover_tokens`/`realtime_outbox` are believed intentional (service-role-only tables) but haven't had a dedicated design review.
- [ ] Encrypted local storage — `localStorage` is plaintext; a lost/stolen device exposes whatever patient data is cached locally. Real gap, not yet designed.
- [~] Secret management — the analytics export script's service-role key is documented as env-var-only, never committed (`analytics/c5_sentinel_sar_analytics_v1_1/export_live_incident.py`); the client's Supabase anon key is intentionally public (standard for this architecture). No review of Edge Function secret handling or key rotation.
- [ ] Audit retention policy — no retention/deletion policy exists for `events`, `conflict_log`, `sync_ingestion_errors`, or `watchdog_alerts`.
- [ ] Data minimization review — the repo-level "keep all data synthetic" policy (`docs/OPERATIONS_SAFETY.md`) is a different thing from a real review of what the schema collects and whether it needs all of it.
- [ ] Incident response plan — does not exist.
- [ ] Leaked-password protection (Supabase Auth) — currently disabled on the live project; a dashboard-only toggle (Authentication → Policies → Password Security), not something applied via SQL migration.

### Clinical and Operational Governance

- Doctrine review for triage and reassessment thresholds.
- Review of tourniquet timing rules.
- Review of pediatric triage behavior.
- Human override requirements.
- Training materials.
- Failure-mode review.
- Approval boundaries for any pilot.

### Field Validation

- Gloved touch testing.
- Low-light and sunlight testing.
- One-handed workflow testing.
- Offline and intermittent-connectivity drills.
- Commander stale-data comprehension testing.
- Synthetic mass-casualty scenario rehearsals.

### Handover and Command Performance Guardrails

- A handover is complete only after a local `PATIENT_HANDED_OVER` event exists.
- A Black/expectant classification is complete after a local `PATIENT_TRIAGED_EXPECTANT` event exists.
- QR handover links must use temporary encrypted tokens and signatures; do not embed clinical files in the QR.
- Receiving units on other platforms consume the token through a backend endpoint.
- Duplicate handover packets must be treated as duplicate sync, not repeated status mutations.
- Open tourniquet/vitals reassessment alerts for a handed-over patient must be resolved with `resolved_by_event_id`.
- Command dashboard refresh should poll the precomputed state endpoint at a fixed interval, for example every 5 seconds — implemented, but at 45s (matching the existing sync push/pull interval), not 5s; revisit if faster command-view freshness becomes a real requirement.
- Throughput analytics should use the precomputed/state pipeline and `vw_command_incident_throughput_funnel`.

### v1.2 Field Experiment Guardrails

- Demo handover language must not imply a real QR transfer unless an actual scan target is generated and tested.
- Vitals count windows must support timer-guided 15s/30s counting for gloved, one-handed use.
- Alert acknowledgment is required so commanders can distinguish "unseen" from "seen and being handled."
- Field experiment runs must export `experiment_events.csv`, `patients_summary.csv`, `aar_metrics.json`, and `observer_notes.csv`.
- Static demos may use localStorage, but the UI must surface edit conflicts and assessment debt instead of pretending the data is complete.
- Logistics must use an append-only inventory ledger; negative stock is accepted and escalated, never blocked.

## Development Priority

The next production-aligned build work should happen in this order:

1. Keep the standalone demo stable.
2. Move clinical and operational rules into `src/domain/`.
3. Test those rules without a browser.
4. Add browser smoke tests for the core flows.
5. Add local event persistence.
6. Use the event log as the source for UI state and AAR analytics.
7. Split apps and services only after the workflow stabilizes.
