# Gap Closure Plan

Working plan to close the gaps found by the feature-map audit of V2.99.33 (`main` @ `a4f6c81`, 2026-10-18). The audit traced every feature along one chain: recorded on the phone, sent through `sync-log`, stored or projected on the server, and seen on another device. Most gaps are places where that chain stops early, so a feature works on one phone but never reaches the commander.

This file is written to be handed to a fresh Claude Code session. Each work package (WP) is one small PR that can be done on its own, in the order below. Read [CLAUDE.md](../CLAUDE.md) and [MULTI_AGENT_DEV_PLAN.md](MULTI_AGENT_DEV_PLAN.md) first; their rules apply to every WP here.

## How to use this plan in a new session

Paste something like this into the new conversation:

> Read `docs/GAP_CLOSURE_PLAN.md` and `CLAUDE.md`. Do WP-N only. Before writing code, re-check the evidence lines listed for WP-N against the current code (line numbers drift), tell me anything that changed, and ask me about any open decision WP-N depends on. Then implement, run the checks listed under "Verify", and stop before merging.

Update the status table at the bottom of this file in the same PR that finishes a WP.

## Rules for every WP

- `index.html` is the only prototype file (WP-14 removed the `demo/rescue-app.html` copy, D5).
- Bump `APP_VERSION` and the visible version labels together, one version per merged PR. `check_repo.py` fails if they disagree.
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
| D1 | **Decided 2026-10-19 by the owner: the server rule is authoritative; the phone is aligned to it.** **Detail decided 2026-10-20 by the owner: the phone alerts itself, not through the server, and must work disconnected.** The phone keeps its 45/60/120 min alerts from its own clock and now actively raises them (vibration + banner, V2.99.42, `checkTourniquetTimeAlerts`), verified with the network off (`scripts/browser_tourniquet_offline_alert_test.js`). Original question: tourniquet timing has two different rule sets. The client (`src/domain/rules.js` `tourniquetTimer`) uses a 45 min notice, 60 min warning and 120 min critical from application. The server (`project_tourniquet_events()` in `database/001_postgresql_schema_v1.2.sql`, around line 1180) schedules reassessment every 30 min for crush/uncertain and 60 min for bleeding, clamped to 10-120. Which one is authoritative for remote devices and for server watchdogs? | WP-2, WP-12 | (a) show the client rule everywhere and keep the server value as data only; (b) align the server to the client; (c) clinical review first (`CLINICAL_GOVERNANCE_REVIEW_FRAMEWORK.md`) |
| D2 | **Decided 2026-10-21 by the owner: keep `inventory_ledger_v12`, archive v1.1** (rename, do not drop; both were empty live that day). v12's plain-text `item_type` matches the client's item keys, so no key-to-id mapping is needed. Original question: two inventory ledger tables, `inventory_ledger` (v1.1) and `inventory_ledger_v12`. Neither is written by the client today. | WP-9 | (a) keep `inventory_ledger_v12`, archive v1.1; (b) the reverse; (c) defer inventory sync |
| D3 | **Decided 2026-10-20 by the owner: command + physicians.** pc/cc/chamal/physician/admin of the incident see every request; whoever made a request sees their own. Physicians are in that set, so every physician sees death-certification requests (`database/052` RLS). Original question: who sees reinforcement and death-certification requests from other devices? | WP-5 | - |
| D4 | **Decided 2026-10-20 by the owner: both.** `WATCHDOG_ACKNOWLEDGED` is sent and a server projection marks `watchdog_alerts.acknowledged_at` / `acknowledged_by`, so every device sees the alert as handled. Original question: event only, or also mark the server row? | WP-4 | - |
| D5 | **Decided 2026-10-20 by the owner: remove the copy.** The two files were identical and having both caused confusion. `index.html` stays (GitHub Pages serves it as the live demo); `demo/rescue-app.html` was deleted and every check and test now reads `index.html` only. Original question: keep as a byte-identical copy, generate it, or replace with a redirect? | WP-14 | - |
| D6 | Supabase Pro plan, required for leaked-password protection. | Track T5 | Cost decision |
| D7 | Can the `admin` role record patients? `sync-log` allows admin every event type, but the `patients_insert` RLS policy allowed only medic/pc/paramedic/rpc/rcc, so an admin's patients were rejected (see Baseline results). | WP-0 part 2, WP-1 | **Decided 2026-10-19: admin may do everything**, matching `AUTH_MATRIX` in `index.html`. `database/047_admin_full_access.sql` adds admin to `patients_insert`, `high_risk_override_insert`, `death_confirmations_insert` and the physician-death guard in `project_patient_state()`. Follow-up decision the same day: admin also **wins** the concurrent-edit tie-break (`database/048`, rank above physician). Event log and audit tables stay append-only for every role, admin included (CLAUDE.md: never remove audit history). The rejected-patient warning on the phone (V2.99.35) is a separate part of the same fix. |
| D8 | **Decided 2026-10-22 by the owner: merge moves the data; CC, chamal and admin only. Revised the same day by D10: there are no drafts any more, so merge is for duplicate official incidents** (two medics opening the same event). The duplicate's patients and their records (tourniquets, requests, stock rows, memberships, ...) move into the target; colliding temporary patient ids are renamed; the duplicate's events are re-tagged to the target and stamped with the incident they were originally recorded in (a one-time, server-only, recorded exception to append-only, nothing deleted, no content changed); the duplicate is closed as merged into the target; `sync-log` redirects late pushes from offline phones to the target. | WP-11 part 2 | |
| D9 | **Decided 2026-10-22 by the owner: closing an incident ends access to its patients for everyone but admin, and stores an after-action report automatically.** Report: statistics only, no identities (counts by triage, timings, tourniquet times, evacuations by destination, MDA vs field counts, supply use, sync problems, per-unit breakdown; patients by temporary number only); command and everyone else read the report instead of the patients. Names and identifying descriptions are still erased only by the manual finalize (command), as today, until clinical governance (track T2) decides retention; finalize stays allowed on a closed incident. Reopening restores the previous access; the next close stores a new report version and keeps the old one. A "leave incident" button is dropped: it came from the 2026-10-19 audit, not the field, and its real concern (access kept after an incident ends) is covered by this decision. | WP-16 | |
| D10 | **Decided 2026-10-22 by the owner: no more draft incidents.** A medic or paramedic opens an official incident directly. Their PC, CC, RPC and RCC are informed automatically: a pulsing banner on their dashboards (who opened it, where, how many patients) until each of them acknowledges it (per person, stored on the server). Before opening, the phone lists open incidents of the medic's unit from the last hours ("join this instead?"); duplicates that still happen are merged per D8. The opener can cancel their own incident as a false alarm while it has no patients; after that, closing follows the existing rules (`040`). The medical company's structure is known from the start: every medic has a company and platoon before field use, so a medic without a unit is a setup error; as a safety net CC, chamal and admin (who see every incident) still get the banner, flagged "no unit". The incident gets the opener's company, and the opener's platoon when the roster gives the medic one; that platoon's RPC is informed. Without a platoon, the PC and RCC are informed and the banner asks them to choose the platoon. Revised by the owner the same day: every RPC of the company is informed too until the platoon is chosen, then only that platoon's RPC keeps the banner (`064d`); the banner gives header fields only, and an RPC still reaches the incident itself only through its platoon (`053`). Replaces the spec's draft path (`C5_SENTINEL_SAR_MVP_SPEC_v1.2.md` sec 2.1 Site Guard and the draft approval banner). | WP-11 part 2 | |

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
- ~~`EXTERNAL_REPORT_LINKED`: emit when a report is linked to a patient; project to `external_reports`.~~ Moved to WP-16 step 5 (linking later, owner 2026-10-22).
- MSTART sweep completion and colour overrides (`MSTART_SWEEP_COMPLETED`, `MSTART_SWEEP_COLOR_OVERRIDDEN`): decide synced or local-only and record it in the WP-1 contract.
- Dead man's switch: either emit `DEAD_MAN_SWITCH_ESCALATED` or remove it from the sync list; record the choice.
- ~~Draft merge (`INCIDENT_DRAFT_MERGED`): server RPC plus UI, per spec sec 202-221.~~ Replaced by D10 (2026-10-22): no drafts; a medic opens an official incident, PC/CC/RPC/RCC get a banner until acknowledged, duplicate warning at open, false-alarm cancel by the opener while empty (PR A), and merge of duplicate incidents per D8 (PR B).
- ~~"Leave incident" action in the incident picker.~~ Dropped by D9 (2026-10-22): access after closing is handled by WP-16.
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

