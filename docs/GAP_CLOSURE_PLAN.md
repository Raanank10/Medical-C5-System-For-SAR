# Gap Closure Plan

Working plan to close the gaps found by the feature-map audit of V2.99.33 (`main` @ `a4f6c81`, 2026-10-18). The audit traced every feature along one chain: recorded on the phone, sent through `sync-log`, stored or projected on the server, and seen on another device. Most gaps are places where that chain stops early, so a feature works on one phone but never reaches the commander.

This file is written to be handed to a fresh Claude Code session. Each work package (WP) is one small PR that can be done on its own, in the order below. Read [CLAUDE.md](../CLAUDE.md) and [MULTI_AGENT_DEV_PLAN.md](MULTI_AGENT_DEV_PLAN.md) first; their rules apply to every WP here.

## How to use this plan in a new session

Paste something like this into the new conversation:

> Read `docs/GAP_CLOSURE_PLAN.md` and `CLAUDE.md`. Do WP-N only. Before writing code, re-check the evidence lines listed for WP-N against the current code (line numbers drift), tell me anything that changed, and ask me about any open decision WP-N depends on. Then implement, run the checks listed under "Verify", and stop before merging.

Update the status table at the bottom of this file in the same PR that finishes a WP.

## Rules for every WP

- Edit `index.html` and `demo/rescue-app.html` identically (until WP-14 changes that). Confirm with `diff index.html demo/rescue-app.html` before committing.
- Bump `APP_VERSION` and the visible version labels together, one version per merged PR.
- New SQL goes in a new numbered file, starting at `database/047_...`. Never edit an applied migration. Every new trigger function: `SECURITY DEFINER`, `set search_path`, and `revoke execute ... from public, anon, authenticated` (see `046`). Run `get_advisors` after applying.
- Any new event type must be added in four places at once: the `event_type` enum (migration), `ROLE_ALLOWED_EVENT_TYPES` in `supabase/functions/sync-log/index.ts`, `SYNC_ELIGIBLE_EVENT_TYPES` in the HTML, and the contract list from WP-1.
- Deploy order when a WP has server parts: migration, then `sync-log` Edge Function, then client. The client must keep working if the migration is not applied yet (separate queries, tolerate missing columns), as `044` did.
- Clinical, sync-conflict and RLS changes are never auto-merged. The owner verifies them live against the real accounts (CLAUDE.md, "Safety and data policy").
- Synthetic data only.
- Before every PR: `python scripts/check_repo.py`, `node tests/domain-rules.test.js`, `npm run test:browser-smoke`, plus the browser tests listed under the WP.
- Update the matching doc in the same PR (`ARCHITECTURE.md` "Backend Deployment Status", `FIELD_EXPERIMENT_GAPS.md`, `API_SURFACE_v1.2.md`, `TACTICAL_UI_GUIDELINES.md` as relevant).

## Live access note

The session that wrote this plan could not reach the Supabase project (network policy). A session with the Supabase MCP connector (`execute_sql`, `apply_migration`, `deploy_edge_function`, `get_advisors`) can run the live checks itself. Otherwise the owner runs them. Use read-only queries for checks, and role impersonation inside a rolled-back transaction for RLS tests (see `RLS_AUDIT_v1.md`).

## Decisions the owner must make

Some WPs cannot finish without one of these. Ask before starting the WP that needs it.

| ID | Decision | Needed by | Options |
| --- | --- | --- | --- |
| D1 | Tourniquet timing has two different rule sets. The client (`src/domain/rules.js` `tourniquetTimer`) uses a 45 min notice, 60 min warning and 120 min critical from application. The server (`project_tourniquet_events()` in `database/001_postgresql_schema_v1.2.sql`, around line 1180) schedules reassessment every 30 min for crush/uncertain and 60 min for bleeding, clamped to 10-120. Which one is authoritative for remote devices and for server watchdogs? | WP-2, WP-12 | (a) show the client rule everywhere and keep the server value as data only; (b) align the server to the client; (c) clinical review first (`CLINICAL_GOVERNANCE_REVIEW_FRAMEWORK.md`) |
| D2 | Two inventory ledger tables, `inventory_ledger` (v1.1) and `inventory_ledger_v12`. Neither is written by the client today. | WP-9 | (a) keep `inventory_ledger_v12`, archive v1.1; (b) the reverse; (c) defer inventory sync |
| D3 | Who sees reinforcement and death-certification requests from other devices? | WP-5 | Suggested: requests visible to pc/cc/chamal/physician/admin of the incident; death-certification requests also to every physician in the incident |
| D4 | Alert acknowledgment: event only, or also mark `watchdog_alerts.acknowledged_at` on the server? | WP-4 | Suggested: both, via a projection |
| D5 | `demo/rescue-app.html`: keep as a byte-identical copy, generate it, or replace with a redirect to `index.html`? | WP-14 | Check what the GitHub Pages demo link and smoke scripts rely on before choosing |
| D6 | Supabase Pro plan, required for leaked-password protection. | Track T5 | Cost decision |

