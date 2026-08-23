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
- [x] Pull-side state projection — `pullProjectedPatientState`/`applyProjectedPatientState` in `index.html` periodically read the server's already-projected `patients` rows (not raw events — see `docs/API_SURFACE_v1.2.md`'s "RLS and Membership Scope") and merge them into `patients[]`, so another device's triage/status/handover changes now become visible locally, not just in the AAR text feed. A patient with an unsynced local outbox entry is left alone until it's pushed (local edit wins). Location and full clinical detail (vitals history, treatments) are intentionally not part of this merge yet — only the command-relevant projected fields.
- [~] Real command-dashboard reads — `docs/API_SURFACE_v1.2.md`'s `GET /command/incidents/:incidentId/state` is implemented as a `get_incident_command_state(p_incident_id)` SECURITY DEFINER RPC (`database/014_command_dashboard_state_rpc.sql`) rather than a literal HTTP endpoint, matching how `/sync/log` is a real Edge Function but not a literal path either. The command view's new "מצב שרת" panel shows this aggregate server snapshot as a genuine cross-check alongside the existing locally-computed priority cards. Partial: this only covers the 6-7 aggregate counts `incident_command_state` has (red/total/handed-over/missing-vitals/watchdog-alert/dead-man-switch counts) — Command Actions and the full AAR API (spec sections 6-7) remain unbuilt, and most of the existing local priority-card metrics (reinforcement requests, device/sync counts, per-patient watchdog detail) have no server equivalent to replace them with yet.
- [x] Sync freshness and device presence in the command view — freshness pills are wired to real push/pull success. The device panel now reads real `device_presence` rows (`pushDevicePresence`/`pullDevicePresence` in `index.html`): each logged-in device writes its own heartbeat on the same 45s interval as sync, and the command view's device panel shows every device's real `last_heartbeat_at`, not devices inferred from local patients' `lastTouchedBy` fields. Local-demo (no-login) mode keeps the old inference as a fallback, unchanged.
- [x] Poison-event and high-risk-violation concepts — real server-side (`sync_ingestion_errors`, `blocked_dependency`, `high_risk_flags` from `watchdog_alerts`), and now a dedicated command-only "אירועים חסומים / סיכון גבוה" review panel in `index.html`: unresolved `sync_ingestion_errors` rows (command-role read, incident-scoped — `database/015_scope_sync_ingestion_errors_by_incident.sql` fixed a real cross-incident RLS gap found while building this) plus `high_risk_flags` read back from each sync push response (previously captured by the client and silently discarded).
- [x] AAR output from the same event stream — the in-app AAR screen already blends local + server-pulled events. The standalone `analytics/c5_sentinel_sar_analytics_v1_1` package can now also read real data: `export_live_incident.py` (stdlib-only, no new dependency) pulls a real incident from the live Supabase database via PostgREST into a local SQLite file shaped like `seed_demo_db.py`'s schema, so `db.py`/`kpis.py`/`report.py` run unmodified against it. `seed_demo_db.py` remains the default/documented path for the synthetic demo story.

## Phase 4: Split Into Implementation Packages

Goal: introduce real app boundaries after the workflow stabilizes.

**Gate before starting any Phase 4 sub-phase**: (1) `docs/FIELD_USABILITY_TEST_PLAN.md`'s Session 2 (offline/intermittent-connectivity drill) has run at least once — even informally, two devices and a controllable network, without waiting for a fully staffed field exercise — and its result (real reconnect-to-sync latency, whether `docs/FAILURE_MODE_REVIEW.md`'s F1 fix holds under a live extended-offline stress test, what actually happens in a real F3 concurrent-edit case) is recorded — **still open**; and (2) `docs/FAILURE_MODE_REVIEW.md`'s F3 (cross-device concurrent edits to the same patient) has an explicit, documented resolution rule — **resolved**: `docs/CONFLICT_RESOLUTION_DECISION.md` records a hybrid field-level-merge + role-authority (physician > cc > pc > medic) resolution, decided but not yet built (deferred to 4D/4E), with one open prerequisite (the physician role doesn't exist in the live server role enum yet) flagged for whoever implements it. Phase 4 is exactly the point where undecided product behavior becomes expensive engineering ambiguity across two codebases instead of one; both gates exist to keep that from happening by neglect — one is now closed, the field-usability-drill gate is not.

See `docs/PHASE_4_PLAN.md` for the detailed working plan — current-state inventory against what's actually built, open decisions that need the user's input before starting, and a risk-ordered sub-phase sequence (`packages/domain` first, `apps/field-mobile` last, `index.html` stays working throughout).

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

`[x]` done, `[~]` partially done (see the note), `[ ]` not started.

