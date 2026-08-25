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
- [x] Implement handover with signed QR tokens — the generate/consume flow is now real: `generateQrHandover()` (client) generates a random secret + SHA-256 hash fully offline and pushes the hash through the normal `PATIENT_HANDED_OVER` sync-log event (no live "issue" call needed, preserving offline-first); `supabase/functions/handover-consume` (new, anon-callable Edge Function) verifies proof-of-possession of the secret and returns the MIST summary. Verified live against the real database: a real `PATIENT_HANDED_OVER` event with `handover_method:'secure_qr_token'` correctly produced a `patient_handover_tokens` row via `project_patient_state()`'s existing trigger, and the consume endpoint's hash-verification algorithm was independently confirmed correct (both the matching-secret and wrong-secret cases). The deployed Edge Function's HTTP behavior itself could not be exercised end-to-end from this environment (network egress to `*.supabase.co` is blocked here) — a real click-through test against the deployed URL is the one remaining verification step. One scope cut: the QR renders as a copyable/shareable link, not a scannable QR-code image, since drawing one correctly would need a new dependency this repo doesn't otherwise take on.
- [x] Implement Black triage fast exit with `PATIENT_TRIAGED_EXPECTANT` — real, with a terminal-status guard verified live (blocks re-triage of an already-handed-over patient).
- [x] Drive `patients.current_status` from event projections rather than manual status dropdowns — `project_patient_state()` (`database/013_consolidate_patient_status_projection.sql`), one consolidated trigger after fixing a racing-trigger bug.
- [x] Ensure handover projection resolves patient-specific watchdog alerts and closes Quick Patient assessment debt — part of the same consolidated projection function.
- [~] Keep Chamal/command dashboards on `incident_command_state` — real now (`get_incident_command_state` RPC, `database/014`), but supplementary: the command view still primarily reads local state, with the server snapshot shown as a labeled cross-check, not yet the dashboard's primary/exclusive source.
- [~] Add structured logging and audit traces — `conflict_log`, `sync_ingestion_errors`, and `watchdog_alerts` provide a real audit trail for their specific domains; no centralized structured-logging/observability system has been reviewed.

### Security and Privacy

- [x] Authentication and authorization model — real Supabase Auth, role-based RLS across every table, invite/password-set flow, verified end to end with real test accounts per role.
- [x] Row-level access control — RLS on every table that needs it; two real cross-incident/grant gaps were found and fixed live this session (`sync_ingestion_errors` incident-scoping, `handle_new_user()`'s direct-RPC grant) — see `docs/ARCHITECTURE.md`. The two INFO-level "RLS enabled, no policy" advisor findings on `patient_handover_tokens`/`realtime_outbox` are now confirmed intentional, not just believed: `docs/RLS_AUDIT_v1.md`'s follow-up section verifies live that `anon`/`authenticated` have zero grants on either table and `service_role` has `rolbypassrls=true`, so both are correctly unreachable by any non-service-role caller regardless of policy state. Two `SECURITY DEFINER` functions added since the original audit (`finalize_incident_aar`, `update_patient_identity`) were also checked and both PASS (proper internal `can_access_incident`/role-gate checks).
- [x] Encrypted local storage — `patients[]`/site state, the sync outbox, the in-progress patient-intake draft, the conflict log, observer notes, and the Supabase session token itself are all encrypted at rest (AES-256-GCM, PBKDF2-derived from a device PIN that's never itself persisted). `screen-pin-gate` is the true first screen on every fresh load, ahead of `screen-login`, gating both logged-in and local-demo modes identically. Verified live via `npm run test:browser-smoke` (setup/unlock/wrong-PIN-rejection, raw `localStorage` confirmed opaque). See `docs/THREAT_MODEL.md` T2 — fully mitigated, no remaining deferred follow-up.
- [x] Secret management — audited (`docs/THREAT_MODEL.md` T5): all three real service-role-key usage sites (`scripts/invite_user.js`, `analytics/.../export_live_incident.py`, `supabase/functions/sync-log/index.ts`) read it from an environment variable exclusively, never hardcoded, never client-side, no leak found in git history. The client's Supabase anon key is intentionally public (standard for this architecture, T7). Open: no key-rotation policy or scoped/short-lived key alternative built yet.
- [~] Audit retention policy — `docs/AUDIT_AND_RETENTION_POLICY.md` proposes four retention classes and the deletion-must-be-audited principle; no retention window, scheduled job, or deletion code is implemented yet, and real durations need legal/records-governance input this doc doesn't invent.
- [x] Data minimization review — `docs/PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md`; the repo-level "keep all data synthetic" policy (`docs/OPERATIONS_SAFETY.md`) remains a separate, still-standing rule.
- [x] Incident response plan — `docs/BACKUP_AND_INCIDENT_RESPONSE_PLAN.md`. Planning document only, not a drilled/tested runbook — exercising a real restore needs a non-production environment this repo doesn't have.
- [x] Backup plan and RPO/RTO — same document: current Free-tier Supabase plan gives daily backups with ~24h RPO and no point-in-time recovery; RTO not established (support-ticket restore, no committed SLA).
- [ ] Leaked-password protection (Supabase Auth) — currently disabled on the live project; a dashboard-only toggle (Authentication → Policies → Password Security), not something applied via SQL migration, and a **Supabase Pro-tier feature** — requires a plan upgrade before it can be enabled at all.

### Clinical and Operational Governance

`docs/CLINICAL_GOVERNANCE_REVIEW_FRAMEWORK.md` catalogs the concrete checklist below with exact current values and code locations, for a qualified reviewer to complete — not a substitute for the review itself.

- Doctrine review for triage and reassessment thresholds.
- Review of tourniquet timing rules.
- Review of pediatric triage behavior.
- Human override requirements.
- Training materials.
- [x] Failure-mode review — `docs/FAILURE_MODE_REVIEW.md` (a systems/sync failure-mode review; not a substitute for the clinical-doctrine review this section is otherwise about).
- Approval boundaries for any pilot.

### Field Validation

`docs/FIELD_USABILITY_TEST_PLAN.md` is a real, runnable protocol for everything below — not yet run.

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