**Done 2026-10-20** (see the status table). The list below is the original audit, kept for the record.

1. Per D5, stop maintaining two copies of `index.html` by hand.
2. Fix the drift found by the audit:
   - `CLAUDE.md`: "~8,600 lines" (now 13,501).
   - `FIELD_EXPERIMENT_GAPS.md`: says the scenario injector is missing (`scripts/inject_scenario.js` exists) and that there is no unit scoping (fixed by `045`); its tourniquet sentence should match WP-2's evidence.
   - `ARCHITECTURE.md`: the runtime table lists the Sync API as a doc only. (Its platoon-model sentence is fixed by V2.99.39. Its statement that `042` admin user management is not live is **correct**: checked live 2026-10-20, there is no `admin_user_audit` table and no `admin_set_user_role()`; the live migration named `042` is the evacuation enum, repo file `043`, because `043`-`046` were renumbered after being applied as `042`-`045`.)
   - `PRODUCTION_READINESS.md`: "001 through 016" (now 046).
   - `ROADMAP.md` Phase 5: "8-role live enum" (now 10).

---

### WP-16: Closing ends patient access and stores the after-action report (P2, needs D9)

**Why.** Today closing only stops new joins: every member keeps reading the incident's patients after the event (`AUTH_AND_ROLE_MODEL.md`), and the after-action review is computed live on each device, never stored (`aar_reports` is empty).

