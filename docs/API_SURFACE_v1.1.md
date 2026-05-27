# C5 Sentinel-SAR — API Surface v1.1

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

## Request

```json
{
  "device_id": "device-cohen",
  "actor_id": "00000000-0000-0000-0000-000000000001",
  "incident_id": "10000000-0000-0000-0000-000000000001",
  "last_known_server_cursor": 1842,
  "events": [
    {
      "local_event_id": "local-evt-001",
      "type": "VITALS_RECORDED",
      "patient_id": "30000000-0000-0000-0000-000000000001",
      "actor_role": "medic",
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
  "next_pull_cursor": 1843
}
```

Clinical events should almost never be rejected. Bad-but-important clinical data is accepted and flagged.
Only malformed/unparseable envelopes are rejected and quarantined.

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

The UI may explain this as MIST/ATMIST: mechanism, injuries, signs, and treatment. The receiving unit may scan a secure QR link, but the QR must contain a temporary encrypted token/signature, not embedded clinical files.

Example payload:

```json
{
  "device_id": "device-cohen",
  "actor_id": "00000000-0000-0000-0000-000000000001",
  "incident_id": "10000000-0000-0000-0000-000000000001",
  "events": [
    {
      "local_event_id": "evt-mstart-mist-8812",
      "type": "PATIENT_HANDED_OVER",
      "patient_id": "30000000-0000-0000-0000-000000000099",
      "actor_role": "medic",
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

- update `patients.current_status = 'evacuating'`
- set `patients.needs_full_assessment = false`
- set `patients.handed_over_at` and `patients.handed_over_to`
- resolve active vitals, reassessment, tourniquet, and missing-full-assessment watchdog alerts for that patient
- tag resolved alerts with `resolved_by_event_id`
- store token metadata in `patient_handover_tokens` when `token_hash` and `token_signature` are supplied

Idempotency remains `device_id + local_event_id`. If a weak network resends the handover packet, the duplicate must not re-run treatment/status side effects.

## Black / Expectant Fast Exit Event

When a medic confirms Black triage, the client should skip remaining assessment, treatment, and MIST forms and write a lightweight terminal event.

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
- bypass normal vitals/intervention/MIST completion requirements

## Patient Lifecycle Status Pipeline

`patients.current_status` is a projected operational custody state, not a manual form field.

| Status | Production meaning / trigger |
| --- | --- |
| `identified` | Point of impact. Quick Patient created or tag assigned, but no care started yet. |
| `stabilizing` | Care is ongoing at the treatment site, such as tourniquet, medication, or airway management. |
| `observing` | Care milestone completed; patient waits for extraction or reassessment. |
| `extricating` | Casualty is being physically moved through the structure or ruins. |
| `evacuating` | Loaded into vehicle/chopper or handed over through MIST/secure QR. |
| `deceased` | Black triage fast-path or casualty expired during care. |

The projection is event-driven:

- `PATIENT_TRIAGED_EXPECTANT` or payload `current_triage = black` -> `deceased`
- `TOURNIQUET_APPLIED`, `MEDICATION_ADMINISTERED`, `AIRWAY_MANAGED` -> `stabilizing`
- `VITALS_RECORDED` from stabilizing -> `observing`
- `PATIENT_HANDED_OVER` -> `evacuating`

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
POST /command/incidents/:incidentId/confirm-draft
POST /command/incidents/:incidentId/merge-draft
POST /command/incidents/:incidentId/reject-draft
POST /command/sectors/:sectorId/site-clear
POST /command/sectors/:sectorId/building-status
POST /command/incidents/:incidentId/aar/context-note
POST /command/incidents/:incidentId/aar/voice-memo
```

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


---

# v1.1 Sync and Command API Updates

## Dependency-Aware `POST /sync/log`

The sync endpoint processes events individually, but not blindly. Events may declare dependencies.

### Request envelope

```json
{
  "device_id": "demo-device-cohen",
  "actor_id": "00000000-0000-0000-0000-000000000001",
  "battery_percent": 78,
  "power_mode": "normal",
  "last_pull_cursor": 12345,
  "events": [
    {
      "local_event_id": "evt-001",
      "type": "PATIENT_CREATED",
      "incident_id": "10000000-0000-0000-0000-000000000001",
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
  "high_risk_flags": []
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

Recommended dashboard behavior:

- poll `GET /command/incidents/:incidentId/state` on a fixed interval such as 5 seconds
- do not recalculate command aggregates on arbitrary button clicks
- use `vw_command_incident_throughput_funnel` for backend analytics and AAR throughput analysis, not as the hot dashboard endpoint

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
