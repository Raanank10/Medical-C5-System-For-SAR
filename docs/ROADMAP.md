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

- [x] Threat model — `docs/THREAT_MODEL.md`. Top finding: RLS/authorization gaps are the most concrete evidenced risk (four real instances found and fixed in one session), not a hypothetical — a systematic full-coverage audit is the top recommended next step, not incremental discovery.
- [ ] Privacy and data minimization review.
- [~] Authentication and role model — real implementation exists and is verified (`docs/ARCHITECTURE.md`), but not yet reviewed as a standalone design document separate from the threat model.
- [ ] Encrypted local storage design — real gap, see `docs/THREAT_MODEL.md`'s T2.
- [ ] Audit and retention policy.
- [ ] Failure-mode review for stale data and sync conflicts.
- [ ] Clinical governance review.
- [ ] Field usability testing with synthetic scenarios only.

## Guiding Constraint

Do not let production architecture slow down learning too early. The next useful version should be judged by whether developers can change it safely, the workflow can be validated repeatedly, and field reviewers can ask sharper questions after seeing the demo.