**Steps.**
1. On `close_incident()` (and the closing paths it guards), build a statistics-only report in SQL from the incident's own tables and store it in `aar_reports` (new version per close; nothing with a name or identifying description). Fields per D9.
2. RLS: patient-scoped tables (patients, events, tourniquets, treatment view, requests, ledger, ...) readable only while the incident is not closed, except for admin. `aar_reports` readable by the incident's command roles and admin, and by every member if decided later.
3. `reopen_incident()` restores access by status alone; the old report stays.
4. Client: a closed incident shows the stored report in place of the patient lists; finalize stays available to command.
5. Linking an external report to a patient later (`EXTERNAL_REPORT_LINKED`, PC and CC, from the report card; never changes triage or status) is built here (owner, 2026-10-22): the stored report then shows MDA vs field matching.

**Verify.** Live, rolled back: close with real accounts, each role's reads before/after, report contents have no identities, reopen restores; browser test with medic, PC, CC, admin.

---

### WP-15: Unused server tables and writes (P3)

**Why.** Checked live 2026-10-21: of 42 tables, 9 are empty and nothing reads or writes them (no client query, edge function, server function, view or trigger): `aar_reports`, `device_sync_state`, `experiment_observer_notes`, `high_risk_override_confirmations`, `patient_edit_conflicts`, `sync_event_dependencies`, `supply_request_items`, `treatment_catalog` (1 seed row), `treatment_inventory_items`. Each was replaced by another mechanism (phone-side sync cursor, events, `conflict_log`, `sync_ingestion_errors`, `supply_requests.items_json`, client constants) or belongs to an API never built (`aar_reports`, track T3). `realtime_outbox` is written by two triggers on every event (`apply_event_projection_and_outbox`, `draft_incident_approval_outbox`) and read by nothing (no realtime publication, no reader): an extra write per event and one more copy of patient data. Unused tables still cost RLS review and mislead new sessions into assuming they are wired.

