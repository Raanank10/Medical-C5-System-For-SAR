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
- New SQL goes in a new numbered file (round 1 started at `database/047_...`; for round 2 see "Numbering in this round"). Never edit an applied migration. Every new trigger function: `SECURITY DEFINER`, `set search_path`, and `revoke execute ... from public, anon, authenticated` (see `046`). Run `get_advisors` after applying.
- Any new event type must be added in four places at once: the `event_type` enum (migration), `ROLE_ALLOWED_EVENT_TYPES` in `supabase/functions/sync-log/index.ts`, `SYNC_ELIGIBLE_EVENT_TYPES` in the HTML, and the contract list from WP-1.
- Apply migrations through the Supabase connector (`apply_migration`) or the Supabase CLI, never by pasting into the dashboard SQL editor (owner 2026-11-21). A paste is not recorded in the live migration list (WP-35), and a long file pasted from a phone was auto-indented line by line until it was cut off mid-function (`090`, 2026-11-20: "unterminated dollar-quoted string"; nothing was applied). Name the migration after the repo file (`090_incident_types_ladder`).
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
| D9 | **Decided 2026-10-22 by the owner: closing an incident ends access to its patients for everyone but admin, and stores an after-action report automatically.** Report: statistics only, no identities (counts by triage, timings, tourniquet times, evacuations by destination, MDA vs field counts, supply use, sync problems, per-unit breakdown; patients by temporary number only); command and everyone else read the report instead of the patients. Names and identifying descriptions are still erased only by the manual finalize (command), as today, until clinical governance (track T2) decides retention; finalize stays allowed on a closed incident. Reopening restores the previous access; the next close stores a new report version and keeps the old one. Details decided the same day: phones remove a closed incident's patients once every record they made has synced (never an unsent one); records arriving after the close are accepted and stored, and the report says how many; the report is read by the incident's members and its command roles. A "leave incident" button is dropped: it came from the 2026-10-19 audit, not the field, and its real concern (access kept after an incident ends) is covered by this decision. | WP-16 | |
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
6. Pull side: decide with the owner whether other devices should show remote treatment and vitals values, or keep "מדדים אצל החובש" (V2.99.32). Treatments shown since V2.99.41; vitals values since V2.99.54 (owner, 2026-10-22). The minimum for this WP is that the data is on the server for command counts, AAR and analytics.

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

