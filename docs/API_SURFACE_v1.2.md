# C5 Sentinel-SAR — API Surface v1.2

v1.2 adds field-experiment export contracts, explicit assessment-debt metadata, alert acknowledgment events, local edit conflict markers, and logistics inventory-ledger movement events.

## v1.2 Event Additions

The static demo writes these to the local outbox; production `POST /sync/log` should accept them idempotently.

```json
{
  "type": "WATCHDOG_ACKNOWLEDGED",
  "payload_json": {
    "acknowledged_by_device": "PHONE-ALFA",
    "acknowledged_reason": "in_treatment"
  }
}
```

```json
{
  "type": "INVENTORY_LEDGER_MOVEMENT",
  "payload_json": {
    "item_type": "CAT_TOURNIQUET",
    "movement_type": "treatment_consumed",
    "quantity_delta": -1,
    "patient_context": "P001",
    "local_stock_after": -1
  }
}
```

```json
{
  "type": "PATIENT_EDIT_CONFLICT_DETECTED",
  "payload_json": {
    "patient_id": "P001",
    "opened_last_modified_at": "2026-05-20T10:00:00Z",
    "stored_last_modified_at": "2026-05-20T10:02:00Z"
  }
}
```

## v1.2 Experiment Export Artifacts

The browser demo can export:

- `experiment_events.csv`
- `patients_summary.csv`
- `aar_metrics.json`
- `observer_notes.csv`

These are field-test artifacts, not production clinical records.

The client-facing API is **sync-log-first**.
Mobile devices must never wait for REST confirmation before continuing clinical work.
Every save writes to local SQLite first. Network delivery is asynchronous, idempotent, retry-safe, and individually fault-tolerant.

---

# 1. Mobile Operational Rule

```text
Mobile UI reads from local SQLite only.
Mobile writes to local SQLite first.
Mobile pushes/pulls the event log in the background.
Mobile does not call REST GET endpoints for operational patient/inventory/vitals state.
```

If the data has not reached local SQLite through local action or sync pull, it is not operationally available to the medic.

---

# 2. POST /sync/log

Primary write endpoint for mobile and web command clients.

Purpose:
- push locally saved events to the server
- process every event independently
- accept partial batches
- deduplicate by `device_id + local_event_id`
- quarantine poison events without blocking the rest of the queue
- return server cursors for pull continuation

## Authentication

Deployed as a Supabase Edge Function at `/functions/v1/sync-log`, routed by HTTP method (`POST` = push, `GET` = pull). Requires `Authorization: Bearer <user JWT>` from a real Supabase Auth session — not a service-role key. The server looks up the caller's `profiles.role`/`is_active` from the JWT itself; it does **not** accept a client-supplied `actor_id` or `actor_role` — any such fields in the request body are ignored.

## Request

```json
{
  "device_id": "device-cohen",
  "incident_id": "10000000-0000-0000-0000-000000000001",
  "last_known_server_cursor": 1842,
  "events": [
    {
      "local_event_id": "local-evt-001",
      "type": "VITALS_RECORDED",
      "patient_id": "30000000-0000-0000-0000-000000000001",
      "local_timestamp": "2026-05-13T10:35:00Z",
      "payload_json": {
        "heart_rate": {
          "raw_count": 31,
          "window_seconds": 15,
          "calculated_bpm": 124,
          "entry_method": "stepper"
        },
        "respiratory_rate": {
          "raw_count": 16,
          "window_seconds": 30,
          "calculated_per_min": 32,
          "entry_method": "stepper"
        },
        "calculation_display": {
          "heart_rate": "31 beats in 15 seconds = 124 BPM",
          "respiratory_rate": "16 breaths in 30 seconds = 32/min"
        },
        "bp": "Carotid",
        "avpu": "Pain",
        "spo2": 91
      }
    }
  ]
}
```

`entry_method` is `stepper` for manual count controls, or `clinical_override` for explicit no-breathing respiratory-rate decisions.

## Processing semantics

The endpoint is batch-based, but the batch is **not one database transaction**.

The server processes each event with an independent savepoint / transaction unit:

```text
for event in events:
    validate envelope
    if duplicate: return duplicate
    if clinically incomplete but parseable: accept + flag
    if malformed/unparseable: quarantine + reject this event only
    continue processing next event
```

## Response

```json
{
  "accepted": [
    {
      "local_event_id": "local-evt-001",
      "server_event_id": "uuid",
      "server_cursor": 1843
    }
  ],
  "duplicates": [
    {
      "local_event_id": "already-sent-001",
      "server_event_id": "uuid",
      "server_cursor": 1838
    }
  ],
  "rejected": [
    {
      "local_event_id": "poison-evt-009",
      "terminal": true,
      "error_code": "MALFORMED_EVENT_ENVELOPE",
      "message": "Event could not be parsed into a valid envelope. Stored in sync_ingestion_errors. Do not retry unchanged."
    }
  ],
  "high_risk_flags": [
    {
      "local_event_id": "local-med-002",
      "severity": "critical",
      "code": "PEDIATRIC_MEDICATION_MISSING_WEIGHT",
      "message": "Medication saved but flagged for immediate review."
    }
  ],
  "field_conflicts": [
    {
      "local_event_id": "local-triage-004",
      "field": "current_triage",
      "won": false,
      "winning_role": "physician",
      "losing_role": "medic",
      "message": "Role-authority override on current_triage: physician edit (red) overrides medic edit (yellow)"
    }
  ],
  "next_pull_cursor": 1843,
  "redirected_to": null
}
```

`redirected_to` (sync-log v11, `database/067`): when the pushed `incident_id` was merged into another incident (closed with `metadata.merged_into`), the events are stored in that incident instead (following up to 5 merges) and `redirected_to` is its id; the client then switches to it. A patient created by such a late push whose temporary id the target already uses is created under the same renamed id rule as `merge_incident()`.

Clinical events should almost never be rejected. Bad-but-important clinical data is accepted and flagged.
Only malformed/unparseable envelopes are rejected and quarantined.