## Work packages

Order: WP-0 and WP-1 first (they make every later WP safer). Then WP-2 to WP-5, which are the P1 items that would mislead a commander in the first multi-phone field test. Then P2, then P3.

---

### WP-0: Live baseline check (no code)

**Why.** Several gaps were inferred from code reading. Confirm them on the live database before changing anything, so each PR fixes a real, measured problem.

**Steps.** Read-only SQL against the live project, for the most recent incidents that had human activity:

1. Event types actually stored: `select type, count(*) from events group by type order by 2 desc;`
2. Clinical events stored without a patient: `select type, count(*) from events where patient_id is null and type in ('VITALS_RECORDED','TOURNIQUET_APPLIED','PATIENT_STATUS_UPDATED','INTERVENTION_RECORDED') group by type;`
3. Patients with no server vitals although the phone recorded them: count of `patients` with `last_vitals_at is null` per incident, compared with what was entered in the test.
4. `select count(*), count(*) filter (where is_active) from tourniquets;`
5. `select count(*) from watchdog_alerts where acknowledged_at is not null;`
6. How building status and site clear are stored: `select type, payload_json from events where type in ('BUILDING_STATUS_UPDATED','SITE_CLEAR_CONFIRMED') limit 5;` and whether `incident_command_state.state_json` carries anything for them.

**Done when.** The results are pasted into this file under "Baseline results" and each later WP is marked confirmed, changed, or not needed.

---

### WP-1: Event contract check (guardrail)