**Done (2026-10-22, V2.99.58, `database/072`).** Owner decisions 2026-10-22: tourniquet alerts use the phone's levels from time on the limb (45 min heads-up, 60 min warning, 120 min critical; D1), not the 30/60 min reassessment schedule, which stays data only (`generate_tourniquet_reassessment_alerts` is left uncalled); vitals overdue for red and yellow with the phone's intervals (10 / 20 min; pending and unknown count as red, as on the phone; green stays phone-only); command and the medic see them. `app.run_clinical_watchdog()` runs every minute from `pg_cron` (`clinical-watchdog`) over every incident that is not closed: it raises `TOURNIQUET_TIME_NOTICE` / `_WARNING` / `_CRITICAL` (highest level reached, each level once per tourniquet; a higher level resolves the lower) and `VITALS_OVERDUE` (once per vitals reading, from `last_vitals_at` or, with none, the patient's creation), resolves its own alerts that no longer apply (released tourniquet, newer vitals, triage green/black, patient handed over / evacuating / deceased / closed / self-evacuated), and refreshes `incident_command_state` for the incidents it changed. One incident's failure does not stop the others; clients cannot call it. `silence_resolved_watchdogs_for_event()` (called from the tourniquet projection) also resolves the new tourniquet types on release; a handover and new vitals are picked up by the next run. Client: `pullServerWatchdogAlerts` (with the 45 s incident pull) reads the open ones; a server alert is listed, marked "(שרת)", only when the phone does not already raise the same thing from its own data (tourniquet not known here or its own timer below that level; vitals not overdue here and no newer vitals here than the server's). Verified live in a rolled-back block before applying (raise, idempotent second run, level step-up, release, new vitals, command state count, a non-member reads nothing, a client call is refused); after applying, the job ran every minute in about 20 ms and raised 2 vitals alerts in the one open test incident, once. `scripts/browser_server_watchdog_test.js` covers the client. Not built: an outside channel when no phone is open (B1), and the Dead Man's Switch escalation (`DEAD_MAN_SWITCH_ESCALATED`) as a server job.

---

### WP-13: Tests in CI (P3)

Add a CI job running `npm ci`, then every `scripts/browser_*.js` with the pre-installed or `npx playwright install chromium` browser, and the 34 `scripts/smoke_*.js` scripts. Keep the existing two checks as a separate fast job.

**Done (2026-10-22).** `browser-and-smoke-tests` job in `.github/workflows/validate.yml`: `npm ci`, `npx playwright install --with-deps chromium`, `npm test` (`scripts/run_tests.js`: 30 browser tests, 2 other test scripts, 34 smoke scripts, each in its own process with a 5-minute limit; prints a summary and fails if any fails). `repo-check` unchanged. Branch protection (requiring the job before merge) is a GitHub setting for the owner. The analytics `pytest` suite is not in this job. Since 2026-10-23 it installs only the headless shell the tests launch (`npx playwright install --only-shell chromium`, browsers cached by Playwright version) instead of `--with-deps`, whose apt-get step took 11-13 minutes on most runs.

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
5. Linking an external report to a patient later (`EXTERNAL_REPORT_LINKED`, PC and CC, from the report card; never changes triage or status) is built here (owner, 2026-10-22): the stored report then shows MDA vs field matching. Done in PR B (`database/069`, V2.99.53): the same roles that create reports (also chamal, physician, admin) link and unlink; direct client writes to the two tables were closed in the same change.

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

### WP-18: Evacuation point: moving vs arrived, and how long patients wait (P2, owner 2026-10-23)

**Why.** Owner, 2026-10-23: each site has its own evacuation point (נקודת פינוי), where rescued patients wait for an ambulance and where the PC truck and its supplies stand. Command must tell apart patients still at the extraction site, patients the rescuers are moving to the evacuation point, and patients evacuated by MDA. Patients leave the evacuation point only with MDA; the company's ambulance carries the doctor between the company's sites (owner, 2026-10-23). V2.99.62 shows three stages per site (extraction site / evacuation point / evacuated) from the existing `evacuating` status, and renamed "נקודת איסוף פלוגתית" to "נקודת פינוי" in the UI and docs.

**Gap.**
1. One status covers both "being moved to the evacuation point" and "waiting there"; there is no "arrived" step.
2. Nothing records when a patient reached the evacuation point. `lastModifiedAt` changes on every update and local event times are HH:MM on the phone only, so the panel cannot show how long a patient has been waiting for an ambulance (and does not try).
3. The PC truck stock is one stock per phone (demo) or per platoon (live), not tied to a site's evacuation point.
4. ~~Should patients waiting at the evacuation point be ranked for ambulance assignment?~~ Decided by the owner 2026-10-23: they are not for the company's ambulance, which is in practice a taxi for the doctor between the company's sites; they wait for MDA, and they stay on the evacuation-to-hospital list (`companyEvacuationPriorityRows`, "תעדוף פינוי") whatever their rank, marked "בנקודת פינוי", with patients still at the extraction site marked "באתר החילוץ". The ranking is unchanged; more than 8 entries add a "+N" row instead of disappearing silently.

**Decided since (owner, 2026-10-23/24, V2.99.64).** Open-evacuation counts and both risk scores count patients until MDA takes them, split "at the extraction site" / "waiting for MDA". A free patient usually stays at the extraction site because civilian ambulances are short; PC and CC both ask for more. The rescuers carry patients to the evacuation point; medical staff treat trapped patients before extraction; CC can add medics or send the physician's ambulance.

**Decided (owner, 2026-10-24).** A new event, not a new status: `PATIENT_EVAC_POINT_ARRIVED`, projected by its own trigger. Any medic, paramedic, physician or PC in the incident may mark it (incident = site, one platoon per incident); CC does not. Other medics see it on the board and patient card on the next sync, no pop-up. Waiting time is shown only, no alert until the owner sets a threshold. Gap 3 (truck stock per evacuation point) stays out of this WP.

**Done (V2.99.66, `database/076` + `077`, `sync-log` adds the type to `CLINICAL_EVENTS`).** Renumbered from 075/076 when main's `075_events_actor_role_bound_and_advanced_procedures` merged first; 076 is live under the name `075_evac_point_arrival_enum`.
1. Status stays `evacuating` for both steps, so triage authority (021/041), views and the rescue board are unchanged. Arrived = `evacuating` and `patients.evac_point_arrived_at` set.
2. `project_evac_point_arrival()` (trigger `trg_project_patient_state_evac_point`, fires after `trg_project_patient_state`): arrival time from the event's phone time, never later than the server clock, earliest wins; role in `evac_point_arrived_role`. A later status that is neither `evacuating` nor final sets `evac_point_cleared_at` and clears an earlier arrival; arrivals recorded before it are ignored. Final statuses keep the time for the report.
3. Client: the patient bar shows "יצא לנקודת פינוי", then "הגיע לנקודת פינוי", then handover; the location board lists "בדרך לנקודת הפינוי" (with a "הגיע לנקודה" button for medics and the PC) apart from "ממתינים לפינוי מד״א" with minutes per patient and the longest wait; the funnel has four stages; the evacuation-to-hospital list says "בדרך" or "בנקודת פינוי · ממתין N דק׳"; the ambulance advice still counts both (they all wait for MDA) and names the longest wait. Pulled with its own query (`pullEvacPointArrivals`), so a database without 077 breaks nothing.

**Verify.** `scripts/browser_evac_point_arrival_test.js`: medic sends a patient out, the PC sees it on the way and marks the arrival, a second medic's earlier offline arrival pushed late wins, CC sees a 6-minute wait and cannot mark, a cleared arrival clears on the phone. Live (2026-10-24): 076 applied by Claude (live name `075_evac_point_arrival_enum`), 077 applied by the owner in the SQL editor (function body matches the file apart from indentation), `sync-log` deployed as v16 (live v15 plus the one type), 078 revokes the trigger function from `anon`/`authenticated` after `get_advisors` flagged it. Rolled-back live run on a real patient: PC arrival stored with role `pc`; an earlier medic arrival pushed late wins; a future phone time is ignored; a later `stabilizing` status clears the arrival; an older arrival pushed after that is ignored; nothing persisted. Not yet seen: a push from real phones through `sync-log` v16 (the session's network cannot reach the function).

**Not done.** The rescue board RPC (`get_rescue_patient_board`, 074) still says "בפינוי" for both steps; the stored report (`aar_reports`) does not include waiting time yet; gap 3 (truck stock per evacuation point).

---

## Round 2: gaps from the V2.99.71 feature map (2026-11-14)

The feature map was rebuilt on 2026-11-13 against `main` @ `0d79abc` (V2.99.71), the open PR #128 and the live project (read-only queries). Most of round 1 is built and has run on phones (202 events, 27 patients, 11 tourniquets, 5 stored reports, 28 server watchdog alerts live). What is left is below, one WP per new conversation, same rules as above.

**Numbering in this round.** PR #128 takes V2.99.72 and `database/080`, `081`. The first WP of this round to merge takes V2.99.73 and `database/082`; after that, take the next free version and file number from `main` right before merging, not when starting (parallel sessions have collided on both several times: #110, #119, #120, #125, #126, #127).

**Order.**
1. WP-19 first. (WP-20 is done: #128 merged, 079-081 and `sync-log` v17 live.)
2. WP-21 (the live two-phone run) after both, so it tests the fixed stock path and the 100-minute alert.
3. WP-22 after WP-19, so the rejected stock movements can be resent instead of closed.
4. WP-23 to WP-27, one at a time (they all touch `index.html`; owner decisions from 2026-10-23).
5. WP-29 builds on 081's `run_clinical_watchdog()` (live since WP-20).
6. WP-28, WP-30, WP-31 and WP-33 wait for an owner answer; ask it first in the session.
7. WP-32 and WP-34 to WP-37 any time.
8. WP-38 after WP-19 (owner 2026-11-18); WP-24 touches the same flow.

| Round 2 WP | Title | Priority | Needs from the owner first |
| --- | --- | --- | --- |
| WP-19 | Stock movements reach the server | P1 | - |
| WP-20 | Finish PR #128 and apply 079-081 | P1 | - (done 2026-11-17) |
| WP-21 | Live two-phone run (WP-0 part 2) | P1 | people and two phones |
| WP-22 | Close or resend the open sync rejections | P2 | approval per group |
| WP-23 | Injury time editable in the field | P2 | - (decided 2026-10-23) |
| WP-24 | Command cancels a resupply request (was: CC "fulfilled by company" / "closed") | P2 | - (decided 2026-11-18) |
| WP-25 | Medic incident type and mismatch report synced | P2 | - (decided 2026-10-23) |
| WP-26 | PC deterioration review request synced | P2 | - (decided 2026-10-23, shape 2026-11-19/21) |
| WP-27 | CC moves a site's patients to another platoon | P2 | one design question |
| WP-28 | The 27 never-sent event types | P2 | build / keep / remove per type |
| WP-29 | Dead Man's Switch on the server | P2 | recipients |
| WP-30 | Telegram critical alerts (B1) | P2 | the 19 alert answers, a bot |
| WP-31 | MARCH completion rule and hands-on PC | P2 | clinical criteria |
| WP-32 | Evacuation point leftovers (WP-18) | P2 | - |
| WP-33 | CC all-incidents: what counts as an alert | P3 | - (answered 2026-11-18) |
| WP-34 | Test gaps: AAR screen, analytics pytest in CI | P3 | - |
| WP-35 | Record what is applied live | P3 | - |
| WP-36 | Demo constants in signed-in paths | P3 | - |
| WP-37 | External report unlink tombstone | P3 | - |
| WP-38 | A resupply delivered to a medic raises the bag | P2 | one design question |
| WP-39 | The evacuation point is called נאפ"ל | P2 | - (decided 2026-11-18) |
| WP-40 | 30 minutes waiting at the נאפ"ל alerts PC and CC | P2 | - (decided 2026-11-19) |
| WP-41 | Medical staff see a patient sent to / arriving at the נאפ"ל | P2 | - (decided 2026-11-19) |

---

### WP-19: Stock movements reach the server (P1, found 2026-11-13)

**Why.** No medic-bag stock movement has ever been stored. `inventory_ledger_v12` has 0 rows live, so logistics and CC see no incident-wide burn rate and no bag counts (WP-9 works only in stubbed tests). `SUPPLY_CONSUMED` (18 stored) is audit only by design, so it does not count.

**Evidence.**
- `consumeFieldSupply()` (`index.html` ~17247) builds `INVENTORY_LEDGER_MOVEMENT` with `patient_id: state.patientDraftId || patientId` (~17285). `freshState()` (~4846) always sets `patientDraftId` to `draft-<time>-<id>`, so every movement carries a draft id, also when a saved patient is open.
- `saveLocalEvent()` (~14415) copies `payload_json.patient_id` to the top-level `patient_id`, so the event row gets a non-UUID patient id and the insert fails: 19 rows in `sync_ingestion_errors`, Oct 22-25, `MALFORMED_EVENT_ENVELOPE`, `invalid input syntax for type uuid: "draft-..."`.
- Intake: `savePatient()` calls `queueInventoryBeforeSave(newId)` (~12244), where `newId` is the visible number (`P004-DK`), not `patientUuid`, and before `PATIENT_CREATED` is queued.
- `LOCAL_STOCKOUT_WARNING` (~17299) and `SUPPLY_CONSUMED` (~17260) use `patientId || state.patientDraftId`, so they hit the same problem whenever `patientId` is missing or is a visible number.
- The server side is fine: `project_inventory_movement()` (`database/062` ~112) already keeps a payload patient id only when it is a real patient.

**Steps.**
1. Write the failing browser test first (extend `scripts/browser_inventory_sync_test.js`): a medic uses a bandage on a saved patient, and a tourniquet during intake of a new patient; assert every pushed event has a UUID `patient_id` or none, and the stub server stores both movements.
2. Movements on a saved patient: top-level and payload `patient_id` = that patient's UUID. Keep the draft or visible number only as `patient_context` for display.
3. Movements during intake: send them after `PATIENT_CREATED` with the new UUID (the pattern `queueTourniquetAppliedEvent` uses), or with no patient id if the order cannot be kept. Pass `patientUuid`, not `newId`, to `queueInventoryBeforeSave`.
4. Apply the same rule to `SUPPLY_CONSUMED` and `LOCAL_STOCKOUT_WARNING`.
5. A movement with no patient (PC truck issue, logistics receipt) is unchanged.
6. Already-queued bad movements on phones: on load, rewrite an unsynced movement's draft `patient_id` to the saved patient's UUID if the phone can map it, else drop the patient id and keep the movement. Never drop the movement itself.

**Verify.** The new test fails on `main` and passes after. Full `npm test`. Live after merge: one medic uses supplies on two patients; `select count(*) from inventory_ledger_v12` rises and no new `sync_ingestion_errors` rows appear.

**Done when.** Every bag movement from every entry path is stored live, and the logistics board shows the incident-wide burn rate from server rows.

**Found while re-checking (2026-11-17).** The plan's evidence held, with three additions: (1) the ledger movement used `state.patientDraftId||patientId`, so the draft id won even on a saved patient; (2) in the New Patient form the stock is used the moment a box is ticked, not at save, so `queueInventoryBeforeSave(patientUuid)` alone would have fixed almost nothing; (3) the bag itself reset to `SUPPLY_BASELINE` on every new patient (`freshState()`) and on every reload, so once rows landed the board's bag counts (latest `stock_after`) would have been wrong from the second patient on. Live (2026-11-17): of the 19 rejected movements, 14 are in incidents now closed and 5 (one phone, `PHONE-SPSZ`) in an open one; the phone's "שלח שוב" finds rejections by patient, so none can be resent: they go to WP-22.

**Decided (owner, 2026-11-18).** A form left without saving sends its stock with no patient (the items left the bag). The bag is on the medic: every use lowers it, also below 0 (in an MCI there is neither time nor equipment to treat everyone, and treatment is never blocked); nothing refills it but a manual "התיק חודש"; one bag per signed-in user on a phone; the starting bag stays the demo list for now. A resupply delivered to the medic does not raise the bag yet: WP-38. The 19 old rejections are left to WP-22.

**Done (V2.99.73, client only, no SQL).**
1. Every stock event (`INVENTORY_LEDGER_MOVEMENT`, `SUPPLY_CONSUMED`, `SUPPLY_USE_CANCELLED`, `LOCAL_STOCKOUT_WARNING`) carries the saved patient's uuid or no patient (`serverPatientIdFor`: a uuid, or a saved form's draft id / visible number mapped through `tempPatientId` / `visualId`). The ledger payload no longer carries `patient_context`.
2. New Patient form: the in-form events stay on the phone (`heldForForm`, the `FLOW_EVENTS_SENT_AT_SAVE` pattern); `savePatient()` sends one `SUPPLY_CONSUMED` + `INVENTORY_LEDGER_MOVEMENT` per supply line, net, after `PATIENT_CREATED`, with the new uuid and the time of first use (`sendFormSupply`). A new form over an unsaved one sends the old form's lines with no patient (`freshPatientState`). The burn rate on the phone counts held lines meanwhile. The empty-bag warning is sent at once.
3. MSTART and immediate-action tourniquets: the movement comes after the patient's `QUICK_PATIENT_CREATED`, with its uuid.
4. Queued movements from an older version: before each push, a non-uuid patient is mapped to the saved patient when the phone knows it (and its create is not still queued behind), else removed; the movement is always kept (`repairQueuedStockEvents`). Events the server already refused are left alone (WP-22).
5. The bag (`medicBag()`, `MEDIC_BAG_KEY`, encrypted like the outbox) is per signed-in user, survives new patients and reloads, may go below 0. "התיק חודש" (patient summary row, and the low-stock chip row) fills each item back to `SUPPLY_BASELINE` and sends one `resupply_received` movement per item, no patient; it is not consumption.

**Verify.** `scripts/browser_inventory_sync_test.js` part 6. Its fake server now refuses a non-uuid or unknown `patient_id` like `events.patient_id`; on `main` the test fails at its first check (0 ledger rows, every movement refused) and passes on this branch. Breaking each fix in turn (no send at save, no send for an abandoned form, bag reset per patient, no repair) fails the test. Full `npm test`. Live (2026-11-18, rolled back, nothing persisted): `sync-log` cannot be reached from the session's network (proxy refuses the tunnel), so the check ran in the database as a real medic account: the events the fixed phone sends (a create, a form line with the patient's uuid, an abandoned form's line with no patient, a "התיק חודש" `resupply_received`) gave 3 `inventory_ledger_v12` rows, medic bag, right patient and count; the old client's `draft-...` patient id still fails with `invalid input syntax for type uuid`, exactly the live rejections. `sync-log` gates these by event type only. Still to see: a push from real phones (the owner's run, then `select count(*) from inventory_ledger_v12` rises and no new `sync_ingestion_errors`).

---

### WP-20: Finish PR #128 and apply 079-081 (P1)

**Done (checked live 2026-11-17).** #128 merged (V2.99.72) with both answers (a typed time later than the phone's clock is asked about, not refused; a tourniquet with a typed time does not come from the bag). Live: `run_clinical_watchdog` raises `TOURNIQUET_TIME_DECISION` (079), the `TOURNIQUET_TIME_RECORDED` enum value (080), 081's functions, `tourniquets.time_source` column and `trg_tourniquet_time_events` trigger, and `sync-log` v17. Not seen yet: step 4's check on a real tourniquet; it runs as part of WP-21. The text below is the original plan.

**Why.** The phone raises the 100-minute tourniquet decision alert (V2.99.70) but the server watchdog does not: `database/079` is not applied (checked live 2026-11-13: `run_clinical_watchdog` has no `TOURNIQUET_TIME_DECISION`). PR #128 (time written on the body, V2.99.72) is ready but waits on two owner answers.

**Steps.**
1. Ask the owner the two open questions from the PR #128 session: (a) the day rule for a typed body time (up to 5 min ahead of the phone clock = now; 5-60 min ahead refused; more than 1 h ahead read as yesterday, asking first past 12 h); (b) whether a typed time still takes a tourniquet from the medic's bag (recommendation: no, the tourniquet may come from another kit).
2. Apply the answers on the PR branch, rebase on `main`, run every test, wait for the owner's merge.
3. After merge, in this order: `database/079`, `080`, `081` (each through `apply_migration`, or by the owner in the SQL editor; record which), then redeploy `sync-log` from `main`'s file (live is v16; the new one must contain every change since v16). `get_advisors` after each step.
4. Live check, rolled back: a tourniquet 101 minutes old gets `TOURNIQUET_TIME_DECISION`, its `WARNING` is resolved, and the next run does not raise it again.

**Done when.** #128 is merged, 079-081 and the new `sync-log` are live, and the status table says so.

---

### WP-21: Live two-phone run (P1, WP-0 part 2)

**Why.** Only 1 event reached the server in the 14 days before 2026-11-13. V2.99.67 to 72 have never pushed a record. WP-0 part 2 has never run, and it is the Phase 4 gate (with field Session 2).

**Steps.** This is mostly the owner's run; the session prepares it and reads the results.
1. Before: read-only counts for a new incident (events by type, `patients`, `tourniquets`, `inventory_ledger_v12`, `watchdog_alerts`, `sync_ingestion_errors`).
2. The owner runs WP-0 part 2 (section "Part 2" below) with a real `medic` and a real `pc` account, not admin, plus: one MSTART sweep of 3 casualties; a second medic account with the same initials creating a patient offline (WP-17); evacuation-point arrival marked by the PC (WP-18); one tourniquet left past 60 minutes with the network off (D1), then snoozed once; a conversion to direct pressure; one stock use per patient (WP-19); install the PWA on one Android and one iPhone and reload offline (WP-10); open one `handover-consume` link (T6).
3. After: rerun the queries; list every rejection with its cause; write the results into "Baseline results" and mark each round-2 WP confirmed, changed or not needed.

**Done when.** The results are in this file and every red item has a WP.

---

### WP-22: Close or resend the open sync rejections (P2)

**Why.** 55 rejections are open live and none has ever been closed, although closing exists since V2.99.55 (`database/071`). An always-full panel hides new problems.

**Groups (live, 2026-11-13).**

| Group | Rows | Cause | Proposal |
| --- | --- | --- | --- |
| August RLS / role tests (`TEST-DEVICE-*`, `P-TEST-001`) | 8 | deliberate test cases | close, reason "test data" |
| Oct 17-18 admin phone tests (`PHONE-SPSZ`, `PHONE-LTKE`) | 10 | 5 creates refused by RLS for admin (fixed by `047`), 5 follow-ups failed the foreign key | close, "not recoverable", note the fix |
| Oct 20 sweep, `PHONE-SPSZ` | 18 | 9 patients on a duplicate `TMP-001` and their 9 location updates (fixed by WP-17) | resend from that phone if it still has them; else close "not recoverable" |
| Oct 22-25 stock movements | 19 | draft patient id (WP-19) | cannot be resent (14 in closed incidents; "שלח שוב" finds rejections by patient, and these have none): close, "not recoverable, fixed in WP-19 (V2.99.73)" |

**Steps.** Re-run the grouping query first (counts drift). Present the table to the owner and get approval per group. The owner closes them from the command panel, or approves `resolve_sync_ingestion_error()` calls run as a command account; never `delete` and never a direct `update` that bypasses the audited function. The rows themselves stay (audit history).

**Done when.** The panel shows only rejections that still need someone, each closed one has a reason, and nothing was deleted.

**Re-checked (2026-11-18).** Still 55 open, the same four groups (8 / 10 / 18 / 19), but every one is now in a closed incident, including the 5 stock movements that were in an open one on 2026-11-17. So `resolve_sync_ingestion_error()` lets only admin close them (`app.can_read_incident_patients`, D9), and the in-app panel cannot reach them: it loads rejections only for the incidents the phone has open. Closing changes no screen; it ends the open backlog and, by the nightly job `redact-resolved-sync-error-payloads` (03:15 UTC, `database/028`), deletes each closed row's stored copy (`raw_payload`), logged in `retention_actions`. The row stays.

**Done (2026-11-19, owner approved all four groups 2026-11-18).** One transaction, `resolve_sync_ingestion_error()` called once per row as the admin account ("Test Admin"), aborting if any row fell outside the four groups or any count had changed: A (8) `test_data`; B (10), C (18) and D (19) `not_recoverable`, each with a note naming the cause and its fix (`database/047`, WP-17, WP-19). Group C was not resent: its incident is closed and its stored report written. Checked after: 55 rows, 0 open, every one with a reason and a "WP-22" note, closed by the same account; no row deleted or edited outside the function.

---

### WP-23: Injury time editable in the field (P2, owner 2026-10-23)

**Why.** Owner decision 2026-10-23 (feature-map session): injury time starts as the alert time and the medic can change it in the field. Today it is never captured, so golden-hour figures in the stored report use the event's own time. The server already applies `PATIENT_T_INJURY_UPDATED` (`database/013` ~161 sets `patients.t_injury`), and the type is in `SYNC_ELIGIBLE_EVENT_TYPES`, but nothing sends it (event contract: synced, never emitted).

**Steps.**
1. Patient creation: set `t_injury` to the incident's alert time (or the time the medic opened the incident) and send it in the create payload; check what `013` reads on create.
2. Patient screen: an "שעת פציעה" row with a time picker (same pattern and day rule as the body-time entry in #128, so medics learn one control). Sends `PATIENT_T_INJURY_UPDATED` with `payload_json.t_injury` (ISO).
3. Other phones and the stored report read `patients.t_injury`; show "שעת פציעה (משוערת)" until someone edits it.
4. Who may edit: medic, paramedic, physician, PC (ask the owner whether CC too).

**Verify.** New browser test across two phones; check `068`'s report uses `t_injury` for golden-hour figures. Timing logic: owner reviews (CLAUDE.md, clinically relevant timing).

**Evidence re-checked 2026-11-18, three corrections.** (a) `013` does not set `t_injury` on create: `sync-log` inserts the patients row with `t_injury` = the create event's `local_timestamp` and reads nothing from the payload, so step 1's "send it in the create payload" would have done nothing without a `sync-log` deploy. (b) `068`'s report has no golden-hour figure and never reads `t_injury`; it measures from incident open. (c) The phone's command watchdog rows "Golden Hour" and "Crush Syndrome" were labelled `T_injury +45m` but counted from the phone's registration of the patient. Also: the live `project_patient_state()` applied `PATIENT_T_INJURY_UPDATED` in arrival order, so an offline phone's older entry pushed late would overwrite a newer correction.

**Decided (owner, 2026-11-18).** CC may not change the injury time. All three clocks follow it: the command watchdog rows, a "שעת פציעה" line in MIST, and golden-hour figures in the stored report. The MIST mechanism/injuries bug found on the way is fixed in the same PR.

**Done (V2.99.81, `database/088`; no `sync-log` change).** Written as 082; renumbered to 085 after WP-38 took 082 and WP-24 083-084, then to 088 because PR #141's `085_rescue_board_evac_point` (with 086-087) was applied live first. That file renamed `app.build_incident_aar()` to `app.build_incident_aar_ext()` and wrapped it, so 085's in-place report edit stopped with its own guard on 2026-11-19 (nothing applied); 088 edits whichever of the two holds the base call.
1. `patients.t_injury_source` (`event_time` = the old fallback and every existing row, kept as it is; `incident_open`; `entered`) plus who, which role, which event and the phone time of the winning entry.
2. The create event (`PATIENT_CREATED`, `QUICK_PATIENT_CREATED`, `FIRST_RESPONDER_REPORT`) gives the row the incident's `t_injury_default` (the alert time, = `t_zero` from `open_incident()`), source `incident_open`. Done by a trigger, not by the create payload, so no `sync-log` deploy.
3. `PATIENT_T_INJURY_UPDATED` moved out of `project_patient_state()` (edited in place like `047`, fails if the branch text is not found exactly once) into `app.project_patient_t_injury()`: medic/paramedic/physician/pc/admin only (second gate after `sync-log`), a parseable time not more than 5 minutes after the entry nor 26 hours before it, newest entry by phone time wins. The event stays in the log either way.
4. The report gains `golden_hour` (edited in place in `app.build_incident_aar()`, or in `app.build_incident_aar_ext()` once #141's 085 renamed it): entered vs estimated, handed over within / after 60 minutes of injury, median injury-to-handover overall and for red, still not handed over past 60 minutes, one row per patient by temporary number. Reports already stored stay as they were; the next close stores a new version.
5. Client: "שעת פציעה" row on the patient screen with the tourniquet body-time control (`C5Rules.parseTourniquetTimeCode`: same day rule, 5 min tolerance, 5-60 min later asks, over 12 h confirms), "(משוערת)" until entered; `pullInjuryTimes` (own query, so a database without 088 breaks nothing); the phone keeps its own entry until the server holds one at least as new. Golden Hour / Crush watchdog rows, MIST text, the MIST summary in `PATIENT_HANDED_OVER` (`injury_time`, `injury_time_estimated`) and the report screen (golden-hour box, "מפציעה עד מסירה" column; older reports say they have none) read it. MIST mechanism is now the incident's likely mechanism (no per-patient mechanism field exists) and injuries the marked body zones; before, both read `p.injury`.
6. `supabase/functions/handover-consume` shows the injury time on the receiving page; **not deployed** (file only).

**Verify.** `scripts/browser_injury_time_test.js` (two medics, PC, CC on one fake backend that mirrors 088). `088` ran on a local PostgreSQL 16 against the live text of both edited functions (md5 of `prosrc` equal to live, re-checked 2026-11-19 after WP-19, WP-38 and WP-24 merged; re-tested 2026-11-19 with and without PR #141's rename): 12 scenarios (default on create, entry, older entry pushed late ignored, CC ignored, too late / bad / 27 h old ignored, 4 min ahead accepted, a later create event does not reset, rows without a create event stay `event_time`, report figures, no event changed). **Not applied live yet**: the session's apply was blocked; the owner applies `088` in the SQL editor.

**Not done / found on the way.** `siteData.lastMechanism` is overwritten with the last full-flow patient's body-zone labels at save (`savePatient`, `effectiveInjury`), so the quick-flow patients that follow inherit those labels as their "injury"; not fixed here.

---

### WP-24: Command cancels a resupply request (P2, owner 2026-10-23, rescoped 2026-11-18)

**Why.** WP-6 left the CC board's "אשר השלמה פלוגתית" and "סגור" local: they changed the CC's own phone and nothing else. The card in the command panel had the same local-only status buttons.

**Rescoped (owner, 2026-11-18).** The first version of this WP (sync the two CC outcomes, and project a medic's `RESUPPLY_REQUEST_ESCALATED_CC` at `pc_to_logo`) was wrong on both points:
- The CC holds no stock of its own; stock is the PC truck and the logistics officer (owner). A synced "fulfilled by company" would be a second way to reach "delivered" with no stock behind it. Delivery stays with the PC (truck, "סמן נמסר") and logistics (dispatch, in transit, received), which already cross devices (`034`/`059`). The MVP spec's permissions agree: CC only views resupply; Log-O dispatches.
- The medic's "not on the truck" is computed on the medic's phone from its copy of `PC_TRUCK_BASELINE`, never from the real truck. Moving that request straight to `pc_to_logo` would skip the PC on a guess. A medic's request keeps landing with the PC, and only the PC escalates. This is a decision, not a gap.
- What command does need is to call off a request nobody should fill any more: cc, chamal and admin while it is open (requested, dispatched, in transit); the PC while it still waits at its own level (owner: yes, rarely used). Never once the PC truck issued it (approved), never after delivery.

**Done (V2.99.75, `database/083`-`084`; `083` and `084` applied live by the owner and `sync-log` v20 deployed 2026-11-20; checked live the same day (see `docs/RLS_AUDIT_v1.md`)).** `SUPPLY_REQUEST_CANCELLED` in the four places (enum `083`; `sync-log` for pc, cc, chamal and admin; `SYNC_ELIGIBLE_EVENT_TYPES`; the contract). `084`: `supply_requests` gains `cancelled_at`, `cancelled_by`, `cancel_reason` (not needed / duplicate / supplied otherwise / other) and `cancel_note` (required for other); `project_supply_request_event()` applies the cancel by server id only, by the rule above, role read from `profiles`; nothing moves a cancelled row afterwards, and escalation now needs an open status. `084` also closes direct client writes to `supply_requests` (the `_insert` / `_update` / `_delete` policies let medic, pc, paramedic, logistics and admin write any row of their incident around every rule; nothing wrote it directly). The rule is `supplyRequestCancelAllowed()` in `src/domain/rules.js` (tested), so the phone offers the button exactly when the server would accept it. Client: a cancel sheet (reason, note) on the shared queue row; the CC board lists escalated requests from the shared queue with logistics' real status, runner and ETA, and offers only the cancel (the fulfilled, route-between-trucks toast and mark-unavailable buttons are gone); signed in, the command panel's resupply cards are read only; logistics and the medic see "בוטל" and the reason, the medic gets one toast. Chamal: the server accepts its cancel; chamal has no supply screen, so no button.

**Verify.** `scripts/browser_resupply_decision_sync_test.js` (medic, PC, CC, logistics, second medic) steps 10-16. `084` on a local PostgreSQL 16 with stand-ins (`scripts/rls_test_084_standin.sql`, `scripts/rls_test_084_supply_request_cancel.sql`, 24 checks, re-applies as a no-op). Live, after applying `083`, then `084`, then deploying `sync-log`: the same checks as rolled-back impersonation, `get_advisors`.

---

### WP-25: Medic incident type and mismatch report synced (P2, owner 2026-10-23)

**Status (2026-11-21, V2.99.82, `database/089`-`091`).** Live: `089` applied by the owner in the SQL editor; `090` applied 2026-11-20 through the connector after the editor paste failed (see Rules); `sync-log` v21 deployed (v20 plus WP-25's five lines). Checked live inside a rolled-back transaction with real profiles: two medics add shooting + explosion and both stay; a medic's removal of another medic's type becomes a report; RPC adds and is stamped `rpc`; PC removing rescue's type is refused, a medic's type allowed; CC keeps a report; a logistics officer is refused; the reports table is read by members only and refuses direct inserts. `get_advisors` then flagged two of 090's helpers callable by any signed-in user with no incident check (`incident_type_adder` would show who added a type to someone else's incident) and four helpers without a fixed `search_path`: fixed in `091_incident_types_hardening` (revoke from authenticated; `search_path = ''`), tested on local PostgreSQL 16 (the 20 scenarios unchanged, a direct call refused, `change_incident_type` and the check constraint unaffected). `091` applied live 2026-11-21 through the connector (`091_incident_types_hardening`): `get_advisors` no longer lists the two helpers or the four `search_path` warnings, and a rolled-back check with real profiles still passes (medic add, PC refused over rescue, PC removes a medic's type, a direct helper call refused). Left: the two-phone check in WP-21. Owner decisions 2026-11-18, three rounds, final: (1) an incident may have **several types** (a suicide bomber can open fire and then explode), all equal, no main type; (2) **anyone adds** a type, **removing follows the ladder** rescue (rpc/rcc) > PC/CC > medics against whoever added that type; (3) PC/CC never remove a type rescue added; (4) a medic removes a type they added themselves; someone else's is a "not right" report PC/CC/RPC/RCC keep or accept by the same ladder. Built in `database/090_incident_types_ladder.sql` (see `docs/ARCHITECTURE.md`). This also removes an inconsistency: a medic opening an incident could already set its type through `open_incident` (064). Found and fixed during the build: boards writing their whole type list would have dropped a type another phone added meanwhile, so boards send one change at a time (`change_incident_type`). Tested on a local PostgreSQL 16 with stand-in tables (20 scenarios) and in `scripts/browser_rescue_site_authority_test.js` (two medics, PC, CC, RPC, RCC phones; four client guards mutation-checked). Also fixed: the medic's toast "הפער נשלח לחוג"ד" was false (the event never left the phone). Follow-up done in `092_incident_types_in_lists_and_report` (V2.99.83, applied live 2026-11-21 by the owner in the SQL editor, so not in the migration list): `list_open_incidents` returns `incident_types` (dropped and recreated from its live body, grants restored), the stored report carries `incident.incident_types` (live `app.build_incident_aar` wrapped, nothing else changed: same 19 top-level keys), the incident picker, the RCC table of other incidents and the stored report header show every type (older servers and older stored reports fall back to `incident_type`), and the analytics export writes `incident_types_json`. Checked against the live schema in a rolled-back transaction before applying; after applying (2026-11-21): `list_open_incidents` returns `incident_types` for a real CC profile and refuses anon, a stored report still has 19 top-level keys and carries `incident.incident_types`, and `get_advisors` shows nothing new. The text below is the original plan.

**Why.** WP-8 follow-up: a signed-in medic's incident-type pick stays on the phone, and `INCIDENT_TYPE_MISMATCH_REPORTED` (event contract `known_gaps`) never reaches the PC or rescue.

**Steps.**
1. Decide with the owner in one question: is the medic's pick a proposal (the PC or RCC confirms) or does it set `incidents.incident_type` when none is set? Recommendation: proposal only; site authority stays with rpc/rcc (`060`).
2. Sync `INCIDENT_TYPE_MISMATCH_REPORTED`; project it into `incident_site_authority` (or a small table) and show it on the PC and RCC boards until handled.
3. Remove the type from `known_gaps`.

**Verify.** Extend `scripts/browser_rescue_site_authority_test.js`.

---

### WP-26: PC deterioration review request synced (P2, owner 2026-10-23)

**Why.** `PC_REVIEW_REQUESTED_FOR_DETERIORATION` stays on the phone (WP-5 `known_gaps`). A medic asking the PC to look at a worsening patient is lost if the PC is on another phone.

**Steps.** Decide the shape with the owner: a `medical_resource_requests` row with resource type `pc_review` (reuses `052`, its RLS and status flow; recommended) or its own event and table. Then the four places, the PC strip shows it as an alert line, the PC closes it.

**Verify.** Extend `scripts/browser_reinforcement_sync_test.js` (medic, PC).

**Status (2026-11-21, V2.99.87, `database/094`).** **Applied live 2026-11-21** (owner, pasted in the SQL editor; written as 093 and renumbered to 094 on merge because `093_pediatric_flag_and_weight_key` took the number first; the live function text matches the file apart from whitespace). `scripts/rls_test_094_pc_review.sql` run live as a rolled-back transaction: every item as wanted, nothing left behind. Security advisors: no new findings. Owner decisions 2026-11-19/21:
1. Shape: option A. A `medical_resource_requests` row with its own `request_kind = 'pc_review'` (052's read policy, server-id status, newest-wins), kept out of every reinforcement count. `094` adds a second trigger beside 052's (the 087 pattern; 052 unchanged): only medic / paramedic / admin create it, only for a patient of the same incident; on a status update 052 accepted, it stores the outcome (`review_outcome`) or the delay (`snoozed_until`, `snooze_count`), then applies the same decision to every other open review of that casualty.
2. When the medic sees "בקש חוג"ד": the deterioration card (worse), a new card for a red casualty who gets worse and stays red (it never had one), and by hand from the patient screen's "עוד". An improvement (red -> yellow / green, yellow -> green) has its own card with update / keep only and no alert; before this it was titled "הידרדרות" and raised an alert. `C5Rules.priorityRecommendationDirection` (black <-> red count as worse).
3. One open review per casualty per phone; a second tap raises it to immediate. Urgency immediate for a red casualty, else high.
4. PC + CC see it; one strip line per casualty (two medics = one line). The PC closes it with one of four outcomes (priority updated / kept / paramedic or doctor requested / evacuation moved up); "updated" opens the priority buttons, "paramedic" opens the request form. The PC may put it off ("אחר כך", owner 2026-11-21): a red casualty once for 3 minutes, others twice for 5 (`C5Rules.pcReviewSnoozeOption`); the CC sees who put it off and until when, and when the delays are used up.
5. After 5 minutes with no answer (or when a delay runs out) the PC's line turns red and the CC's says "לא נענה". The PC's phone vibrates for a new review and when a delay ends.
6. The medic's patient screen shows where it stands and, once closed, "חוג"ד סקר: <outcome>" with the PC's name and time (toast and vibration on arrival).
7. KPI `pc_review_response()` in the analytics package (minutes to first answer and to decision, outcome, delays, unanswered past 5 minutes).

Follow-up, same PR, owner 2026-11-21 (094 was not applied yet, so folded into it):
8. A casualty who leaves the scene (handed_over, self_evacuated, deceased, closed) closes its open reviews on the server (`app.close_pc_reviews_on_patient_exit()`, status 'closed', reason `patient_left_scene`, no outcome); the strip drops the line as soon as the phone knows. The KPI reports it as `closed_patient_left` and counts it as unanswered only if 5 minutes passed first. Without this an abandoned review stayed open forever and inflated "unanswered".
9. The incident's medics and paramedics read every pc_review row (`medical_resource_requests_read_pc_review_medics`; read only, every other request kind keeps 052's policy): the PC's decision belongs to the casualty, so a medic who takes over sees it. Writing is unchanged: only command changes a review's status (052).
10. "עודכנה קדימות" with no triage change for that casualty between the request and 2 minutes after the decision is flagged: in-app AAR (four new cards, the PC insight names the casualties) and `pc_review_response().priority_update_unconfirmed`, plus a PC review section in the analytics report.
11. Synced text keeps Hebrew quotes: `sanitizeRemoteText` turns `"` into ״ and `'` into ׳ instead of dropping them (names like חוג"ד were shown as חוגד).

12. A yellow casualty getting worse without turning red (owner 2026-11-21, option B, V2.99.88, client only): a card "מגמת החמרה בפצוע צהוב" (PC review / paramedic / keep watching) after **two flagged re-checks in a row** in the same category, showing the changes of every re-check in the streak. One flagged re-check can be pain, stress or a miscount; two in a row is a trend. A clean re-check or a new category starts the count over; "המשך מעקב" hides the card but the count goes on. Request reason `yellow_trend`. `C5Rules.nextDeteriorationStreak` / `shouldPromptYellowTrend`. Measure in the drill: how often medics still ask for yellow casualties by hand ("manual"), and how often the trend card is dismissed. Then added (owner 2026-11-21, V2.99.89): `detectDeterioration` flags a climbing breathing rate, `⬆ נשימות a→b`, for a rise of 8/min or more that ends at 21 or above (`RR_RISE_FLAG_PER_MIN`, `RR_RISE_FLAG_FLOOR` in `src/domain/rules.js`). Reasons: a rising rate is often the earliest sign, before SpO₂ falls; the rate is counted over 30 s and doubled, so one missed breath is 2/min and 8 is four extra breaths, past counting noise; 21+ is where NEWS2 starts scoring (21-24 = 2, 25+ = 3); a rise ending at 20 or below is a return towards normal. Above 30 MSTART makes the casualty red. Like every flag it raises the patient alert, the red card for a red casualty and counts toward the yellow trend. Before this a rate rising 18 -> 28 was not flagged at all. Check in the drill how often it fires; the two numbers are the place to tune it.

Found and fixed on the way: a re-check that did not count the pulse raised "CRITICAL: ירידה חדה — דופק 110→null" (a null pulse counted as a 100% drop) on every such save.

Verified: `scripts/rls_test_094_pc_review.sql` on a local PostgreSQL 16 with every migration applied (22 checks: creation rules, 052 untouched, who reads what incl. a member medic reading every review but not others' reinforcement and a non-member reading none, medic cannot close, delay, same-casualty follow, 3 h delay refused, outcome, late older update ignored, unknown outcome dropped, casualty leaving closes an open review and leaves a closed one alone, refused events kept; also applied from scratch). The live 052 function was compared before writing 093 (same logic as the repo file; the live constraint name matches). `scripts/browser_pc_review_sync_test.js` (two medics, PC, CC). Left: a CC on the all-incidents view does not see other incidents' reviews (only the open incident's); the two-phone check in WP-21.

---

### WP-27: CC moves a site's patients to another platoon (P2, owner 2026-10-23)

**Why.** Owner 2026-10-23: the CC moves a site's patients from one platoon to another (example: platoon A hands over to B for rest). Today `PATIENT_REASSIGNED_BETWEEN_PLATOONS` / `_WITHIN_PLATOON` are demo-only (`index.html` ~8052, `known_gaps` WP-7).

**Open design question (ask first).** One incident belongs to one platoon (`045`, `053`). Moving a whole site = changing the incident's platoon (a CC version of `set_incident_platoon`, plus membership for the new platoon's medics and PC). Moving some patients only = splitting the site into two incidents. Recommendation: whole site only; splitting is a merge in reverse and much larger.

**Steps (whole site).** A `SECURITY DEFINER` RPC for cc/chamal/admin: sets the incident's platoon, adds the new platoon's PC and medics as members, keeps the old ones as read-only until they leave or the owner decides, writes an audited event. The incident-opened banner logic (`064`) informs the new platoon's RPC. Client: CC action on the incident row; both platoons' boards follow.

**Verify.** RLS impersonation for old PC, new PC, both medics, rolled back; extend `scripts/browser_platoon_security_test.js`. RLS change: owner verifies live, never auto-merged.

---

### WP-28: The 27 never-sent event types (P2, needs the owner's list)

**Why.** 34 synced types are never written by the phone; 7 are lifecycle types the server writes itself, so 27 are allowed but unused (list in the event contract: `synced` minus what `index.html` emits). They mislead new sessions into assuming features exist.

**Steps.**
1. Show the owner the list from the 2026-10-23 session (notes, command/AAR notes, voice memo, SABCDE, minimal triage, patient identified, injury update, JumpSTART x2, MSTART suggested, tourniquet context, two safety records, two conflict records, watchdog resolved, 8 old inventory types, `MEDIC_SITE_CLOSE_REQUESTED`, plus `DEAD_MAN_SWITCH_ESCALATED` on the server list). Proposal: remove the 8 old inventory types, the two conflict records and `DEAD_MAN_SWITCH_ESCALATED`; keep the rest as owed; build `NOTE_ADDED`, `PATIENT_IDENTIFIED` and `MEDIC_SITE_CLOSE_REQUESTED` as later WPs.
2. Remove: take each out of `SYNC_ELIGIBLE_EVENT_TYPES`, the contract's `synced` list and `ROLE_ALLOWED_EVENT_TYPES` in `sync-log`. Leave the enum values (Postgres cannot drop one safely, and old rows may use them). Add a contract section `server_accepts_unused` if a type stays allowed but unused, with the WP that will build it.
3. Each "build" answer becomes its own WP in this file.

**Verify.** `check_repo.py` passes; deploy `sync-log` from `main`'s file.

---

### WP-29: Dead Man's Switch on the server (P2)

**Why.** If a medic's phone goes silent, only phones that are open notice (`isDeviceSilent`, 10 min, `src/domain/rules.js` ~204). Heartbeats are already on the server (`device_presence`, 17 rows live), so the minute job can raise it (WP-12 "not built").

**Depends on.** WP-20: `081` replaces `app.run_clinical_watchdog()` again; start from 081's body, not 072's or 079's.

**Steps.** In the watchdog: for each open incident, a medic/paramedic member whose `device_presence.last_heartbeat_at` is older than 10 minutes while they have patients not handed over raises one `DEAD_MAN_SWITCH` alert (dedupe per device per silence), resolved by the next heartbeat. Ask the owner who sees it (proposal: PC and CC of the incident). Client: list it like the other server alerts, marked "(שרת)", only when the phone does not already show its own. Then decide in WP-28 whether `DEAD_MAN_SWITCH_ESCALATED` stays.

**Verify.** Rolled-back live run: stale heartbeat raises, a fresh one resolves, second run idempotent; extend `scripts/browser_server_watchdog_test.js`. Threshold change rules apply (CLAUDE.md).

**Owner, 2026-11-21.** (1) Who sees it: PC, CC and the rescue chain (RCC / RPC); not the medic. (2) Silent: no heartbeat from any of the medic's devices AND no event stored by the server from them for 10 minutes, by the server's time (a late offline push is contact). Asked because the heartbeat is a 45-second timer in the page that a locked screen stops, so heartbeat alone would fire on every medic working with the phone in a pocket; this still fires when nothing is synced for 10 minutes. (3) Whose patients: the medic's own, not handed over. (4) One alert per medic, not per device.

**Done (V2.99.90, `database/095`, not applied live).** Found while building: the server has no assigned medic on a patient (the phone's `assignedMedicId` is local, reassignment is not modelled, WP-7), so `patients.created_by` (the registrant, set by `sync-log`) stands for it. Open = the watchdog's own list (not closed / deceased / evacuating / handed_over / self_evacuated), so a patient waiting at the נאפ"ל still counts. Medic and paramedic profiles that are active only. `app.run_clinical_watchdog()` is 081's body plus step 4 in its own sub-block (a failure there leaves the tourniquet and vitals alerts); `app.medic_last_contact_at()`; dedupe `dms:<medic>:<epoch of last contact>`; resolved by a newer heartbeat or event, or when none of the medic's patients is open. A new policy lets RCC / RPC read `DEAD_MAN_SWITCH` rows only (074's clinical rule holds for every other alert). The phone lists it for PC and CC (and in the CC all-incidents line), and in the RCC / RPC strip, marked "(שרת)", hidden once the phone sees a newer heartbeat from that medic. `generate_dead_man_switch_alerts()` from `001` is dead code (never scheduled), left as is. `DEAD_MAN_SWITCH_ESCALATED` stays for WP-28. Tested: `scripts/rls_test_095_server_dead_mans_switch.sql` (22 checks, local PostgreSQL 16 with stand-ins), `scripts/browser_server_watchdog_test.js` step 9. **Open:** apply `095` live and a rolled-back live run; measure in WP-21 how often a medic working with the screen locked raises it before touching the 10 minutes.

---

### WP-30: Telegram critical alerts (P2, B1, needs the owner's answers)

**Why.** B1 (owner 2026-10-21): an extra channel for critical alerts when no phone is open. The phone's own offline alert stays primary.

**Before starting.** The owner answers yes / no and recipients for each of the 19 alerts listed in the 2026-10-23 session (11 the server already knows, 8 phone-only). Build only the yes answers the server knows; phone-only ones need their own WP first.

**Steps.** A bot created by the owner; its token stored as an Edge Function secret (never in the repo or chat); a table of Telegram chat ids per profile, filled by a `/start` link flow; an Edge Function or `pg_net` call from the watchdog that sends "critical alert, incident X, open the app" with no patient details (privacy review); retries without duplicates; an opt-out. Privacy review update in the same PR.

**Verify.** A test bot and a test chat; rolled-back trigger runs; no patient field in any message.

---

### WP-31: MARCH completion rule and hands-on PC (P2, B2, clinical)

**Why.** The MARCH-PAWS step shipped (V2.99.62, V2.99.69), but `marchStatus()` in `src/domain/rules.js` does not exist, so nothing says when a letter is complete, and a PC who goes hands-on has no MARCH flow.

**Steps.** Get the owner's completion criteria per letter first (clinical sign-off; do not invent them). Then `marchStatus(patient)` in `rules.js` with tests in `tests/domain-rules.test.js`, inlined in `index.html` (the drift check enforces it), the letter strip reads it, then the PC hands-on entry. Never auto-merged.

---

### WP-32: Evacuation point leftovers (P2, WP-18)

**Steps.** (1) `get_rescue_patient_board()` (`database/074`) returns moving vs arrived instead of "בפינוי" for both, without colours (074's rule). (2) The stored report (`068`) adds waiting time at the evacuation point: count, median, longest, from `evac_point_arrived_at` to handover. (3) Truck stock per evacuation point stays out until the owner asks.

**Verify.** Extend `scripts/browser_evac_point_arrival_test.js` and `scripts/browser_incident_close_report_test.js`; rolled-back live check of both functions.

---

### WP-33: CC all-incidents: what counts as an alert (P3, answered 2026-11-18)

**Owner, 2026-11-18.** The per-patient alert lines of V2.99.68 were too much on the CC's first page. Chosen from a mockup: one line per incident ("option A"), coloured by its worst alert, with the location, how many patients / requests have alerts, the most urgent one and "(+N)" for the rest; a tap opens the incident, where each alert keeps its own line. A red patient alone counts ("פצוע אדום"), because a red patient is a problem until evacuated to a hospital: at the extraction site and at the evacuation point the patient is still the platoon's. Found while asking: "פצוע אדום" kept firing after a vehicle took the patient (handed over, evacuated, self-evacuated); now it stops then, everywhere, not only on this page.

**Done (V2.99.76).** `ccOverviewIncidentAlerts()` groups the existing per-patient groups by incident; `renderCcOverviewStrip()` draws one line per incident, worst first, then by count; `RED_CASUALTY_CREATED` only while the patient is not in `LOCATION_BOARD_EVACUATED_STATUSES`. `scripts/browser_command_panel_test.js` step 13: lines per incident and their order, counts, "(+N)", a red patient at the evacuation point counts, a red patient handed over does not.

---

### WP-34: Test gaps (P3)

1. The AAR screen has no interaction test (`PRODUCTION_READINESS.md`): add `scripts/browser_aar_screen_test.js` for the live AAR view and the stored report list.
2. The analytics `pytest` suite is not in CI: a third CI job that sets up Python, installs `analytics/c5_sentinel_sar_analytics_v1_1/requirements.txt` and runs `python -m pytest` there. Keep it separate from the fast `repo-check`.

---

### WP-35: Record what is applied live (P3)

**Why.** Files applied in the SQL editor are missing from the live migration list (checked 2026-11-13: `042`, `053`, `073`, `074`, `075`, `077` and others exist live as objects but have no migration row), and live names differ from repo numbers. Nobody can tell from the live history what is applied.

**Progress (2026-11-20/21).** `081`-`092` checked read-only against the live project (every column, function, trigger and enum value each file creates): all applied. Only `085`, `090` and `091` are in the live migration list; the others were applied in the SQL editor.

| File | Applied live | In the migration list | Checked by |
|---|---|---|---|
| `081_tourniquet_time_entry` | yes (4/4 columns, 3/3 functions) | no | objects, 2026-11-20 |
| `082_resupply_receipt_by_medic` | yes (3/3 columns) | no | objects, 2026-11-20 |
| `083_supply_request_cancelled_enum` | yes (enum value) | no | objects, 2026-11-20 |
| `084_supply_request_cancel` | yes (4/4 columns) | no | objects, 2026-11-20 |
| `085_rescue_board_evac_point` | yes (enum value, 4/4 functions, trigger) | yes (`085_rescue_board_evac_point`) | objects + list |
| `086_extraction_needs_medic_check` | yes (`app.project_patient_extracted` carries the 60-minute rule) | no | objects, 2026-11-20 |
| `087_rescue_extraction_medic_request` | yes (2/2 functions, 2/2 triggers) | no | objects, 2026-11-20 |
| `088_injury_time_entry` | yes (5/5 columns, 2/2 functions, trigger) | no | objects, 2026-11-20 |
| `089_incident_type_report_enum` | yes (both enum values) | no | objects, 2026-11-20 |
| `090_incident_types_ladder` | yes (column, table, 11 functions, 3 triggers; rolled-back role check with real profiles) | yes (`090_incident_types_ladder`) | objects + list |
| `091_incident_types_hardening` | yes (2026-11-21) | yes (`091_incident_types_hardening`) | objects + list + `get_advisors` |
| `092_incident_types_in_lists_and_report` | yes (2026-11-21, SQL editor) | no | objects + grants + rolled-back real-profile check + `get_advisors` |

No rows were written to the migration list to make it look complete: a row there would claim the file was applied as a migration when it was pasted. `004`-`080` are still to check.

**Steps.** Read-only: for each `database/0NN_*.sql`, probe one object it creates (function, column, policy, enum value) and record applied / not applied, the live migration name if any, and who applied it, in a new table in `docs/ARCHITECTURE.md` "Backend Deployment Status" (or a new `docs/LIVE_SCHEMA_STATUS.md` added to `REQUIRED_PATHS`). No writes to the database. This is the input for Phase 4C.

---

### WP-36: Demo constants in signed-in paths (P3)

`'SITE_A'` (60 uses) and `'PLT-A'` (25 uses) still appear in `index.html`. Classify each use as demo-only or signed-in, fix the signed-in ones to use real ids, and list what stays. Same method as WP-7 step 3.

---

### WP-37: External report unlink tombstone (P3)

`database/069` (header, "Known limit"): an unlink leaves no tombstone, so a link recorded offline before an unlink but pushed after it comes back. Fix: compare the event's phone time with the latest unlink for that pair and ignore older links; record the ignored one. Extend `scripts/browser_external_report_link_test.js`; rolled-back live check.

---

### WP-38: A resupply delivered to a medic raises the bag (P2, owner 2026-11-18)

**Why.** Since WP-19 the medic's bag only goes down: every use lowers it and only a manual "התיק חודש" fills it. When the PC issues items from the truck to a medic (`pc_truck_issued`, WP-6/WP-9) the truck's count goes down, but the medic's bag does not go up on any phone, so the bag reads lower than it is and logistics sees a shortage that was already covered. Safe side (warns early, never late), but wrong.

**Ask the owner first.** When does the bag go up: when the PC marks the request delivered, or only when the medic confirms receipt on the phone (recommended: the medic confirms, the items are in their hands only then; until then the request shows as on the way)? And for a partial delivery, by what was delivered, not what was asked.

**Steps.** A test first (extend `scripts/browser_inventory_sync_test.js`): PC issues 2 tourniquets for a medic's request, the medic confirms, the medic's phone shows +2 and the server gets one `resupply_received` movement into that medic's bag, no patient; the truck's issue and the bag's receipt are not counted twice in the burn rate. Then the receipt on the medic's phone (`SUPPLY_REQUEST_RECEIVED` already exists, WP-6), adding to `medicBag()` and sending the movement. Check against WP-24 (CC "fulfilled by company"), which touches the same flow.

**Done when.** A delivered resupply raises that medic's bag on the phone and on the logistics board, once.

**Decided (owner, 2026-11-18).** The bag goes up when the medic confirms receipt on their own phone, not when the PC marks it delivered. A partial delivery adds what arrived: the receipt sheet starts from what was asked and the medic corrects it.

**Found while building.** The medic had no receipt step at all: `SUPPLY_REQUEST_RECEIVED` was sent only by the PC ("סמן נמסר") and logistics, and `sync-log` did not let a medic send it. The server (059) accepted it from anyone with no role check, so a request read "delivered" on every board while the bag never moved.

**Done (V2.99.74). Live 2026-11-18:** `database/082` applied by the owner (checked read-only: 3 new columns, the new `project_supply_request_event()`, no delivered row left without `received_at`); `sync-log` v18 deployed (version 18, JWT check on, same file as `main`).
1. Medic: the action panel lists the medic's own open requests ("ציוד בדרך אליך" / "נמסר · ממתין לאישור קבלה") with "קיבלתי". The sheet is prefilled with what was asked (a "כמה שאפשר" line starts at 1), - / + per item; nothing is added until "אישור קבלה". `confirmResupplyReceipt()` adds to `medicBag()`, sends one `INVENTORY_LEDGER_MOVEMENT` `resupply_received` per item (no patient, `supply_request_ref`), then `SUPPLY_REQUEST_RECEIVED` with `received_items`, `requested_items` and `partial`. Once: a second confirmation does nothing.
2. PC and logistics "סמן נמסר" keep sending `SUPPLY_REQUEST_RECEIVED`; it now means handed over. The PC/CC open board keeps the request as "נמסר · ממתין לאישור החובש" until the receipt, then shows "התקבל אצל החובש" with any partial line ("חסמים 2 מתוך 3").
3. `database/082`: `supply_requests.received_at` / `received_by` / `received_items_json`; `project_supply_request_event()` records the receipt only from the requester (first wins), ignores a medic or paramedic marking someone else's request, and keeps the first delivery time. Rows already delivered get `received_at = delivered_at`, so they do not show as waiting. Checked on a throwaway Postgres 16: backfill, PC handover, another medic's attempt, the requester's partial receipt, a second receipt, a malformed payload (event still stored), a receipt before any PC step.
4. `sync-log` v18: `SUPPLY_REQUEST_RECEIVED` added to `MEDIC_SUPPLY_EVENTS` (medic, paramedic).

**Verify.** `scripts/browser_inventory_sync_test.js` step 7 fails on the WP-19 branch and passes after; `scripts/browser_resupply_decision_sync_test.js` now expects the medic to see the PC's delivery as waiting for receipt. Full `npm test` 79/79. Live, after the owner applies 082 and deploys `sync-log` v18: a medic asks, the PC approves and marks delivered, the medic confirms 2 of 3; `select received_at, received_items_json from supply_requests` shows the receipt and `inventory_ledger_v12` one `resupply_received` row per item for that medic. Order matters: deploy `sync-log` v18 with or before the client, or the medic's receipt is refused (`FORBIDDEN_ACTOR_ROLE`) while the bag already rose on the phone.

**Not covered.** A request the medic never confirms (phone lost) stays "ממתין לאישור החובש" on the PC/CC boards; there is no command override to close it. WP-24 (CC "fulfilled by company") will need the same rule: it marks handed over, the medic confirms.

---

### WP-39: The evacuation point is called נאפ"ל (P2, owner 2026-11-18)

**Why.** The owner's term is נאפ"ל, נקודת איסוף פלוגתית (company collection point). This reverses the 2026-10-23 rename to "נקודת פינוי" (WP-18). Each site has its own נאפ"ל, as today; the PC and the CC must see each site's. The נאפ"ל is not the final destination: a patient there is still the platoon's until MDA or another vehicle takes them.

**Steps.** "נאפ"ל" on buttons, chips, column headers and lines where space is short; the full "נקודת איסוף פלוגתית" once on the patient screen and in help text. Every UI string, test and doc that says "נקודת פינוי". No data change: the payload keeps `destination: 'company_collection_point'`.

**Verify.** `scripts/browser_evac_point_arrival_test.js`, `scripts/browser_command_panel_test.js` and the smoke scripts that assert the wording; `browser_mobile_layout_test.js` for the shorter labels.

**Done (V2.99.77).** Every UI string: "נאפ״ל" in buttons ("יצא לנאפ״ל", "הגיע לנאפ״ל"), statuses, board lines, the stage cards, advice and toasts; the full "נקודת איסוף פלוגתית" on the PC site card's section title, the toast after "יצא לנאפ״ל" and the event detail. Written with gershayim (״) like חוג״ד and מד״א. Tests updated; `database/076`/`077` comments left as applied.

---

### WP-40: 30 minutes waiting at the נאפ"ל alerts the PC and CC (P2, owner 2026-11-18/19)

**Why.** WP-18 showed the waiting time at the evacuation point without an alert, until the owner set a threshold. Owner, 2026-11-18: 30 minutes, seen by the PC and the CC. Owner, 2026-11-19: every colour except black; counted from when the patient was sent to the נאפ"ל, not from the recorded arrival ("it will catch most patients that should go to hospital", including one nobody marked as arrived); two levels.

**Done (V2.99.78), no SQL.** `evacPointWaitAlert` in `src/domain/rules.js` (30 min warning, 60 min critical, only while `evacuating`, never black) with domain tests. The phone records `evacSentAt` on "יצא לנאפ״ל"; other phones read the send time from `patients.status_recorded_at` (set from the status event's phone time by `database/013`), added to the patient pulls and the CC overview read. Alert `EVAC_POINT_WAIT_LONG` for PC and CC, tab פעולה, listed under `not_events` in `event-contract.json`; its line shows minutes since leaving and, when marked, since arrival. `scripts/browser_command_panel_test.js` step 14 and the overview step. Known limit: `status_recorded_at` moves if another status event for the patient arrives while evacuating (none of today's flows send one).

---

### WP-41: Medical staff see a patient sent to and arriving at the נאפ"ל (P2, owner 2026-11-18/19)

**Why.** Owner, 2026-11-18: the platoon's medical staff should know a patient is going to the נאפ"ל, as a banner that closes after 15 seconds or on a tap. Owner, 2026-11-19: both when the patient is sent and when they arrive; every medical role (medic, paramedic, physician); the banner offers "open the patient" or "close".

**Steps.** Detect, in the pull, a patient newly `evacuating` and a newly recorded arrival, once each per patient; skip the phone that recorded it; a banner like the tourniquet one with two buttons, 15-second timer; several patients in one pull become one banner. Phones learn it from the 45-second pull, so up to about a minute late, and an offline phone after it reconnects. No new event type.

**Verify.** A browser test with a PC phone sending the patient, a medic and a paramedic phone: both get the banner on the send and on the arrival, the sender does not, it closes after 15 s, "open" opens the patient, it does not repeat on the next pull.

**Done (V2.99.79), no SQL.** `noteEvacPointNews` is called from the pull: a known patient whose status turns `evacuating`, a patient first seen already `evacuating` with a send time under 10 minutes old (`status_recorded_at`, WP-40), and a first recorded arrival (`applyEvacPointArrivals`). A phone's own change never comes back as a change, so the sender gets no banner. Medic, paramedic and physician only. Several news items within 300 ms become one banner; "פתח פצוע" per patient, "סגור", 15-second timer; placed under the tourniquet banner when that is open. `scripts/browser_evac_point_arrival_test.js`: medic 2 gets the "sent" banner, medic 1 (the sender) and the PC do not, it closes after 15 s and does not return on the next pull, medic 1 gets the "arrived" banner and "פתח פצוע" opens the patient.

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
- B2 (owner, 2026-10-23): MARCH for the medic and, when they go hands-on, the PC (never the CC panel). Today the medic's MSTART sweep card labels only its first block "M — דימום מסכן חיים"; there are no A/R/C/H steps, and the treatment list has no chest seal, needle decompression or warming entry. Add those treatments first, then a tested `marchStatus()` in `src/domain/rules.js` (completion criteria need the owner's clinical sign-off), then an accordion on the medic's patient flow with M before A. **Update (V2.99.69, owner 2026-10-26):** the MARCH-PAWS step shipped in V2.99.62 as nine open cards; it is now a letter strip with one letter on screen at a time (chosen over an accordion and over a modal per letter, which would add a tap per letter and cover the tourniquet reminder). The `marchStatus()` completion criteria in `rules.js` are still open.

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
| WP-6 PC resupply decisions | P2 | Done (V2.99.43): 059 live, verified 2026-10-21 | this PR | the three decision types synced; PC/CC decide a medic's request on the shared queue row by its server id; only pc/cc/admin change the row; the requester's phone follows the decision; logistics is not asked to dispatch what the PC truck fills. Not done: CC-side "fulfilled by company" / "closed" stay local (no server status for them); a medic's `RESUPPLY_REQUEST_ESCALATED_CC` is still projected at the `medic_to_pc` level (033). Both settled by WP-24 (V2.99.75): no "fulfilled by company" (the CC holds no stock), a cancel with a reason instead, and the medic's escalation deliberately stays with the PC |
| WP-7 CC real platoons | P2 | Mostly done (V2.99.42, `database/053`): applied live by the owner 2026-10-20, every 053 function, trigger and policy confirmed present; 4 companies and 9 platoons created live by the owner (2026-10-22), field accounts placed | #82, #86 | real `companies` and `platoons` (3 rescue companies x 3 platoons, plus the ambulance team) instead of 045's medic-to-PC link; first one-company version (#82) rewritten before it was applied; CC tiles/rows/counts from real platoons; roster panel; rpc platoon scope and rescue clinical block added at the owner's request. Remaining: `PATIENT_REASSIGNED_*` (moving a patient to another platoon means another site; not modelled) |
| WP-8 Rescue panel state | P2 | Done (V2.99.44): 060 live, verified 2026-10-21 | this PR | verified first: incident type already crossed (`incidents.incident_type`), close/reopen too; T0, building status and site clear were stored as events but never read back. Now projected into `incident_site_authority` (only rpc/rcc/admin change it) and read by every phone in the incident. `SITE_EXTRACTED_COUNTER_UPDATED` is no longer written (pre-evacuation report replaced it); `INCIDENT_TYPE_SET` classified local-only. Follow-up: a signed-in medic's incident type and `INCIDENT_TYPE_MISMATCH_REPORTED` still stay on the medic's phone |
| WP-9 Inventory on server | P2 | Done (V2.99.46): 061 + 062 live, verified 2026-10-21 | this PR | per D2: v1.1 renamed `inventory_ledger_v11_archived` (writes revoked); `INVENTORY_LEDGER_MOVEMENT` projected into `inventory_ledger_v12` with owner (medic bag / PC truck), count after the movement and the phone's time; `SUPPLY_CONSUMED` synced as audit only (no double count); direct client inserts closed; negative-stock alert per bag. Logistics/CC get incident-wide burn rate, each bag's and truck's latest count. Not done: company stock is still the `COMPANY_STOCK_BASELINE` constant (no flow changes it); starting quantities stay client constants (`SUPPLY_BASELINE`, `PC_TRUCK_BASELINE`), used only as initial values; `vw_command_inventory_burn_rate_v12.current_stock_available` sums deltas only, so it is not a stock figure |
| WP-10 Offline cold start | P2 | Done (V2.99.45) | this PR | `sw.js` (network-first page with a 4 s fallback, cache-first pinned supabase-js, never Supabase API calls, cache named by `APP_VERSION`), `manifest.webmanifest`, `icon.svg`; `check_repo.py` keeps the pinned URL equal in both files. Found while testing: a signed-in phone fell back to the login screen offline (profile read failed), so the last profile is now kept encrypted and used only when the server cannot be reached; re-checked when the network returns; removed on sign-out. Not verified yet on a real Android/iOS install |
| WP-11 Small loose ends | P3 | Part 1 done (V2.99.47): 063 live, sync-log v10, verified 2026-10-21. Part 2 PR A done (V2.99.48): 064 live, verified 2026-10-22. Part 2 PR B done (V2.99.50): 066 + 067 (live names 065/066) live, sync-log v11, verified 2026-10-22 | #93, #94, this PR | a manual sweep colour override is sent as `MSTART_OVERRIDE` (server: `conflict_log` with MSTART's colour, the medic's and the reason); `MSTART_SWEEP_COMPLETED` synced and shown on the PC's sweep board from its own events query; the sweep summary names the signed-in medic (it said the demo medic); `MSTART_SWEEP_COLOR_OVERRIDDEN`, `PATIENT_MARKED_NOT_SALVAGEABLE`, `SUSPECTED_NOT_SALVAGEABLE_CANCELLED`, `PRIORITY_RECOMMENDATION_DECLINED`, `RECOMMENDATION_ACKNOWLEDGED` classified local-only with reasons; `DEAD_MAN_SWITCH_ESCALATED` removed from the sync list (never written; WP-12 owns it). Part 2 PR A (D10): no drafts; a medic opens an official incident after a "join this instead?" list of the company's open incidents; PC, RCC, every RPC of the company until the PC or RCC chooses the platoon from the banner (then that platoon's RPC), and CC/chamal/admin get a banner until each acknowledges; the opener can cancel an empty incident as a false alarm. PR B (D8): CC, chamal or admin merge a duplicate incident from the picker (`merge_incident`, reason required): patients and their records move, colliding temporary ids are renamed and reported, events are re-tagged with `origin_incident_id`, the duplicate is closed as merged; `sync-log` v11 stores late pushes for the duplicate in the target and answers `redirected_to`; phones in the duplicate switch to the target. `EXTERNAL_REPORT_LINKED` moved to WP-16 (linking later); "leave incident" dropped (D9) |
| WP-12 Durable watchdog | P3 | Done (V2.99.58): 072 live, verified 2026-10-22 | this PR | `pg_cron` every minute raises tourniquet time (45/60/120 min) and red/yellow vitals-overdue alerts into `watchdog_alerts`, resolves them when they no longer apply; phones list a server alert only when they do not raise the same one themselves, marked "(שרת)", for command and the medic. Dead Man's Switch escalation and an outside channel (B1) not built |
| WP-13 Tests in CI | P3 | Done (2026-10-22) | this PR | `browser-and-smoke-tests` CI job runs every browser test, the other test scripts and the 34 smoke scripts through `scripts/run_tests.js` (`npm test`); `repo-check` stays the fast job; branch protection is the owner's GitHub setting |
| WP-14 Duplicate HTML, doc drift | P3 | Done (2026-10-20) | | D5: `demo/rescue-app.html` removed. Visible labels were stuck at V2.9934 since V2.99.34; fixed to match `APP_VERSION` and `check_repo.py` now checks them against `APP_VERSION`. Smoke scripts refreshed: no version pins (`scripts/lib/smoke_version.js`), stale assertions updated to the commits that changed the behaviour; all 34 pass. Docs: CLAUDE.md, README, DEVELOPMENT, ARCHITECTURE, PHASE_4_PLAN, ROADMAP, THREAT_MODEL, PRODUCTION_READINESS, FIELD_EXPERIMENT_GAPS |
| WP-16 Close ends access + stored AAR | P2 | PR A done (V2.99.52): 068 live (as 068, 068b, 068c), sync-log v12, verified 2026-10-22. PR B done (V2.99.53): 069 live, verified 2026-10-22 | #98, this PR | read policies on every patient table follow `app.can_read_incident_patients()` (closed = admin only); every close stores a statistics-only report (`aar_reports`, versioned); members and command read it via `get_incident_aar_reports()`; late records from offline phones accepted and counted; phones remove a closed incident's patients once all their records are sent; report screen "דוח סיכום"; PR B: an external report is linked to a patient later from its card (`EXTERNAL_REPORT_LINKED`, PC/CC/chamal/physician/admin, unlink too, never changes triage), direct client writes to `external_reports`/`external_patient_links` closed, stored report gains external reports and MDA vs field for linked casualties |
| WP-15 Unused server tables | P3 | Done 2026-10-22: 070 live, verified | this PR | 9 tables to schema `archive` with their rows (nothing dropped; `aar_reports` stays, WP-16): `device_sync_state`, `experiment_observer_notes`, `high_risk_override_confirmations`, `patient_edit_conflicts`, `sync_event_dependencies`, `supply_request_items`, `treatment_catalog`, `treatment_inventory_items`, `realtime_outbox` (19 rows); outbox writes stopped (`apply_event_projection_and_outbox` keeps its `conflict_log` part, `trg_draft_incident_approval_outbox` disabled, not dropped); `merge_incident()` edited from its live definition to drop its statements on those tables; analytics export no longer fetches `device_sync_state` |
| WP-17 Lost patients on a duplicate number | P0 | Client done (V2.99.51); `sync-log` deployed live as v13 on 2026-10-22 = the live v12 (D9, `database/068`, in `main` since V2.99.52) plus WP-17. Whoever deploys `sync-log` next must start from a file that has both; live two-phone check pending | this PR | found by the 2026-10-22 feature-map audit from live `sync_ingestion_errors`; ids carry the registrant's initials (owner decision); the server renames a clash instead of dropping the patient |
| WP-18 Evacuation point arrival | P2 | Done (V2.99.66): 076 + 077 + 078 live, `sync-log` v16, verified rolled back 2026-10-24; real two-phone check pending | #120, this PR | `PATIENT_EVAC_POINT_ARRIVED` (medic/paramedic/physician/PC), earliest phone time wins, moving vs arrived on every board with waiting minutes, no alert (owner). Open: rescue board wording, waiting time in the stored report, truck stock per evacuation point (gap 3) |
| Tourniquet 100 min + remind me later | P1 | Done (V2.99.70): `database/079` live, checked 2026-11-17 (WP-20) | #126 | owner 2026-10-26: alerts at 45/60/100/120 min, then every hour (3 h ... 6 h and on, phone only); banner buttons "open patient" / "remind me in N min" (5x2, 5x2, 2x1, 1x1), chip while put off, comes back vibrating; delays sent as `WATCHDOG_ALERT` reasons `tourniquet_snoozed` / `tourniquet_alert_opened`; PC/CC strip line, last delay vibrates PC/CC. "המרה ללחץ ישיר" on the patient screen: medic / PC up to 120 min, paramedic up to 4 h, physician up to 6 h (owner 2026-11-08), sent as `TOURNIQUET_RELEASED` reason `converted_direct_pressure`; phone-side check only |
| Tourniquet time from the body | P1 | Done (V2.99.72): `database/080` + `081` live, `sync-log` v17 live, checked 2026-11-17 (WP-20) | #128 | owner 2026-11-08: sweep asks "הונח עכשיו / היה על הפצוע"; enter / correct the time written on the body (all medical roles and admin, history kept); 5 min tolerance, 5-60 min later asks (type again / yesterday / no time), over 12 h asks; passed levels silent on every phone and the server; no time = nobody converts; admin converts with the physician's limits |
| WP-19 Stock movements reach the server | P1 | Client done (V2.99.73), no SQL; database check rolled back 2026-11-18; real-phone push pending (owner) | this PR | every stock event has a uuid patient or none; New Patient form stock sent after the create, net; abandoned form sent with no patient; bag per user, kept over new patients and reloads, below 0 allowed, "התיק חודש" (owner 2026-11-18) |
| WP-20 Finish #128, apply 079-081 | P1 | Done: 079, 080, 081 and `sync-log` v17 live, checked 2026-11-17 | #128 | 100-minute check on a real tourniquet runs in WP-21 |
| WP-21 Live two-phone run | P1 | Not started | | WP-0 part 2 plus WP-17/18/19, D1 offline, WP-10 install, T6 |
| WP-22 Open sync rejections | P2 | Done 2026-11-19: 55 closed with reasons (8 test data, 47 not recoverable), 0 open, rows kept | this PR | all in closed incidents, so admin only; stored copies removed by the nightly privacy job |
| WP-23 Injury time editable | P2 | Done in this PR (V2.99.81, `database/088`); `088` applied live (objects checked 2026-11-20, not in the migration list) | this PR | owner 2026-10-23 and 2026-11-18: CC may not edit; watchdog rows, MIST and stored report follow the injury time; newest entry by phone time wins; `handover-consume` change not deployed |
| WP-24 Command cancels a resupply request | P2 | Done (V2.99.75): `083` + `084` applied live by the owner (objects checked 2026-11-20, not in the migration list); `SUPPLY_REQUEST_CANCELLED` in deployed `sync-log` (v20 and v21); rolled-back live check passed 2026-11-20; live phone check pending | #133 | rescoped 2026-11-18: CC holds no stock, so no "fulfilled by company"; medic's escalation stays with the PC; cancel with a reason (cc/chamal/admin while open, PC before escalation); direct writes to `supply_requests` closed |
| WP-25 Medic incident type + mismatch | P2 | Done (V2.99.82): `089`, `090` live, `sync-log` v21 deployed, role check with real profiles passed 2026-11-20; `091` hardening applied live 2026-11-21 | #134, this PR | owner 2026-11-18: several types per incident; anyone adds, removing by the ladder rescue > PC/CC > medics against the adder (`090`). Medic's "not right" reports; PC/CC type section, never over rescue; one change at a time from boards. Removed from `known_gaps`. Every type in the picker, RCC table, stored report and analytics export: `092` (V2.99.83), applied live 2026-11-21 |
| WP-26 PC deterioration review | P2 | Done (V2.99.87, `094` applied live 2026-11-21, live test passed) | #148 | owner 2026-11-19/21: option A (052 table, own `request_kind`), PC + CC alert, tap + outcome, "אחר כך". Removed from `known_gaps`. Two-phone check still with WP-21 |
| WP-27 CC moves a site to another platoon | P2 | Not started, 1 design question | | owner 2026-10-23 (WP-7 remainder); RLS |
| WP-28 27 never-sent event types | P2 | Waiting on owner's list | | |
| WP-29 Dead Man's Switch on the server | P2 | Client + `095` done (V2.99.90); `095` not applied live, rolled-back live run pending | this PR | owner 2026-11-21: PC, CC, RCC / RPC; no heartbeat and no event 10 min; the medic's own registered open patients; per medic. Locked-screen false alarms to measure in WP-21 |
| WP-30 Telegram alerts (B1) | P2 | Waiting on owner's 19 answers | | |
| WP-31 MARCH completion + hands-on PC | P2 | Waiting on clinical criteria | | B2 |
| WP-32 Evacuation point leftovers | P2 | Step 1 done by `085` (RCC panel, #141): the rescue board tells moving from arrived (`evac_point_arrived_at`). Open: waiting time in the stored report | #141 | WP-18 remainder |
| WP-33 CC all-incidents alert rule | P3 | Done (V2.99.76), no SQL | this PR | owner 2026-11-18: one line per incident; a red patient counts until a vehicle takes them; "פצוע אדום" no longer fires after a vehicle took the patient |
| WP-34 Test gaps | P3 | Not started | | AAR screen test, analytics pytest in CI |
| WP-35 Record what is applied live | P3 | Started: `081`-`092` checked 2026-11-20/21 (all applied; only `085`, `090`, `091` listed); `004`-`080` left | | read-only |
| WP-36 Demo constants | P3 | Not started | | `SITE_A` x60, `PLT-A` x25 |
| WP-37 Unlink tombstone | P3 | Not started | | `database/069` known limit |
| WP-39 Evacuation point = נאפ"ל | P2 | Done (V2.99.77), no SQL | this PR | owner 2026-11-18; reverses WP-18's "נקודת פינוי"; one per site |
| WP-40 30 min at the נאפ"ל alert | P2 | Done (V2.99.78), no SQL | this PR | owner 2026-11-18/19: PC + CC, every colour but black, from the send, 30 warn / 60 critical |
| WP-41 Banner: patient to / at the נאפ"ל | P2 | Done (V2.99.79), no SQL | this PR | owner 2026-11-18/19; send + arrival, medic / paramedic / physician, open or close, 15 s |
| WP-38 Resupply raises the medic's bag | P2 | Done (V2.99.74): `database/082` applied live by the owner, `sync-log` v18 deployed 2026-11-18; live two-phone check pending | #132 | owner 2026-11-18: the medic confirms, by what arrived; the PC's / logistics' "delivered" = handed over, waiting for the medic |

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