`field_conflicts` (F3, `docs/CONFLICT_RESOLUTION_DECISION.md`) reports whenever an event in this push batch was involved in a role-authority conflict resolution on `PATIENT_TRIAGE_UPDATED`/`PATIENT_STATUS_UPDATED` — read back from `conflict_log` by `sync-log` itself, not computed client-side. `won:false` means this device's own edit lost the tie-break; the field's projected value in `patients` reflects the winning edit either way. A parallel command-tier read (`conflict_log` where `conflict_type='PATIENT_FIELD_CONFLICT_DETECTED'`, RLS-gated the same as `sync_ingestion_errors`) covers every conflict for the incident, not just ones this device happened to push.

## Physician Clinical Death Confirmation Event

`PATIENT_DEATH_CONFIRMED` (`database/024`-`026`) is a real, physician-only event type — deliberately distinct from any legal/official death certification, which stays out of this repo's scope. Only submittable by `physician`; enforced at two layers, not just the Edge Function's `ROLE_ALLOWED_EVENT_TYPES`: `events_insert_by_role` itself carries a type-specific carve-out (`type <> 'PATIENT_DEATH_CONFIRMED' or actor_role = 'physician'`), needed because `project_patient_state()` runs `SECURITY DEFINER` and would otherwise let its own insert into the `death_confirmations` audit table bypass that table's RLS.

```json
{
  "type": "PATIENT_DEATH_CONFIRMED",
  "patient_id": "<uuid>",
  "local_timestamp": "2026-08-24T20:28:00.000Z",
  "payload_json": { "notes": "visual exam, no pulse/breath" }
}
```