**Why.** The client emits about 60 event types that never pass `SYNC_ELIGIBLE_EVENT_TYPES` (`index.html` around line 2881), and the sync list holds about 40 types the client never sends. Some are local-only by design (UI timeline entries); others are bugs (`INTERVENTION_LOGGED` vs the server's `INTERVENTION_RECORDED`, lowercase `medical_reinforcement`). Nothing checks this today, which is how these gaps appeared silently.

**Steps.**
1. Create `src/domain/event-contract.json` (or a `.js` UMD module, matching `rules.js`) with three lists: `synced` (must match `SYNC_ELIGIBLE_EVENT_TYPES`), `local_only` (each with a one-line reason), and `server_written` (written by RPCs, e.g. `INCIDENT_OPENED`, `INCIDENT_CLOSED`).
2. Add a check in `scripts/check_repo.py` (stdlib only): extract every `type:'X'` literal passed to `saveLocalEvent`, `queueEventOnce` and `p.events.unshift` in `index.html`. Fail if a type is in none of the lists, if `SYNC_ELIGIBLE_EVENT_TYPES` differs from `synced`, or if a `synced` type is missing from `ROLE_ALLOWED_EVENT_TYPES` in `supabase/functions/sync-log/index.ts`.
3. Seed `local_only` with today's genuinely local types. Put the types this plan will fix in a `known_gaps` list with the WP id, so the check passes now and each WP removes its entries.
4. Add `src/domain/event-contract.*` to `REQUIRED_PATHS`.

**Verify.** `python scripts/check_repo.py` passes; deliberately add a fake event type and confirm it fails.

**Done when.** CI fails on any new unclassified event type. No behavior change.

---

### WP-2: Tourniquets cross devices (P1, safety-critical)

**Why.** A commander's tourniquet count and timers include only tourniquets recorded on the commander's own device. `TACTICAL_UI_GUIDELINES.md` requires the tourniquet timer to stay visible everywhere.

**What already works on the server.** `project_tourniquet_events()` (`database/001_postgresql_schema_v1.2.sql` ~1180-1283) projects `TOURNIQUET_APPLIED`, `TOURNIQUET_REASSESSMENT`, `TOURNIQUET_CONTEXT_UPDATED` and `TOURNIQUET_RELEASED` into `tourniquets`, keyed by `(patient_id, limb, applied_at)`, when `patient_id` is set. `tourniquets_read` RLS (`004`) allows incident members to read. All four types are already in `SYNC_ELIGIBLE_EVENT_TYPES` and `sync-log`.

**Evidence (client).**
- Apply with patient id: `index.html` ~7588, ~8439.
- Apply without patient id or limb: the intake flow's `projectPatientStatus('stabilizing','TOURNIQUET_APPLIED')` at ~9613 and ~11675, which goes through `queueEventOnce` (see WP-3).
- `TOURNIQUET_RELEASED`, `TOURNIQUET_REASSESSMENT`, `TOURNIQUET_CONTEXT_UPDATED` are never emitted.
- No `from('tourniquets')` read anywhere.

**Steps.**
1. Find every place a tourniquet is applied, released, reassessed or has its context changed (`activeTourniquets`, limb prompts, release buttons). Each must call `saveLocalEvent` with top-level `patient_id`, and `payload_json` with `limb` (same key vocabulary as `BODY_ZONE_LABELS`), `application_time` (ISO, the real application time, not the save time), `clinical_context` where known, and the local tourniquet id.
2. Patient must exist first: during intake, hold tourniquet events until `PATIENT_CREATED` is queued, then queue them in order (same rule as the comment at ~10018). Remove the patient-less `TOURNIQUET_APPLIED` from `projectPatientStatus`.
3. Pull: add a `pullTourniquets(incidentId)` on the 45 s cadence as a separate query (`select patient_id, limb, applied_at, is_active, released_at, last_reassessed_at, next_reassessment_due_at, clinical_context from tourniquets where incident_id = ...`). Merge into the patient's tourniquet list, keyed by `(patient_id, limb, applied_at)`. Local unsynced entries win; never delete a local active tourniquet because the server lacks it.
4. Remote tourniquets drive the same timer UI (`tourniquetTimer` from `src/domain/rules.js`) from `applied_at`, marked as remote like remote vitals are.
5. Command counts and `DecisionSupportEngine` then pick them up with no further change; confirm.

**Depends on.** D1 for which timer the UI shows for remote tourniquets.

**Verify.** New `scripts/browser_tourniquet_sync_test.js` (pattern: `browser_medic_assignment_test.js`, three tabs on one stubbed backend): medic applies, PC sees the timer with the correct start time; medic releases, PC sees it released; apply during intake reaches the server after `PATIENT_CREATED`. Live: run WP-0 query 4 before and after one field-style test.

**Done when.** A tourniquet applied on phone A shows on phone B with the right elapsed time within one sync cycle, and release clears it.

---

### WP-3: Treatments, intake vitals and injuries reach the server (P1)

**Why.** Treatments use event names the server does not know. Vitals and injuries entered during the first patient form are queued before the patient exists, without a patient id, and only once per device ever.

**Evidence.**
- `queueEventOnce` (`index.html` ~6873) skips a type if any event of that type exists anywhere in `state.localEvents`, which is the whole outbox and is never cleared. After the first patient on a device, intake-flow `VITALS_RECORDED` and status events are never queued again.
- `projectPatientStatus` (~6878) queues these without `patient_id`.
- `PATIENT_CREATED` at ~10020 carries only `visual_id` and `triage`.
- Treatments: `INTERVENTION_LOGGED` (~9613, ~10015, ~10136), `IMMEDIATE_INTERVENTION_RECORDED` (~8439), `LIFE_SAVING_ACTION_RECORDED` (~8378). The server knows `INTERVENTION_RECORDED` (in `013`'s projection and refresh lists), which is never sent.
- `PATIENT_INJURY_UPDATED` is in the sync list but never emitted. The server projects it (`013` ~153).

**Steps.**
1. Scope `queueEventOnce` to one patient (key on type plus the patient being created or edited). Write a failing test first that creates two patients in a row and checks both get their events.
2. At save of a new patient (full and quick flows), queue in order: `PATIENT_CREATED`, then `VITALS_RECORDED` with the intake values, `PATIENT_INJURY_UPDATED` with injuries and mechanism, one `INTERVENTION_RECORDED` per treatment, tourniquets (WP-2), `MEDICATION_ADMINISTERED`. All with the new patient's UUID.
3. Map client treatment names to `INTERVENTION_RECORDED` with `payload_json.intervention_type` (keep the local timeline names for display). Check `013`'s `INTERVENTION_RECORDED` branch for the payload keys it reads, and the `treatment_catalog` keys.
4. Vitals modal treatments (`queueModalTreatmentEvents`, ~10231): confirm they reach the outbox as `INTERVENTION_RECORDED`.
5. Remove the patient-less status events from `projectPatientStatus` (the server derives status itself in `project_patient_state()`), or attach the patient id once known.
6. Pull side: decide with the owner whether other devices should show remote treatment and vitals values, or keep "מדדים אצל החובש" (V2.99.32). The minimum for this WP is that the data is on the server for command counts, AAR and analytics.

**Verify.** Update `browser_remote_patient_and_resupply_test.js` or add `browser_intake_sync_test.js`: two patients in a row on one device, each produces its own ordered events with the right `patient_id`. Live: WP-0 queries 2 and 3 before and after.

**Done when.** Every clinical fact entered at intake exists on the server under the right patient, for every patient, not only the first.

---

### WP-4: Alert acknowledgment is shared (P1)

**Why.** Pressing "בטיפול" (in treatment) only writes to the patient's local timeline and increases `p.unsyncedEvents`, which then never clears. Other devices still see the alert as unhandled. `PRODUCTION_READINESS.md` lists acknowledgment as required so commanders can tell "unseen" from "being handled".

**Evidence.** `acknowledgeAlert()` at `index.html` ~10292-10304; `watchdog_alerts.acknowledged_at` / `acknowledged_by` exist (`001` ~584); `WATCHDOG_ACKNOWLEDGED` is in the enum, the sync list and `sync-log`, but nothing projects it.

**Steps.**
1. Client: `acknowledgeAlert` calls `saveLocalEvent({type:'WATCHDOG_ACKNOWLEDGED', patient_id, payload_json:{alert_type, alert_id if known}})`; stop bumping `unsyncedEvents` by hand.
2. Server (per D4), `database/047_project_watchdog_acknowledged.sql`: an `AFTER INSERT ON events` trigger for `WATCHDOG_ACKNOWLEDGED` that sets `acknowledged_at` / `acknowledged_by` on the matching open `watchdog_alerts` rows for that patient (and alert type, if given). Follow `046` for grants.
3. Pull: add `alert_acknowledged_at` to the patient pull (new projected column or a separate query on `watchdog_alerts`) and show "בטיפול" with who and when on every device.

**Verify.** Browser test with two tabs: acknowledge on A, B shows it acknowledged. Live: WP-0 query 5.

---

### WP-5: Reinforcement and death-certification requests cross devices (P1)

**Why.** Requests for a doctor, paramedic, evacuation or death certification are saved under lowercase types (`medical_reinforcement`, `death_certification_request`) that no server code knows, so nobody else ever sees them. A physician never sees a death-certification request from another phone.

**Evidence.** `createMedicalResourceRequest` at `index.html` ~10983 (type set ~10987, saved ~11007); `reinforcementRequests` local array (55 references); `MEDICAL_REINFORCEMENT_REQUESTED` exists in no migration and not in `sync-log`.

**Design.** Copy the supply-request pattern exactly (`033`, `034`, `get_supply_request_queue`):
1. `database/048_medical_resource_requests.sql`: enum values `MEDICAL_REINFORCEMENT_REQUESTED`, `MEDICAL_REINFORCEMENT_STATUS_UPDATED`; table `medical_resource_requests` (incident, resource_type, urgency, reason_codes, linked_patient_ids, target_location, status, requested_by, assigned_to, timestamps, `origin_device_id`, `origin_client_request_id`, unique on the pair); projection trigger; status updates matched by the real request id (the lesson from `034`); `get_medical_resource_requests(p_incident_id)` `SECURITY DEFINER` RPC with `app.can_access_incident()`; visibility per D3.
2. `sync-log`: add both types with the roles from `AUTH_MATRIX` ("Request medical reinforcement").
3. Client: emit the new types; replace the local-only list with server data when logged in (keep local for demo mode); `assignReinforcementRequest` / `fulfillReinforcementRequest` (~6245, ~6255) emit status updates with the server id.
4. Death certification: physician dashboards list open death-certification requests from the server.

**Verify.** `browser_reinforcement_sync_test.js` with medic, PC and physician tabs. Live: RLS impersonation per role (positive and negative), `get_advisors` clean.

---

### WP-6: PC resupply decisions are shared (P2)

**Why.** "Approve from truck" and "escalate to CC" stay on the PC's phone, because `033` matched status updates by the creating device's id.

**Evidence.** Comment at `index.html` ~2900-2906; `RESUPPLY_APPROVED_FROM_PC_TRUCK`, `RESUPPLY_ESCALATED_TO_CC`, `PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED` emitted locally only; `034` already resolves by `payload_json.supply_request_id` for dispatch types.

**Steps.**
1. `database/049_...`: extend `project_supply_request_event()` so the PC decision types also resolve by `supply_request_id` first, and set the matching status / `request_level`. Check the exact type strings in `032`.
2. Client: carry `supply_request_id` (from the pulled queue) on these events and add them to the sync list.
3. CC and logistics boards show the PC's decision from the server.

**Verify.** Extend `browser_remote_patient_and_resupply_test.js` (medic, PC, CC). Live: the three-device chain used to verify `034`.

---

### WP-7: CC dashboard uses real platoons (P2)

**Why.** Since `045`, real platoons exist (`profiles.platoon_commander_id`), but the CC hero dashboard builds platoon tiles from `DEMO_PLATOONS` and counts every real patient under `PLT-A`.

**Evidence.** `DEMO_PLATOONS` at `index.html` ~3022 (19 uses), `renderCcHeroDashboard` ~6290-6293 (`p.assignedPlatoonId||'PLT-A'`); the real roster is read at ~6655.

**Steps.**
1. In logged-in mode, build platoons from the roster: one tile per PC profile, with its medics and the incidents that PC is a member of (one incident belongs to one platoon per `045`'s header).
2. Group patients by incident, then incident to platoon. Keep `DEMO_PLATOONS` only for local-demo mode.
3. Grep every other `DEMO_PLATOONS` / `DEMO_USERS` use and classify each as demo-only or needs real data; fix the logged-in ones or list them in this file.

**Verify.** Extend `browser_command_scope_test.js`: two PCs, two incidents, CC sees two correct tiles.

---

### WP-8: Rescue panel state crosses devices (P2, verify first)

**Why.** T0, building status and site clear are stored as events, but no projection to another device's rescue panel was found.

**Steps.** Use WP-0 query 6. If confirmed missing: `database/050_...` adds them to `incidents` (or `incident_command_state.state_json.site`) through the existing refresh trigger, and the client reads them through `get_incident_command_state`. If already present, close this WP with a note.

**Verify.** `browser_collapse_brief_test.js` pattern with rpc and pc tabs.

---

### WP-9: Inventory and consumption on the server (P2)

**Why.** `SUPPLY_CONSUMED` and `INVENTORY_LEDGER_MOVEMENT` never sync; truck and company stock are constants (`PC_TRUCK_BASELINE`, `COMPANY_STOCK_BASELINE`); burn rate describes one phone.

**Depends on.** D2.

**Steps.**
1. Per D2, archive the unused ledger table (rename or comment, do not drop data without the owner).
2. Map `SUPPLY_CONSUMED` and `INVENTORY_LEDGER_MOVEMENT` to the kept ledger via a projection trigger, using `client_item_key` from `035`.
3. Server RPC for stock per owner (medic bag, truck, company) and consumption events per incident, so `supplyBurnRatePer10Min` in `src/domain/rules.js` runs on incident-wide data.
4. Replace the baselines with server stock where it exists; keep them as initial values only.

**Verify.** Domain rule tests unchanged; new browser test for two medics consuming and logistics seeing the combined burn rate.

---

### WP-10: Offline cold start (P2)

**Why.** No service worker or manifest; `supabase-js` loads from jsDelivr (`index.html` ~593). Reloading with no signal loses the app, which contradicts offline-first.

**Steps.**
1. Add `sw.js` and `manifest.webmanifest` at the repo root (GitHub Pages serves them). Cache `index.html` and the pinned `supabase-js` URL; network-first for the page, cache-first for the pinned library; never cache Supabase API calls.
2. Register only on `https:` / `localhost`; skip on `file:`.
3. Version the cache with `APP_VERSION` so a new release replaces it.
4. Add the new files to `REQUIRED_PATHS`. Note the Phase 4 PWA decision in `PHASE_4_PLAN.md` and keep this minimal so it does not pre-empt it.

**Verify.** Playwright: load, go offline (`context.setOffline(true)`), reload, PIN gate appears and local data opens.

---

### WP-11: Smaller cross-device loose ends (P3)

One PR each, or grouped if small:
- `EXTERNAL_REPORT_LINKED`: emit when a report is linked to a patient; project to `external_reports`.
- MSTART sweep completion and colour overrides (`MSTART_SWEEP_COMPLETED`, `MSTART_SWEEP_COLOR_OVERRIDDEN`): decide synced or local-only and record it in the WP-1 contract.
- Dead man's switch: either emit `DEAD_MAN_SWITCH_ESCALATED` or remove it from the sync list; record the choice.
- Draft merge (`INCIDENT_DRAFT_MERGED`): server RPC plus UI, per spec sec 202-221.
- "Leave incident" action in the incident picker.
- `RECOMMENDATION_ACKNOWLEDGED`: classify in the contract.

---

### WP-12: Durable server watchdog (P3, larger)

**Why.** Overdue vitals and tourniquet timers are computed in each browser. If a phone goes silent, its timers stop for everyone. `FIELD_EXPERIMENT_GAPS.md` lists a backend watchdog as a gate.

**Steps.** A `pg_cron` job (pattern from `028`) every minute calling the existing `generate_tourniquet_reassessment_alerts` (`001` ~2232) plus a vitals-overdue equivalent, with idempotent dedupe on open alerts. Needs D1. Clients show server alerts next to local ones.

---

### WP-13: Tests in CI (P3)

Add a CI job running `npm ci`, then every `scripts/browser_*.js` with the pre-installed or `npx playwright install chromium` browser, and the 34 `scripts/smoke_*.js` scripts. Keep the existing two checks as a separate fast job.

---

### WP-14: Duplicate HTML and documentation drift (P3)

1. Per D5, stop maintaining two copies of `index.html` by hand.
2. Fix the drift found by the audit:
   - `CLAUDE.md`: "~8,600 lines" (now 13,501).
   - `FIELD_EXPERIMENT_GAPS.md`: says the scenario injector is missing (`scripts/inject_scenario.js` exists) and that there is no unit scoping (fixed by `045`); its tourniquet sentence should match WP-2's evidence.
   - `ARCHITECTURE.md`: says no platoon model exists (`045` added one); says `042` was verified only on local Postgres (commit `9a04de7` applied `042`-`045` live); the runtime table lists the Sync API as a doc only.
   - `PRODUCTION_READINESS.md`: "001 through 016" (now 046).
   - `ROADMAP.md` Phase 5: "8-role live enum" (now 10).

---

## Tracks outside this plan's PRs

These need a decision, people or money rather than a code change in this repo. Listed so nothing is lost:

- T1: Field usability sessions 1-4 (`FIELD_USABILITY_TEST_PLAN.md`), Session 2 first; it is the gate for Phase 4.
- T2: Clinical governance sign-off (`CLINICAL_GOVERNANCE_REVIEW_FRAMEWORK.md`); D1 feeds into it.
- T3: Command Actions and AAR API (`API_SURFACE_v1.2.md` sec 5-7): context notes, voice memos, final AAR generate/unlock, live timeline.
- T4: Executable migrations and the Phase 4 split (`PHASE_4_PLAN.md`).
- T5: Leaked-password protection (D6) and a key-rotation policy (`THREAT_MODEL.md` T5/T6).
- T6: QR handover as a scannable image, and a live click-through of `handover-consume`.
- T7: In-app disclosure that device presence tracks location (`PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md`).

## Status

| WP | Priority | Status | PR | Notes |
| --- | --- | --- | --- | --- |
| WP-0 Live baseline | - | Not started | | |
| WP-1 Event contract check | guardrail | Not started | | |
| WP-2 Tourniquets | P1 | Not started | | needs D1 |
| WP-3 Treatments, intake vitals, injuries | P1 | Not started | | |
| WP-4 Alert acknowledgment | P1 | Not started | | needs D4 |
| WP-5 Reinforcement / death-cert requests | P1 | Not started | | needs D3 |
| WP-6 PC resupply decisions | P2 | Not started | | |
| WP-7 CC real platoons | P2 | Not started | | |
| WP-8 Rescue panel state | P2 | Not started | | verify first |
| WP-9 Inventory on server | P2 | Not started | | needs D2 |
| WP-10 Offline cold start | P2 | Not started | | |
| WP-11 Small loose ends | P3 | Not started | | |
| WP-12 Durable watchdog | P3 | Not started | | needs D1 |
| WP-13 Tests in CI | P3 | Not started | | |
| WP-14 Duplicate HTML, doc drift | P3 | Not started | | needs D5 |

## Baseline results

Fill in from WP-0.