- [x] Threat model — `docs/THREAT_MODEL.md`. Top finding: RLS/authorization gaps are the most concrete evidenced risk. The systematic full-coverage audit the threat model called for is now done — `docs/RLS_AUDIT_v1.md` (86 policies across 32 tables, 21 `SECURITY DEFINER` functions, all reviewed against the live database). Two more real gaps were found and fixed live (`database/017_lock_out_inactive_profiles.sql`, both in the account-deactivation/`is_active` path). Encrypted local storage (T2) is done — see below; the Supabase session token is now the threat model's top-ranked open item.
- [x] Privacy and data minimization review — `docs/PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md`. Real findings: `profiles.phone` is collected but read by zero current client code; `device_presence` real-time responder location has no in-app disclosure to the person being tracked; `sync_ingestion_errors.raw_payload` retains rejected clinical free text indefinitely with no shorter retention than successfully-processed history (feeds directly into the retention policy below). Finding #1 (`patients.optional_name` already minimized, name only captured if known) now has a concrete built follow-on: `docs/PATIENT_IDENTITY_LIFECYCLE.md` — name and a new identifying-description field are always-optional, separately-deletable (`database/018_patient_identity_lifecycle.sql`), kept out of the immutable event log by design, shared across devices during the incident, and cleared by a command-role "finalize AAR" action while all clinical data stays permanent. Two real identity leaks found and fixed in `index.html`/`demo/rescue-app.html` (`reassignPatient()`'s event-detail text, `exportExperimentLog()`'s export). Explicitly not a legal-compliance sign-off — see that doc's closing section.
- [x] Authentication and role model — `docs/AUTH_AND_ROLE_MODEL.md`, the connective technical layer between `docs/ROLE_COMMAND_MODEL_v2.8.md` (what each role does) and `docs/THREAT_MODEL.md` (what could go wrong): identity/session layer, the 8-role live enum, the five `app.*()` RLS helper functions and why they're `SECURITY DEFINER`, and the full account lifecycle from invite through deactivation. One new finding: `profiles.role`/`is_active` changes aren't themselves logged as auditable events — no admin promote/demote/deactivate action leaves a record beyond the row's own `updated_at`.
- [x] Encrypted local storage design — `docs/THREAT_MODEL.md`'s T2 is mitigated for the clinically-relevant `localStorage` keys: a device PIN (never persisted) derives an AES-256-GCM key via PBKDF2; `screen-pin-gate` gates every fresh load ahead of `screen-login`, identically for logged-in and local-demo modes. The Supabase session token itself is a deliberately deferred follow-up (separate onboarding-flow bootstrapping problem) — see `docs/THREAT_MODEL.md` T2.
- [x] Audit and retention policy — `docs/AUDIT_AND_RETENTION_POLICY.md`. Proposes four retention classes (clinical record of record / operational-audit-trail / quarantined-payload / ephemeral) rather than one blanket window, and requires any future deletion to itself be an audited event. Policy proposal only — no retention window, scheduled job, or deletion code is implemented; real retention durations need legal/records-governance input this review deliberately doesn't invent.
- [x] Failure-mode review for stale data and sync conflicts — `docs/FAILURE_MODE_REVIEW.md`. Found and fixed a real bug while writing it: the local sync outbox's 500-entry cap could silently drop still-unsynced clinical events on a long enough offline stretch (`persistOutbox()`, verified with 3 Playwright cases including a reproduction of the real data-loss scenario under the old logic). F3 (cross-device concurrent edits) now has a recorded resolution — see `docs/CONFLICT_RESOLUTION_DECISION.md`. Remaining findings documented, not fixed here — they need Phase 4 architecture work or field-validation data this review doesn't have.
- [~] Clinical governance review — `docs/CLINICAL_GOVERNANCE_REVIEW_FRAMEWORK.md` catalogs every hardcoded clinical/timing parameter in `src/domain/rules.js` (MSTART triage thresholds, vitals cadence, tourniquet timing, pediatric age cutoff and high-risk dose limits, black-triage criteria, device-silence threshold) as a concrete checklist. Explicitly a framework for a qualified reviewer, not clinical sign-off — this session has no medical/SAR doctrine authority to complete it, and doesn't claim to.
- [~] Field usability testing with synthetic scenarios only — `docs/FIELD_USABILITY_TEST_PLAN.md` is a real, runnable protocol (4 sessions: gloved/one-handed/low-light medic workflow, offline/intermittent-connectivity drills including a live-device version of `docs/FAILURE_MODE_REVIEW.md`'s F1 stress test, commander stale-data comprehension directly testing F4, and a full synthetic-MCI multi-role rehearsal) — not yet run. Running it needs real participants and devices this session doesn't have.

## Guiding Constraint

Do not let production architecture slow down learning too early. The next useful version should be judged by whether developers can change it safely, the workflow can be validated repeatedly, and field reviewers can ask sharper questions after seeing the demo.