Server-side, on acceptance: `patients.physician_death_confirmed_at`/`physician_death_confirmed_by` are set (idempotent via `coalesce()` — the first physician's confirmation wins if two somehow race), guarded to patients already field-tagged `current_status='deceased'` (a confirmation for any other patient is a silent no-op on `patients`, though the event itself is still logged); a row is written to `death_confirmations` (`incident_id`, `patient_id`, `event_id`, `actor_id`, `notes`, `confirmed_at`) unconditionally, as the durable audit record. Neither write touches `current_triage`/`current_status` — those are already `'black'`/`'deceased'` from the medic's earlier `PATIENT_TRIAGED_EXPECTANT` event; this is a second, later fact layered on top, not a replacement.

## Pediatric High-Risk Medication Event

For patients under age 8, adult-range medication doses must not be blocked in the field UI. The client requires an explicit double confirmation and appends override metadata to the local outbox.

```json
{
  "type": "MEDICATION_ADMINISTERED",
  "patient_id": "30000000-0000-0000-0000-000000000099",
  "payload_json": {
    "medication": "Fentanyl",
    "dosage": "100 mcg",
    "route": "BUCCAL",
    "is_pediatric_override": true,
    "high_risk_override": {
      "required": true,
      "confirmed_twice": true,
      "reason": "Emergency administration due to severe trauma; weight estimated via age group."
    }
  }
}
```

Backend projection:

- missing or false `confirmed_twice` creates a critical `HIGH_RISK_CLINICAL_VIOLATION` watchdog alert
- confirmed high-risk overrides create a warning `HIGH_RISK_PEDIATRIC_MEDICATION_OVERRIDE` alert for commander awareness and AAR review
- the clinical event remains immutable either way

## Binary Trap Status Event

The client no longer asks for partial/full/no-access during initial capture. Extraction state is recorded after vitals/triage as a binary rescue tasking event.

```json
{
  "type": "PATIENT_ACCESS_UPDATED",
  "patient_id": "30000000-0000-0000-0000-000000000099",
  "payload_json": {
    "trap_status": "trapped",
    "access_status": "trapped"
  }
}
```

Allowed client values:

- `trapped`
- `not_trapped`

Backend compatibility maps `not_trapped` to legacy `access_status = free`; legacy `partial` remains read-compatible but should not be emitted by new clients.

## Medical Handover Event (MIST / ATMIST)

When a medic completes `מסירת מצב רפואי לפינוי`, the client writes a local handover event before attempting network delivery.

**Implemented, both paths.** `handover_method:'mist_logged_local'` (`handoverPatient()`) is the primary offline-first path: no token fields, no external verification, MIST is read/spoken aloud to the receiving crew. `handover_method:'secure_qr_token'` (`generateQrHandover()`) is the secure-link path this section describes below: the client generates a random secret and its SHA-256 hash entirely offline (no live call needed to "issue" a token - the hash rides through the normal sync-log push like any other event field), then shows a link encoding `{token_hash, secret}` for the receiving unit. A separate, anon-callable Edge Function, `supabase/functions/handover-consume`, is the "backend endpoint" a receiving unit consumes the token through: it looks the row up by `token_hash` (unique), recomputes `SHA-256(secret)` and compares, checks `expires_at`/`consumed_at`, and returns a plain HTML MIST summary page - no Supabase account needed on the receiving side. One deliberate scope cut: the QR is rendered as a copyable/shareable link, not a scannable QR-code image - no QR-encoding library was added (`docs/DEVELOPMENT.md`'s no-new-dependency rule), and a real QR pointed at the same URL would behave identically once scanned. `token_signature` is HMAC-SHA256 over `token_hash` using the (intentionally public, `docs/THREAT_MODEL.md` T7) Supabase anon key as key material - defense-in-depth, not the actual security boundary, which is proof of possession of the random secret itself.

The UI may explain this as `מסירת מצב רפואי לפינוי` / MIST: mechanism, injuries, signs, and treatment. The receiving unit may scan a secure QR link, but the QR must contain a temporary encrypted token/signature, not embedded clinical files.

Example payload:

```json
{
  "device_id": "device-cohen",
  "incident_id": "10000000-0000-0000-0000-000000000001",
  "events": [
    {
      "local_event_id": "evt-mstart-mist-8812",
      "type": "PATIENT_HANDED_OVER",
      "patient_id": "30000000-0000-0000-0000-000000000099",
      "local_timestamp": "2026-05-19T21:30:15.123Z",
      "payload_json": {
        "handover_method": "secure_qr_token",
        "destination_facility": "Tel Hashomer (Sheba)",
        "receiving_unit_transport": "HELO_CHOPPER_12",
        "token_hash": "sha256:server-side-token-hash",
        "token_signature": "ed25519-or-hmac-signature",
        "encrypted_link": "https://handover.example/t/opaque-token",
        "token_expires_at": "2026-05-19T21:45:15.123Z",
        "mist_summary": {
          "mechanism": "Blast injury, structure collapse",
          "injuries": "Amputation right lower limb, blast lung",
          "signs": "HR 128, RR 26, AVPU=V",
          "treatment": "TQ x1 right thigh at 21:02, Morphine 10mg IV at 21:10"
        },
        "active_tourniquets_at_handover": 1,
        "device_telemetry": {
          "battery_percent": 34,
          "power_mode": "normal"
        }
      }
    }
  ]
}
```

Server projection rules:

- update `patients.current_status = 'handed_over'` — this is the final custody state; distinct from `'evacuating'`, which is a separate, earlier status set by `PATIENT_STATUS_UPDATED` when a patient leaves the incident site for the company collection point but is not yet formally handed to MDA (still under the platoon commander's supervision). A completed handover must not leave a patient looking identical to one still waiting at the collection point.
- set `patients.needs_full_assessment = false`
- set `patients.handed_over_at` and `patients.handed_over_to`
- resolve active vitals, reassessment, tourniquet, and missing-full-assessment watchdog alerts for that patient
- tag resolved alerts with `resolved_by_event_id`
- store token metadata in `patient_handover_tokens` when `token_hash` and `token_signature` are supplied
- skip the `current_status`/`handed_over_at`/`handed_over_to` update entirely if the patient is already in a terminal status (`deceased`, `handed_over`, `closed`, `self_evacuated`) — prevents a duplicate/replayed handover packet from silently reopening or overwriting a closed patient record. Watchdog-alert resolution and token-metadata storage are unconditional and idempotent regardless (resolving an already-resolved alert or inserting a token that already exists is a no-op, not an error)

Idempotency remains `device_id + local_event_id`. If a weak network resends the handover packet, the duplicate must not re-run treatment/status side effects.

## Black / Expectant Fast Exit Event

When a medic confirms Black triage, the client should skip remaining assessment, treatment, and medical handover forms and write a lightweight terminal event.

Canonical event type: `PATIENT_TRIAGED_EXPECTANT`.

```json
{
  "local_event_id": "evt-black-bypass-9912",
  "type": "PATIENT_TRIAGED_EXPECTANT",
  "patient_id": "30000000-0000-0000-0000-000000000099",
  "local_timestamp": "2026-05-19T21:44:00Z",
  "payload_json": {
    "current_triage": "black",
    "current_status": "deceased",
    "needs_full_assessment": false,
    "reason": "No spontaneous breathing after airway opening",
    "bypass_flow": true
  }
}
```

Server projection rules:

- set `patients.current_triage = 'black'`
- set `patients.current_status = 'deceased'`
- set `patients.needs_full_assessment = false`
- bypass normal vitals/intervention/medical handover completion requirements

## Patient Lifecycle Status Pipeline

`patients.current_status` is a projected operational custody state, not a manual form field.

| Status | Production meaning / trigger |
| --- | --- |
| `identified` | Point of impact. Quick Patient created or tag assigned, but no care started yet. |
| `stabilizing` | Care is ongoing at the treatment site, such as tourniquet, medication, or airway management. |
| `observing` | Care milestone completed; patient waits for extraction or reassessment. |
| `extricating` | Casualty is being physically moved through the structure or ruins. |
| `evacuating` | Left the incident site for the company collection point, still under the platoon commander's supervision - not yet formally handed to MDA. Set via `PATIENT_STATUS_UPDATED` (`payload_json.status = 'evacuating'`), an optional intermediate step before `handed_over`. |
| `handed_over` | Transferred to MDA / evacuation force through `מסירת מצב רפואי לפינוי` (MIST) or secure QR. Final custody state. |
| `deceased` | Black triage fast-path or casualty expired during care. |

The projection is event-driven (`project_patient_state()` in the schema - the single trigger function responsible for every `patients` column write from an event, after a 2026-08 fix consolidated two independent triggers that had raced on this exact projection):

- `PATIENT_TRIAGED_EXPECTANT` or payload `current_triage = black` -> `deceased`
- `TOURNIQUET_APPLIED`, `MEDICATION_ADMINISTERED`, `AIRWAY_MANAGED` -> `stabilizing`
- `VITALS_RECORDED` from stabilizing -> `observing`
- `PATIENT_STATUS_UPDATED` with payload `status` -> that status (e.g. `evacuating` for the collection-point step)
- `PATIENT_HANDED_OVER` -> `handed_over`

One deliberate exception to "single trigger function": `project_evacuation_tracking()` (`database/044`, V2.99.33) writes only `patients.evacuation_destination`, `mda_classification` and `evacuation_updated_at` (plus `version`/`updated_at`), from `PATIENT_HANDED_OVER` and `PATIENT_EVACUATION_UPDATED`, and inserts `external_reports` rows from `EXTERNAL_REPORT_CREATED`. It never touches triage, status or any column `project_patient_state()` owns, so the race that consolidation fixed cannot recur. It was kept separate so the triage-authority logic in `project_patient_state()` (021/041) did not have to be redefined to add three columns.

`PATIENT_HANDED_OVER` / `PATIENT_EVACUATION_UPDATED` evacuation fields (both optional, either may be sent alone):
- `destination_facility`: free text (hospital / receiving facility). Clients before V2.99.33 sent the placeholder `'pending'`; the projection ignores it.
- `mda_classification`: Magen David Adom's own scale, one of `minor` (קל), `anxiety` (נפגע חרדה), `moderate` (בינוני), `serious` (קשה), `critical` (אנוש), `deceased` (נקבע מותו). Recorded beside `current_triage`, never replacing it. Unknown values are ignored, not rejected.
- The newest `local_timestamp` wins, so an older offline update that syncs late cannot overwrite a newer one.

`EXTERNAL_REPORT_CREATED` payload: `source` (`mda`/`united_hatzalah`/`yedidim`/`police`/`idf`/`civilian`/`other`; anything else becomes `other`), `reported_red`/`reported_yellow`/`reported_green`/`reported_black`, `evacuation_destination`, `notes`, `external_reference` (the client's local report id, used to de-duplicate on pull), and optional `linked_patient_id` (kept in the payload rather than `events.patient_id` so a report about a patient that never synced cannot fail the events FK). Idempotent by `external_reports.source_event_id`.

`SITE_PRE_EVACUATION_REPORTED` (`database/049`/`050`, V2.99.36): casualties evacuated before the medical force arrived. Not patient-scoped (`patient_id` null). Payload: `groups` (array, at most 50) of `{count` (1-9999), `condition` (`light`/`moderate`/`severe`), `evacuated_by` (`mda`/`united_hatzalah`/`yedidim`/`fire`/`police`/`idf`/`civilian`/`self`/`other`; anything else becomes `other`), `destination` (free text, may be null)`}`, and `note`. Invalid rows are dropped, never raised. Each event carries the whole report and replaces the previous one. sync-log accepts it from medic/paramedic/physician/pc/cc/admin; `project_pre_evacuation()`, a separate trigger like 044's, decides what it does, reading the role from `profiles` by `actor_id` (not `events.actor_role`, which the client row supplies):
- no report for the incident yet: any of those roles creates `incident_pre_evacuations` (one row per incident). `insert ... on conflict do nothing` makes the first sync win when two medics sync at once.
- report exists: pc/cc/admin replace it, newest `local_timestamp` wins.
- anyone else: the event stays in the log, the report is unchanged, and a `conflict_log` row with `conflict_type = 'PRE_EVACUATION_REPORT_LOCKED'` (payload: rejected role/name, owner, the rejected groups) is written for command review.
`incident_pre_evacuations` is readable by anyone who can access the incident (`app.can_access_incident`) and has no write policy.

Medical reinforcement and death-certification requests (`database/051`/`052`, V2.99.38, WP-5). Not patient-scoped (`patient_id` null); linked casualties travel in the payload. Projected by `project_medical_resource_request()` into `medical_resource_requests`:
- `MEDICAL_REINFORCEMENT_REQUESTED` / `DOCTOR_DEATH_CERTIFICATION_REQUESTED` payload: `id` (the device's local request id; with the device id it is the idempotency key), `resourceType` (`one_medic`/`two_medics`/`paramedic`/`doctor_treatment`/`doctor_death_cert`/`urgent_evac`/`routine_evac`/`evac_coordination`/`cat_tourniquets`/`hemostatic_gauze`/`airway_equipment`/`iv_fluids`/`hypothermia_blankets`/`medical_equipment`; anything else creates no row; the death-certification event always means `doctor_death_cert`), `urgency` (`immediate`/`high`/`routine`, default `high`), `reasonCodes` (lowercase codes, at most 12), `linkedPatientIds` (uuids, at most 20), `siteId`, `targetLocation`, `freeText`, `quantity`, `autoGenerated`. Created by medic/paramedic/pc/cc/chamal/physician/admin.
- `MEDICAL_REINFORCEMENT_STATUS_UPDATED` payload: `request_id` (local id), `server_request_id` (the row's uuid once the device has pulled it; matched first, so any device can update a request), `status` (`pending`/`acknowledged`/`assigned`/`en_route`/`arrived`/`denied`/`cancelled`/`resolved`/`fulfilled`/`closed`) and/or `urgency`. Applied for pc/cc/chamal/physician/admin; the original requester may only cancel or change urgency. Newest `local_timestamp` wins. A refused update stays in the event log and changes nothing.
- `PATIENT_DEATH_CONFIRMED` (physician/admin) resolves the open death-certification requests linked to that patient.
Alert acknowledgment (`database/054`, V2.99.40, WP-4, decision D4). `WATCHDOG_ACKNOWLEDGED` is sent patient-scoped when someone presses "בטיפול" (payload: `patient_id`, informational `alert_kind`). `project_alert_acknowledgment()` sets `patients.alert_acknowledged_at` / `_by` / `_by_name` / `_by_role` (newest `local_timestamp` wins) and marks that patient's open, unacknowledged `watchdog_alerts` rows acknowledged. `WATCHDOG_ALERT` with `payload_json.reason = 'reescalated'` (sent when the patient gets worse after an acknowledgment: red/black triage, critical vitals) clears the patient's four columns when the acknowledgment is not newer; `watchdog_alerts.acknowledged_at` is kept as history. Any role may acknowledge; the name and role come from `profiles`.

Tourniquet follow-ups (`database/056`-`058`, V2.99.42, WP-2b). `TOURNIQUET_LIMB_RECORDED` (patient-scoped; payload `limb`, `previous_limb` default `unknown`, `application_time`, `tourniquet_id`) moves the matching active `tourniquets` row to the new limb. `TOURNIQUET_REASSESSMENT` may carry `tourniquet_status` `effective` or `bleeding_continues` (allowed by `tourniquets_tourniquet_status_check` since 058) and `next_reassessment_interval_minutes` (clamped 10-120). `PATIENT_HANDED_OVER` sets the patient's active tourniquet rows `is_active = false` without marking them released.

`medical_resource_requests` is readable (decision D3) by pc/cc/chamal/physician/admin with access to the incident, and by whoever made the request; it has no write policy.

Every branch above except the black-triage fast path refuses to run once a patient is already in a terminal status (`deceased`, `handed_over`, `closed`, `self_evacuated`) - a stray or replayed event cannot reopen or overwrite a closed patient record.

---

# 3. GET /sync/log

Primary pull endpoint.

```http
GET /sync/log?incident_id=<uuid>&since_cursor=<bigint>&limit=500
```

Rules:
- `since_cursor` maps to `events.sync_cursor`.
- Results are ordered by `sync_cursor ASC`.
- Default limit: 500.
- Maximum limit: 2000.
- Client repeats until `has_more = false`.

## Response

```json
{
  "events": [
    {
      "server_cursor": 1844,
      "server_event_id": "uuid",
      "device_id": "device-pc",
      "local_event_id": "pc-local-006",
      "type": "PATIENT_TRIAGE_UPDATED",
      "patient_id": "patient_uuid",
      "local_timestamp": "2026-05-13T10:36:00Z",
      "server_timestamp": "2026-05-13T10:36:03Z",
      "payload_json": {"triage": "red"}
    }
  ],
  "next_cursor": 1844,
  "has_more": false
}
```

## Client cursor behavior

The web client persists `since_cursor` per-incident in `localStorage` (`c5_sync_cursor_<incidentId>`), not globally — `sync_cursor` is a single shared sequence across all incidents server-side, but each incident's "how far this device has pulled" is tracked separately. A successful push also advances the stored cursor from the response's `next_pull_cursor`, so a device doesn't immediately re-pull events it just pushed itself. Pull runs on a 45s interval plus opportunistically right after a successful push, paginating via `has_more`/`next_cursor` until exhausted. Events whose `device_id` matches the pulling device are filtered out of the client's pulled-event feed (they're already represented locally via the outbox) — this is a client-side display choice, not a server-side filter.

---

# 4. Immediate Sync Triggers

The app attempts immediate `/sync/log` after:

- draft incident created
- new patient / quick patient created
- body-map injury zones updated
- vitals recorded
- treatment recorded
- tourniquet applied / reassessed / released
- triage updated
- handover
- supply request
- building unstable
- Dead Man's Switch alert
- site clear
- command context note

Fallback sync runs every 60–90 seconds with exponential retry:

```text
5s → 15s → 30s → 60s → 90s max
```

---

# 5. Command Dashboard APIs

These are not mobile operational APIs. They are service-role backed read models for חוג״ד / מ״פ רפואה / Chamal / Log-O dashboards.

```http
GET /command/incidents/:incidentId/dashboard-state
GET /command/incidents/:incidentId/heatmap
GET /command/incidents/:incidentId/inventory
GET /command/incidents/:incidentId/watchdog-alerts
GET /command/incidents/:incidentId/watchdog-alerts?severity=critical
GET /command/incidents/:incidentId/conflict-log
GET /command/incidents/:incidentId/aar/live-timeline
```

Dashboard aggregation should use precomputed current-state tables/materialized views, not repeated heavy joins over raw events.

Command alert slicers should read severity-aware alert views. `critical` alerts are shown separately from routine reminders so medics and חוג״דים are not overwhelmed by low-priority operational debt.

---

# 6. Command Actions

Command actions may be implemented as events through `/sync/log` or as thin server-side wrappers that append events.

```http
POST /command/incidents/:incidentId/confirm-draft   (superseded by D10: no drafts)
POST /command/incidents/:incidentId/merge-draft     (superseded by D8/D10: merge_incident(), database/067)
POST /command/incidents/:incidentId/reject-draft    (superseded by D10: no drafts)
POST /command/sectors/:sectorId/site-clear
POST /command/sectors/:sectorId/building-status
POST /command/incidents/:incidentId/aar/context-note
POST /command/incidents/:incidentId/aar/voice-memo
```

**Partly implemented**: `confirm-draft` and `reject-draft` exist as `confirm_draft()`/`reject_draft()` RPCs (`database/038_incident_lifecycle_rpcs.sql`) - see "Incident Lifecycle API" below. `merge-draft` is not built yet.

---

# 7. AAR API

The AAR is continuously built during the incident.

```http
GET  /command/incidents/:incidentId/aar/live-timeline
POST /command/incidents/:incidentId/aar/context-note
POST /command/incidents/:incidentId/aar/voice-memo
POST /command/incidents/:incidentId/aar/generate-final
GET  /command/incidents/:incidentId/aar
POST /command/incidents/:incidentId/aar/unlock
```

Behavior:
1. Rolling timeline is updated throughout the incident.
2. Commanders may attach context notes or voice memo metadata during the incident.
3. `generate-final` produces the exportable report after unlock conditions are satisfied.
4. `unlock` marks the report available for PDF/export.

---

# 8. Internal Worker APIs

Realtime outbox processing is internal-only. It has no client-facing route. Only backend worker/service-role code may read and mark `realtime_outbox` entries as processed.


---

# 9. v1.1 Alignment Notes

## Atomic Individual Event Processing

`POST /sync/log` must not wrap the entire batch in a single all-or-nothing database transaction.

Required server behavior:

```text
for each event:
  begin independent savepoint/transaction unit
  if valid or clinically incomplete:
    insert event
    run projection/safety triggers
    return accepted/high_risk_flags
  if duplicate:
    return duplicate
  if malformed/unparseable:
    insert sync_ingestion_errors
    return rejected for that event only
  continue
```

A poison event must never trap the device in an infinite retry loop. Rejected poison events are marked `terminal: true` unless the server says otherwise.

## No Mobile Convenience Reads

Mobile operational screens must not call command GET APIs for patient/vitals/inventory state. They read local SQLite only. Pull sync is the only mechanism that updates mobile operational state from the server.

## Internal Outbox

`realtime_outbox` remains internal-only. There is no public outbox route.

## Command State Reads

Dashboard read APIs should read from precomputed command state such as `incident_command_state`, not raw event joins on every request.


## RLS and Membership Scope

Direct table access is scoped by `incident_memberships`. Mobile clients should normally avoid direct table reads/writes and use local SQLite plus `/sync/log`, but any fallback direct access must still be incident-scoped.

`index.html`'s periodic patient-state projection pull (`pullProjectedPatientState`, `docs/ROADMAP.md` Phase 3) is a deliberate use of this fallback: it reads the `patients` table directly (RLS-scoped via `patients_read_authenticated`) rather than extending `/sync/log`'s response, specifically to avoid re-implementing `project_patient_state()`'s triage/status projection logic a second time client-side — see that trigger's own history (`database/013_consolidate_patient_status_projection.sql`) for why a second copy of that logic is a real risk, not a theoretical one. If `/sync/log` is ever extended to carry projected snapshots directly, this should move onto that path instead.


---

# v1.1 Sync and Command API Updates

## Dependency-Aware `POST /sync/log`

The sync endpoint processes events individually, but not blindly. Events may declare dependencies.

### Patient row creation

`PATIENT_CREATED`, `QUICK_PATIENT_CREATED`, and `FIRST_RESPONDER_REPORT` (rpc/rcc's only patient-creating event type — they're never allowed to write the other two) create the `patients` row on first sight, keyed by the event's top-level `patient_id` (must be a real UUID, generated client-side) and `payload_json.visual_id` (the human-readable display id, e.g. `P-004`). This runs via the caller's own JWT, so the `patients_insert` RLS policy is the real gate, not duplicated logic in the function. A retried push with the same `patient_id` is idempotent (treated as success, not an error). `patients` has `UNIQUE (incident_id, visual_id)`. Signed in, the client puts the registrant's initials in the id (`P004-DK`, sweep markers `TMP-004-DK`, V2.99.51) so two phones offline at once do not pick the same one. Ids are Latin letters, digits and `-` only: a Hebrew name's initials are transliterated (`דני כהן` gives `DK`), falling back to the email address and then the device id. If another patient in the incident still has this `visual_id` (two people with the same initials, or a merged incident), `sync-log` creates the patient under `<visual_id>-<last 4 characters of the device id>` (after a merge, of the duplicate incident's id, as `merge_incident()` does), returns it as `patient_visual_id` on that accepted entry, and the phone shows it at once and on every pull. Before V2.99.51 such a clash was also taken as a retried push, so the patient was never created and its events failed the foreign key (9 sweep patients lost live, 2026-10-20). If no free name is found after 5 tries the event is rejected with `PATIENT_CREATE_FAILED`. `t_injury` (required by the schema) currently falls back to the event's own `local_timestamp` — there's no real injury-time capture client-side yet; this is a known, deliberate gap, not a silent one. Any event referencing a `patient_id` before its creating event has been accepted will fail its foreign key and land in `sync_ingestion_errors` like any other malformed event.

### Request envelope

```json
{
  "device_id": "demo-device-cohen",
  "battery_percent": 78,
  "power_mode": "normal",
  "last_pull_cursor": 12345,
  "events": [
    {
      "local_event_id": "evt-001",
      "type": "PATIENT_CREATED",
      "incident_id": "10000000-0000-0000-0000-000000000001",
      "patient_id": "30000000-0000-0000-0000-000000000099",
      "local_timestamp": "2026-05-13T10:00:00Z",
      "payload_json": { "visual_id": "P-004" },
      "depends_on": []
    },
    {
      "local_event_id": "evt-002",
      "type": "VITALS_RECORDED",
      "incident_id": "10000000-0000-0000-0000-000000000001",
      "local_timestamp": "2026-05-13T10:01:00Z",
      "payload_json": { "heart_rate": { "raw_count": 25, "window_seconds": 15, "calculated_bpm": 100, "entry_method": "stepper" } },
      "depends_on": [
        { "device_id": "demo-device-cohen", "local_event_id": "evt-001" }
      ]
    }
  ]
}
```

### Response

```json
{
  "server_time": "2026-05-13T10:01:05Z",
  "accepted": [
    { "local_event_id": "evt-001", "event_id": "uuid", "sync_cursor": 12346 }
  ],
  "duplicates": [],
  "blocked_dependency": [
    {
      "local_event_id": "evt-002",
      "parent_local_event_id": "evt-001",
      "reason": "parent_rejected_or_quarantined"
    }
  ],
  "rejected": [],
  "high_risk_flags": [],
  "field_conflicts": []
}
```

If a parent event is malformed, dependent child events are stored in `sync_ingestion_errors` with `dependency_status = blocked_dependency`. They are not inserted into the clinical event log as orphans.

## Data Freshness in Pull Response

`GET /sync/log` returns:

```json
{
  "server_time": "2026-05-13T10:05:00Z",
  "next_cursor": 12390,
  "events": [],
  "freshness": {
    "last_successful_pull_at": "2026-05-13T10:04:50Z",
    "stale_after_seconds": 60,
    "critical_stale_after_seconds": 300
  }
}
```

The mobile app must update its local `device_sync_state` and show freshness warnings from SQLite, not from a live network call.

## Adaptive Sync

Mobile client includes `battery_percent` and `power_mode` in sync envelopes. The server records this for command visibility. The client locally decides which noncritical event classes to defer when in `critical_only` mode.

## Command Dashboard API

Command dashboard APIs read from `incident_command_state`, a precomputed snapshot table.

```http
GET /command/incidents/:incidentId/state
```

This endpoint uses one API-level permission check. It must not perform RLS-heavy joins over `events` for routine dashboard refreshes.

**Implemented** (`database/014_command_dashboard_state_rpc.sql`, `docs/ROADMAP.md` Phase 3) as `get_incident_command_state(p_incident_id uuid)`, a `SECURITY DEFINER` Postgres function callable via `client.rpc('get_incident_command_state', {p_incident_id})` — not a literal HTTP path, same as `/sync/log` being a real Edge Function rather than a literal `/sync/log` route (`docs/ARCHITECTURE.md`'s "Backend Deployment Status"). `incident_command_state` has RLS disabled and `EXECUTE`/table grants revoked from `anon`/`authenticated` by design, so this function — which performs the same `app.can_access_incident()` gate used by every other RLS policy in this schema, then returns the row — is the only permitted read path for a non-service-role caller. `index.html` polls it every 45s (same interval as sync push/pull) rather than the 5-second interval recommended below.

As of `database/030`/`031`, the row's `state_json` column carries more than the flat aggregate columns: `state_json.sectors` is a real per-building/floor breakdown (sourced from `vw_command_spatial_heatmap`, refreshed by the same `refresh_incident_command_state()` trigger as everything else in this table) — triage counts and a structural-danger flag per sector. The command dashboard's sector heatmap panel now reads this as its primary source when connected and synced, falling back to a locally-computed equivalent only offline/in local-demo mode (`docs/PRODUCTION_READINESS.md`). The rest of the dashboard (reinforcement requests, device/sync counts, per-patient watchdog detail, per-sector inventory) still has no equivalent in this snapshot and stays local-primary with the numeric summary shown as a labeled server-authoritative cross-check, not a replacement.

Recommended dashboard behavior:

- poll `GET /command/incidents/:incidentId/state` on a fixed interval such as 5 seconds
- do not recalculate command aggregates on arbitrary button clicks
- use `vw_command_incident_throughput_funnel` for backend analytics and AAR throughput analysis, not as the hot dashboard endpoint

## Logistics Resupply Queue API

Backs the Logistics Hub's supply request queue (`C5_SENTINEL_SAR_MVP_SPEC_v1.2.md` §5.6).

```http
GET /logistics/incidents/:incidentId/supply-requests
```

**Implemented** (`database/033_supply_request_projection.sql`) as `get_supply_request_queue(p_incident_id uuid)`, a `SECURITY DEFINER` Postgres function callable via `client.rpc('get_supply_request_queue', {p_incident_id})` — same non-literal-HTTP-path pattern as `get_incident_command_state` above, and the same `app.can_access_incident()` gate. Unlike `incident_command_state`, `supply_requests` is a real per-row table (not a precomputed snapshot), so this function is plain `RETURN QUERY` over it rather than a single-row lookup.

The write side is a trigger, not a client-facing endpoint: `project_supply_request_event()` runs `AFTER INSERT ON events` (mirroring `project_patient_state()`) and projects the medic's existing resupply-request creation/escalation events, plus the schema-native `SUPPLY_REQUEST_DISPATCHED`/`SUPPLY_REQUEST_IN_TRANSIT`/`SUPPLY_REQUEST_RECEIVED` event types, into real `supply_requests` rows. A client's local request id (e.g. `REQ-SUP-001`) is only unique per-device, so rows are keyed by `(origin_device_id, origin_client_request_id)` for idempotency rather than by that id alone.

`index.html` polls this every 45s (same cadence as `get_incident_command_state`), and renders it on the pc, cc, and logistics boards — with the PC decision (approve from truck / truck unavailable / escalate / delivered, sent with `payload_json.supply_request_id`) on pc/cc since V2.99.43 (`database/059`: only pc/cc/admin change the row), and real dispatch/runner-assign write actions on the logistics screen (log_o-only, per `AUTH_MATRIX`'s "Dispatch resupply runner"). `supply_request_items` (the schema's normalized, `inventory_items`-FK'd item table) is deliberately left unpopulated by the trigger: its vocabulary (`inventory_items.sku` values like `TQ`/`COMBAT_GAUZE`) doesn't match the client's real item keys (`tourniquets`/`pressureDressings`/etc.) — the same mismatch `inventory_ledger_v12` already exists to route around for `inventory_ledger`. Items are carried instead on a plain `items_json` column on `supply_requests`.

Dispatch/runner-assign is real, not simulated: the logistics screen writes `SUPPLY_REQUEST_DISPATCHED` (with `runner_name`/`eta_minutes`), `SUPPLY_REQUEST_IN_TRANSIT`, and `SUPPLY_REQUEST_RECEIVED` — the schema-native event types `SUPPLY_LOGISTICS_EVENTS` already allow-listed for `logistics_officer` before this session, previously unused by the client. `database/034_supply_request_dispatch_by_real_id.sql` fixes a real bug `033`'s own live-verification missed: the trigger's update path originally resolved the target row via `(device_id, client-local id)`, which assumes the update comes from the same device that created the request — never true for dispatch, since the whole point is a logistics device acting on a medic's request. Fixed by having these three event types carry `payload_json.supply_request_id` (the real server UUID, known once the client has pulled the row via `get_supply_request_queue`) and resolving by that instead; live-verified with a three-device chain (medic creates, a different device dispatches, a third marks in-transit) before merge.

## Incident Lifecycle API

Lets an incident come into existence from the field instead of from seed data (`C5_SENTINEL_SAR_MVP_SPEC_v1.2.md` sec 141, 202-221). **Implemented** (`database/038_incident_lifecycle_rpcs.sql`) as six `SECURITY DEFINER` RPCs called via `client.rpc(...)`, same non-literal-HTTP-path pattern as `get_incident_command_state`. Each does its own role check; `EXECUTE` is granted to `authenticated` only.

| RPC | Who | What it does |
|---|---|---|
| `open_incident(p_incident_id, p_location_name, p_address?, p_incident_type?, p_t_zero?, p_device_id?, p_local_event_id?)` | medic, paramedic, pc, cc, chamal, admin, physician, rpc, rcc -> `active` (since `064`, D10: no drafts); logistics_officer denied | Creates the incident with a client-generated id (a retry by the same opener returns the existing row with `created:false`; anyone else reusing the id gets `23505`), generates `visual_id` (`INC-YYMMDD-XXXXXX`), sets the opener's company (pc, rcc, rpc, medic, paramedic) and platoon (rpc, medic, paramedic, when the roster sets one), makes the opener a member, appends `INCIDENT_OPENED` (payload carries `opened_by_role`, `company_id`, `platoon_id`), and seeds `incident_command_state`. |
| `list_open_incidents()` | any active profile | Minimal header fields of every `draft`/`staging`/`active` incident: id, visual_id, location, address, type, status, t_zero, opened_at, opener display name, draft_acknowledged_at, patient count, and whether the caller is a member. No clinical data. |
| `join_incident(p_incident_id)` | any active profile; pc/rpc/rcc/medic/paramedic only where `app.can_access_incident` allows (`045`/`053`), and since `064` a medic or paramedic also into an open incident of their own company | Adds the caller's own `incident_memberships` row (`role_at_incident` = their role). Only for `draft`/`staging`/`active` incidents. Idempotent. |
| `confirm_draft(p_incident_id, p_device_id?, p_local_event_id?)` | command roles (`app.is_command_role()`: pc, cc, chamal, admin, physician) | `draft` -> `active`, stamps `confirmed_by/at` and `draft_resolved_at`, clears the incident's patients' `pending_incident_approval`, makes the confirmer a member, appends `INCIDENT_CONFIRMED`. Idempotent. |
| `reject_draft(p_incident_id, p_reason?, p_device_id?, p_local_event_id?)` | command roles | `draft` -> `closed` with `metadata.draft_resolution='rejected'`. Nothing is deleted; the patients keep `pending_incident_approval=true`. Appends `INCIDENT_DRAFT_REJECTED`. Idempotent. |
| `acknowledge_draft(p_incident_id)` | command roles | Stamps `draft_acknowledged_by/at` so the approval banner stops blinking, without confirming or rejecting. |
| `list_unit_open_incidents()` (`064`) | any active profile | Header fields of the active incidents of the caller's company opened in the last 12 hours, with patient count and whether the caller is a member. The client shows them to a medic or paramedic before `open_incident` ("join this instead?"). Empty when the caller has no company. |
| `list_incident_open_alerts()` (`064`) | pc, rcc, rpc, cc, chamal, admin (others get no rows) | Incidents a medic or paramedic opened in the last 24 hours that the caller has not acknowledged: active ones, and ones the opener cancelled as a false alarm. pc and rcc get their own company's; rpc its own platoon's, plus (`064d`) every incident of its company whose platoon is not chosen yet; cc/chamal/admin all. Flags: `no_unit` (no company), `needs_platoon` (company set, platoon not), `cancelled` with `cancel_reason`. |
| `acknowledge_incident_opened(p_incident_id)` (`064`) | pc, rcc, rpc, cc, chamal, admin, with access to the incident (an rpc also for its company's incident with no platoon yet, `064d`) | Records the caller's own acknowledgment (`incident_open_acknowledgments`); the incident leaves only the caller's banner. Idempotent. |
| `set_incident_platoon(p_incident_id, p_platoon_id)` (`064`) | the incident company's pc or rcc, or company-level command (`app.is_unit_manager()`) | Sets the platoon of an incident (an active platoon of the incident's company), which informs that platoon's rpc. Passes the unit guard (`053`) through its own flag, and the guard still writes `unit_audit`. |
| `merge_incident(p_source_id, p_target_id, p_reason, p_device_id?, p_local_event_id?)` (`067`, D8) | cc, chamal, admin | Merges a duplicate open incident (source) into another open incident (target); reason required. Moves the source's patients and every per-incident record to the target; a temporary patient id the target already uses is renamed `<id>-<last 4 characters of the source's visual id>` (a counter if taken), listed in `renamed_patients`. Sectors, memberships, device rows, active alerts, site authority and the pre-evacuation report follow the rules in the file header (no duplicates; the target's own values win, the source's fill gaps; a second pre-evacuation report stays on the source and `pre_evacuation_kept_on_source` says so). Events are re-tagged to the target with `events.origin_incident_id` = the incident they were first recorded in (the one exception to append-only, allowed only inside this function). The source is closed with `metadata.merged_into {target_id, target_visual_id, at, by, reason}` and an `INCIDENT_CLOSED` event; the target gets an `INCIDENT_MERGED` event with the counts and renames. Returns `{changed, moved, renamed_patients, pre_evacuation_kept_on_source, target_visual_id}`; a repeat returns `changed:false`. |
| `cancel_incident_false_alarm(p_incident_id, p_reason?, p_device_id?, p_local_event_id?)` (`064`) | the opener only | Only while the incident is `active` and has no patients: closes it through the close guard (`040`) with `metadata.false_alarm {reason, at, by}` and appends `INCIDENT_CLOSED` with `false_alarm: true`. A repeat returns `changed:false`. After a reopen, a later ordinary close is not a false alarm (`app.is_false_alarm_close`: `false_alarm.at` equals `closed_at`). |

Joining is recorded on the membership row itself (`assigned_by`, `created_at`); there is no join event type. Since `064` (D10) the client no longer opens drafts or calls `confirm_draft` / `reject_draft` / `acknowledge_draft`; they stay on the server for history. Draft merge (`INCIDENT_DRAFT_MERGED`) is replaced by merging duplicate official incidents (D8, WP-11 part 2, not built yet).

### Closing and reopening (`database/040_close_incident_guard.sql`)

An incident cannot be closed while any of its patients is still open: `current_status` not in `handed_over`, `closed`, `self_evacuated`, `deceased` (`evacuating` counts as open, the patient has not been handed over yet).

| RPC | Who | What it does |
|---|---|---|
| `close_incident(p_incident_id, p_override_reason?, p_device_id?, p_local_event_id?)` | pc, cc, chamal, admin, physician, rpc, rcc (plus `app.can_access_incident`) | No open patients: closes (`status='closed'`, `closed_by/at`) and appends `INCIDENT_CLOSED`. Open patients and no usable override: changes nothing and returns `{closed:false, open_patient_count, open_patients:[{id, visual_id, triage, status}], can_override, reason_required}`. Override: only pc/cc/chamal/admin/physician, only with a non-blank reason; the reason, role and the list of patients still open are stored in `incidents.metadata.close_override` and in the `INCIDENT_CLOSED` payload. rpc/rcc can never override. A draft cannot be closed (confirm or reject it). Closing a closed incident returns `{closed:true, changed:false}`. |
| `reopen_incident(p_incident_id, p_device_id?, p_local_event_id?)` | same roles | `closed` -> `active`, appends `INCIDENT_REOPENED`. A rejected draft cannot be reopened. |

Since `database/068` (D9) a close also ends patient access for everyone but admin and stores a statistics-only report (trigger `trg_store_incident_aar_on_close`, `app.build_incident_aar()`, one locked `aar_reports` row per close with its `version`; not for a duplicate closed by `merge_incident()`). `get_incident_aar_reports(p_incident_id)` (members, and pc / rcc / cc / chamal / physician / admin with access) returns `{status, closed_at, late_records_after_close, reports: [{version, generated_at, report}]}`, newest version first. Clients can no longer write `aar_reports`. `sync-log` v12 accepts pushes for a closed incident and answers `incident_closed: true` with `server_event_id` / `server_cursor` null (the caller cannot read the rows back).

A `BEFORE UPDATE OF status` trigger (`app.guard_incident_close()`) rejects (`42501`) any other transition to `closed` made by a signed-in user, so the `incidents_update` RLS policy can no longer be used to close an incident directly. Only `close_incident()` and `reject_draft()` pass it. Service-role and migration updates (no `auth.uid()`) are not affected. Closing needs a server round trip: an offline device cannot close an incident.

## High-Risk Override Payload

Medication/treatment events with safety issues should include:

```json
{
  "high_risk_override": {
    "required": true,
    "confirmed_twice": true,
    "reason": "Emergency administration; weight unavailable during extraction",
    "confirmed_at": "2026-05-13T10:02:00Z"
  }
}
```

If the payload lacks this metadata, the server still accepts the event where possible and creates a high-risk violation alert.