**Steps.**
1. Re-check each table live (row count, references) right before the change; anything that gained a use moves off the list.
2. Move the unused tables to a new `archive` schema (`alter table ... set schema archive`), not dropped (owner's rule: no data dropped without the owner); no grants on `archive` for `anon`/`authenticated`. Keep `aar_reports` in `public`: WP-16 (D9) uses it.
3. Stop the `realtime_outbox` writes: replace the two trigger functions without the outbox insert (keep `apply_event_projection_and_outbox`'s `conflict_log` part unchanged), then archive the table with its 19 rows.
4. A new numbered file records the move (`001` is history and stays unedited). Update `RLS_AUDIT_v1.md` (policy count), `ARCHITECTURE.md`, and `analytics/.../export_live_incident.py` if it names a moved table (it lists `device_sync_state`).

**Verify.** Before/after: every browser test, a live rolled-back push of each synced event type (no trigger references a moved table), `get_advisors`.

### WP-17: Patients lost on a duplicate patient number (P0, found 2026-10-22)

**Why.** In the phone test on 2026-10-20 (device `PHONE-SPSZ`), an MSTART sweep of 10 casualties stored 1 patient. The other 9 `QUICK_PATIENT_CREATED` events and their `PATIENT_LOCATION_UPDATED` sit in `sync_ingestion_errors` with `events_patient_id_fkey`.

**Evidence.**
- `createTmpCasualtyId()` counted patients whose `id` starts with `TMP-`. Patient ids are UUIDs since the server sync, so every sweep marker was `TMP-001`.
- `patients` has `UNIQUE (incident_id, visual_id)`. `sync-log` took every unique violation (23505) for a retried push, so the second `TMP-001` was never created and its events failed the foreign key.
- `nextVisualId()` was `patients.length+1` per phone, so two medics offline in one incident could both make `P004` and lose the second patient the same way.

**Fix (V2.99.51).** Owner decision 2026-10-22: the id carries the initials of whoever registers the patient (medic, paramedic or first responder), in Latin letters and digits only (a Hebrew name is transliterated: `דני כהן` gives `DK`; fallback the email address, then the device id).
1. Client: signed in, `P004-DK` and sweep markers `TMP-004-DK`, numbered from the highest `visualId` already on the phone; local demo keeps plain `P004` / `TMP-004`. The sweep counter reads `visualId`, not `id`.
2. `sync-log`: on 23505, success only if this `patient_id` already exists. Otherwise create the patient as `<visual_id>-<last 4 of the device id>` (after a merge, of the duplicate incident's id, as before), log `patient_visual_id_renamed`, and return `patient_visual_id` on the accepted entry; after 5 failed names, reject with `PATIENT_CREATE_FAILED`.
3. Client: shows the server's id at once from the push reply and on every pull (this also brings `merge_incident()` renames to the phone that created the patient, which did not happen before), with a timeline note.

**Verify.** `scripts/browser_patient_number_test.js` (fails on the old client with `TMP-001,TMP-001,TMP-001`). Live, after deploying `sync-log`: one phone sweeps several casualties, and two accounts with the same initials each create a patient offline; all reach `patients`, none in `sync_ingestion_errors`.

**Not done.** The 9 patients already lost on 2026-10-20 are still unresolved rows in `sync_ingestion_errors`; their phone can resend them from the patient card after this fix is live.

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

### Backlog

- B1 (owner, 2026-10-21): Telegram notifications for critical alerts. Telegram first (free bot API, a server-side function sends the message when an alert is raised); WhatsApp later only if needed (needs Meta's Business API, approved templates, per-message cost). An extra channel only: the phone's own offline alert (D1) stays primary, since Telegram also needs a network. No patient details in the message (only "critical alert, incident X, open the app"), per `OPERATIONS_SAFETY.md` and the privacy review. Open questions for the owner before it starts: which alerts (proposal: 120-minute tourniquet, deterioration to red, death-certification request), and who receives them (role per incident).

## Status

| WP | Priority | Status | PR | Notes |
| --- | --- | --- | --- | --- |
| WP-0 Live baseline | - | Part 1 done 2026-10-19 | | live data too thin to confirm gaps; part 2 (scripted two-phone run) pending |
| WP-0b Admin full access | P0 | Done: 047 + 048 live and verified 2026-10-19 | #75, #76 | owner: admin may do everything (D7), wins tie-breaks; history stays append-only |
| WP-1 Event contract check | guardrail | Done | #77 | `src/domain/event-contract.json` + `check_repo.py`; 68 synced, 27 local-only, 18 alert types, 34 known gaps across WP-2b/3/5/6/7/8/9/11. Each WP removes its entries from `known_gaps` |
| WP-2 Tourniquets | P1 | Done: #73 (V2.99.34) + WP-2b (V2.99.42): 056/057/058 live, sync-log v9, verified 2026-10-20 | #73, this PR | WP-2b: later limb (`TOURNIQUET_LIMB_RECORDED`), effectiveness as `TOURNIQUET_REASSESSMENT`, handover closes the row, vitals-modal tourniquet starts a real one; release on typo-cancel was already in #73. D1 detail decided: the phone alerts on its own clock, offline too |
| WP-3 Treatments, intake vitals, injuries | P1 | Done (V2.99.37) | #80 | treatments as `INTERVENTION_RECORDED`/`AIRWAY_MANAGED`, intake medications and pediatric overrides patient-scoped after the create event, injury zones in the create payload, vitals-modal medications; verified live (rolled back). Follow-up: `vw_patient_treatment_history` does not list `AIRWAY_MANAGED`; vitals-modal tourniquet is WP-2b |
| WP-4 Alert acknowledgment | P1 | Done (V2.99.40): 054 live, verified 2026-10-20 | this PR | per patient, as the client's alerts are: `patients.alert_acknowledged_*` plus `watchdog_alerts.acknowledged_*`; re-escalation (red/black triage, critical vitals) clears it everywhere via `WATCHDOG_ALERT` reason `reescalated`; patient card shows who and when |
| WP-5 Reinforcement / death-cert requests | P1 | Done (V2.99.38): 051 + 052 live, sync-log v8 deployed, verified 2026-10-20 | this PR | `medical_resource_requests` + RLS per D3; status updates by server id from any device; physician death confirmation resolves the request. Still local: `PC_REVIEW_REQUESTED_FOR_DETERIORATION` (a PC review request is not a resource request; kept under `known_gaps` WP-5) |
| WP-6 PC resupply decisions | P2 | Done (V2.99.43): 059 live, verified 2026-10-21 | this PR | the three decision types synced; PC/CC decide a medic's request on the shared queue row by its server id; only pc/cc/admin change the row; the requester's phone follows the decision; logistics is not asked to dispatch what the PC truck fills. Not done: CC-side "fulfilled by company" / "closed" stay local (no server status for them); a medic's `RESUPPLY_REQUEST_ESCALATED_CC` is still projected at the `medic_to_pc` level (033) |
| WP-7 CC real platoons | P2 | Mostly done (V2.99.42, `database/053`): applied live by the owner 2026-10-20, every 053 function, trigger and policy confirmed present; no companies or platoons created yet | #82, #86 | real `companies` and `platoons` (3 rescue companies x 3 platoons, plus the ambulance team) instead of 045's medic-to-PC link; first one-company version (#82) rewritten before it was applied; CC tiles/rows/counts from real platoons; roster panel; rpc platoon scope and rescue clinical block added at the owner's request. Remaining: `PATIENT_REASSIGNED_*` (moving a patient to another platoon means another site; not modelled) |
| WP-8 Rescue panel state | P2 | Done (V2.99.44): 060 live, verified 2026-10-21 | this PR | verified first: incident type already crossed (`incidents.incident_type`), close/reopen too; T0, building status and site clear were stored as events but never read back. Now projected into `incident_site_authority` (only rpc/rcc/admin change it) and read by every phone in the incident. `SITE_EXTRACTED_COUNTER_UPDATED` is no longer written (pre-evacuation report replaced it); `INCIDENT_TYPE_SET` classified local-only. Follow-up: a signed-in medic's incident type and `INCIDENT_TYPE_MISMATCH_REPORTED` still stay on the medic's phone |
| WP-9 Inventory on server | P2 | Done (V2.99.46): 061 + 062 live, verified 2026-10-21 | this PR | per D2: v1.1 renamed `inventory_ledger_v11_archived` (writes revoked); `INVENTORY_LEDGER_MOVEMENT` projected into `inventory_ledger_v12` with owner (medic bag / PC truck), count after the movement and the phone's time; `SUPPLY_CONSUMED` synced as audit only (no double count); direct client inserts closed; negative-stock alert per bag. Logistics/CC get incident-wide burn rate, each bag's and truck's latest count. Not done: company stock is still the `COMPANY_STOCK_BASELINE` constant (no flow changes it); starting quantities stay client constants (`SUPPLY_BASELINE`, `PC_TRUCK_BASELINE`), used only as initial values; `vw_command_inventory_burn_rate_v12.current_stock_available` sums deltas only, so it is not a stock figure |
| WP-10 Offline cold start | P2 | Done (V2.99.45) | this PR | `sw.js` (network-first page with a 4 s fallback, cache-first pinned supabase-js, never Supabase API calls, cache named by `APP_VERSION`), `manifest.webmanifest`, `icon.svg`; `check_repo.py` keeps the pinned URL equal in both files. Found while testing: a signed-in phone fell back to the login screen offline (profile read failed), so the last profile is now kept encrypted and used only when the server cannot be reached; re-checked when the network returns; removed on sign-out. Not verified yet on a real Android/iOS install |
| WP-11 Small loose ends | P3 | Part 1 done (V2.99.47): 063 live, sync-log v10, verified 2026-10-21. Part 2 PR A done (V2.99.48): 064 live, verified 2026-10-22. Part 2 PR B done (V2.99.50): 066 + 067 (live names 065/066) live, sync-log v11, verified 2026-10-22 | #93, #94, this PR | a manual sweep colour override is sent as `MSTART_OVERRIDE` (server: `conflict_log` with MSTART's colour, the medic's and the reason); `MSTART_SWEEP_COMPLETED` synced and shown on the PC's sweep board from its own events query; the sweep summary names the signed-in medic (it said the demo medic); `MSTART_SWEEP_COLOR_OVERRIDDEN`, `PATIENT_MARKED_NOT_SALVAGEABLE`, `SUSPECTED_NOT_SALVAGEABLE_CANCELLED`, `PRIORITY_RECOMMENDATION_DECLINED`, `RECOMMENDATION_ACKNOWLEDGED` classified local-only with reasons; `DEAD_MAN_SWITCH_ESCALATED` removed from the sync list (never written; WP-12 owns it). Part 2 PR A (D10): no drafts; a medic opens an official incident after a "join this instead?" list of the company's open incidents; PC, RCC, every RPC of the company until the PC or RCC chooses the platoon from the banner (then that platoon's RPC), and CC/chamal/admin get a banner until each acknowledges; the opener can cancel an empty incident as a false alarm. PR B (D8): CC, chamal or admin merge a duplicate incident from the picker (`merge_incident`, reason required): patients and their records move, colliding temporary ids are renamed and reported, events are re-tagged with `origin_incident_id`, the duplicate is closed as merged; `sync-log` v11 stores late pushes for the duplicate in the target and answers `redirected_to`; phones in the duplicate switch to the target. `EXTERNAL_REPORT_LINKED` moved to WP-16 (linking later); "leave incident" dropped (D9) |
| WP-12 Durable watchdog | P3 | Not started | | needs D1 |
| WP-13 Tests in CI | P3 | Not started | | the 34 smoke scripts pass again (WP-14), so they can be wired in |
| WP-14 Duplicate HTML, doc drift | P3 | Done (2026-10-20) | | D5: `demo/rescue-app.html` removed. Visible labels were stuck at V2.9934 since V2.99.34; fixed to match `APP_VERSION` and `check_repo.py` now checks them against `APP_VERSION`. Smoke scripts refreshed: no version pins (`scripts/lib/smoke_version.js`), stale assertions updated to the commits that changed the behaviour; all 34 pass. Docs: CLAUDE.md, README, DEVELOPMENT, ARCHITECTURE, PHASE_4_PLAN, ROADMAP, THREAT_MODEL, PRODUCTION_READINESS, FIELD_EXPERIMENT_GAPS |
| WP-16 Close ends access + stored AAR | P2 | Not started (D9 decided 2026-10-22) | | |
| WP-15 Unused server tables | P3 | Not started (added 2026-10-21 at the owner's request) | | 8 unused tables to an `archive` schema (`aar_reports` stays, WP-16), stop the never-read `realtime_outbox` writes; nothing dropped |
| WP-17 Lost patients on a duplicate number | P0 | Client and `sync-log` v12 done (V2.99.51); `sync-log` v12 not deployed yet (live: v11) | this PR | found by the 2026-10-22 feature-map audit from live `sync_ingestion_errors`; ids carry the registrant's initials (owner decision); the server renames a clash instead of dropping the patient |

## Revisions after #73 (2026-10-19)

The plan was written against V2.99.33 (`a4f6c81`). PR #73 (V2.99.34) merged after it. Re-checked against `main` @ `02198e1`:

- **WP-2** is mostly done by #73: every entry path sends a patient-scoped `TOURNIQUET_APPLIED` (`queueTourniquetAppliedEvent`), other devices read active `tourniquets` rows (`applyServerTourniquets`), and a typo-cancel sends `TOURNIQUET_RELEASED`. Remote devices run the client `tourniquetTimer` from the server `applied_at`, which in practice is D1 option (a) for display; D1 is still open for the server reassessment schedule (WP-12). Remaining, now **WP-2b**: a real (non-typo) release, `TOURNIQUET_REASSESSMENT` and `TOURNIQUET_CONTEXT_UPDATED` are never sent; `TOURNIQUET_LIMB_RECORDED` stays local; a handed-over patient's tourniquet row stays active; the live two-device check of #73 has not run.
- **WP-3** step 1 is not needed. `queueEventOnce` checks `state.localEvents`, and `startNewPatient()` resets `state` with `freshState()` for every patient, so it is per patient, not per device. Intake vitals are done by #73. New: `queueMedicationEventsBeforeSave()` sends `MEDICATION_ADMINISTERED` before `PATIENT_CREATED` and with no `patient_id`, including pediatric high-risk overrides; it is on the sync list, so it is pushed but cannot be placed. Treatments (`INTERVENTION_LOGGED`, `IMMEDIATE_INTERVENTION_RECORDED`, `LIFE_SAVING_ACTION_RECORDED`, vitals-modal `TREATMENT_NEEDED_RECORDED`) and injuries (`PATIENT_INJURY_UPDATED` never sent) are unchanged.
- **WP-5** root cause wording: the client already uses the event types `MEDICAL_REINFORCEMENT_REQUESTED` and `MEDICAL_REINFORCEMENT_STATUS_UPDATED`; the lowercase strings are the request's internal `type` field. Neither event type is in the enum, `sync-log` or `SYNC_ELIGIBLE_EVENT_TYPES`, so `saveLocalEvent` marks them synced at once and they never leave the phone. The design is unchanged.
- **Order** after WP-0 and WP-1: WP-3 (client only, fixes high-risk dose records), WP-5, WP-4, WP-2b, then P2 and P3 as listed.
- **2026-10-20:** WP-3 step 6 decided by the owner: other devices show remote treatments. **Done (V2.99.41, `database/055`):** the view now also lists `AIRWAY_MANAGED` (closing the WP-3 follow-up) and carries `device_id`; the patient card lists other devices' treatments in their own section; verified live (rolled back).
- **WP-14** drift still present: `index.html` is now 13,595 lines; `FIELD_EXPERIMENT_GAPS.md` still says the injector and unit scoping are missing.

## Revisions after V2.99.36 (2026-10-20)

- **`main` failed `scripts/check_repo.py` for a while** after #77 (event contract) and #78 (pre-evacuation) merged without seeing each other: `SITE_PRE_EVACUATION_REPORTED` was in `SYNC_ELIGIBLE_EVENT_TYPES` and `sync-log` but not in the contract. Fixed on `main` by #80/#81 (seen 2026-10-20). Worth a branch-protection rule that requires the `validate` check to pass before merge.
- **`database/042` (admin user management) was not on the live project** until the owner applied it on 2026-10-20 (the `admin-users` function was deployed the same day; see `RLS_AUDIT_v1.md`). Kept for history: The in-app "ניהול משתמשים" screen's role change / deactivate RPCs and `admin_user_audit` do not exist live; the `admin-users` Edge Function is not deployed either (live functions: `sync-log` v8, `handover-consume` v2), so the whole screen fails on the live project and onboarding still needs `scripts/invite_user.js`. Owner decision needed before applying it. **Applied live by the owner 2026-10-20**, and `admin-users` deployed (v1): `admin_user_audit`, `admin_list_users()`, `admin_set_user_role()`, `admin_set_user_active()` and the profiles audit trigger confirmed present.
- **The 34 `scripts/smoke_*.js` scripts all fail on `main`**: each pins an old `APP_VERSION` (e.g. "must be V2.9916"). Add to WP-13: refresh or retire them before wiring them into CI. (Refreshed in WP-14; all 34 pass.)
- **WP-7** mostly done together with real companies and platoons (`database/053`, V2.99.42); see the status table.

## Baseline results

### Part 1: read-only queries, 2026-10-19

Run with the Supabase MCP connector against project `c5-sentinel-sar`, across all incidents (there are only four).

| Incident | Status | Events | Devices | Patients | Notes |
| --- | --- | --- | --- | --- | --- |
| `INC-261018-854D1D` | active | 1 | 1 | 0 | opened 2026-10-18, no activity |
| `INC-261016-668987` | active | 1 | 1 | 0 | used for the 2026-10-17 and 2026-10-18 phone tests; every patient rejected (below) |
| `TEST-INC-A` | closed (`039`) | 25 | 14 | 5 | August RLS test data |
| `TEST-INC-B` | closed (`039`) | 1 | 1 | 0 | August isolation check |

The whole `events` table holds 28 rows: 26 from August, 2 from October (both `INCIDENT_OPENED`).

| Query | Result |
| --- | --- |
| 1. Event types stored | `BUILDING_STATUS_UPDATED` 3, `FIRST_RESPONDER_REPORT` 2, `INCIDENT_OPENED` 2, `MEDICATION_ADMINISTERED` 2, `NOTE_ADDED` 1, `PATIENT_HANDED_OVER` 4, `PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED` 1, `QUICK_PATIENT_CREATED` 1, `RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE` 4, `SUPPLY_REQUEST_DISPATCHED` 2, `SUPPLY_REQUEST_IN_TRANSIT` 3, `SUPPLY_REQUEST_RECEIVED` 2, `VITALS_RECORDED` 1 |
| 2. Clinical events stored without a patient | 0 (a missing `patient_id` is rejected before storage, so these appear in `sync_ingestion_errors` instead) |
| 3. Patients with no server vitals | `TEST-INC-A`: 4 of 5 |
| 4. `tourniquets` rows | 0 total, 0 active |
| 5. `watchdog_alerts` acknowledged | 1 of 2 (August test data) |
| 6. Building status / site clear | 3 `BUILDING_STATUS_UPDATED` (August, payload `{status}` only), no `SITE_CLEAR_CONFIRMED`; `incident_command_state.state_json` has only `sectors` and `summary`, nothing for building or site state. WP-8 is confirmed. |
| New: `MEDICATION_ADMINISTERED` without patient | 0 stored |
| New: `tourniquets` rows since #73 | 0 (no client test since the merge) |
| New: `sync_ingestion_errors`, unresolved | 18 rows, all unresolved (8 from August, 10 from October, below) |

`sync_ingestion_errors` since 2026-10-01, all in `INC-261016-668987`:

| When (UTC) | Device | Event | Error |
| --- | --- | --- | --- |
| 10-17 19:01 to 19:01:50 | PHONE-SPSZ | `QUICK_PATIENT_CREATED` x3 | `PATIENT_CREATE_FAILED`: new row violates RLS on `patients` |
| 10-17 19:01 to 19:09 | PHONE-SPSZ | `TOURNIQUET_APPLIED`, `VITALS_RECORDED`, `PATIENT_HANDED_OVER` x2 | FK `events_patient_id_fkey` (the patient was never created) |
| 10-18 10:51 to 10:52 | PHONE-LTKE | `QUICK_PATIENT_CREATED` x2 | same RLS rejection |
| 10-18 10:51 | PHONE-LTKE | `TOURNIQUET_APPLIED` | same FK error |

**Root cause of the October rejections.** Both phones were logged in with an `admin` account (active, a member of the incident, its opener). `patients_insert` allows only `medic`, `pc`, `paramedic`, `rpc`, `rcc`, while `sync-log` allows admin every event type, so the event passes the Edge Function and fails in the database. Every later event for those patients then fails its foreign key. The phone shows this only as a "נדחו" count in the sync pill and a red toast for high-stakes events. This is a testing setup issue, not a medic-path bug, but it means no phone test has ever stored a patient through the current client. Decision D7 (decided: admin may do everything, `database/047`).

**What this means for the plan.** The live data cannot confirm or refute the client-side gaps: there is no successful field test to measure. The code evidence stands. Part 2 below produces a real baseline.

### Part 2: scripted two-phone run (pending)

Two phones (or two browsers), logged in as a real `medic` and a real `pc` account (not admin), in one new incident, about 10 minutes:

1. Medic: full-flow patient with vitals, one treatment, morphine, a tourniquet on a known limb.
2. Medic: quick capture with a tourniquet, limb recorded later.
3. Medic: MSTART immediate casualty marked black (auto death-certification request).
4. Medic: resupply request. PC: approve from truck.
5. PC: request a doctor. Either: acknowledge an alert ("בטיפול").
6. Medic: hand over the first patient.

Then rerun the Part 1 queries for that incident, plus `sync_ingestion_errors` for it. Each WP is then marked confirmed, changed or not needed here.
