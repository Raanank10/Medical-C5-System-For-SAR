# C5 Sentinel-SAR — API Surface v0.7

The client-facing API is **sync-log-first**, not CRUD-first.

Mobile devices must never wait for REST confirmation before continuing clinical work. Every save writes to local SQLite first. Network delivery is asynchronous, idempotent, and retry-safe.

---

# 1. Client-Facing Sync API

## POST /sync/log

Primary write endpoint for mobile and web clients.

Purpose:
- push locally saved events to the server
- accept partial batches
- deduplicate by `device_id + local_event_id`
- return server cursors for pull continuation
- never require clinical events to be rewritten by the client

### Request

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
        "heart_rate": {"raw_count": 31, "window_seconds": 15, "calculated_bpm": 124, "entry_method": "stepper"},
        "respiratory_rate": {"raw_count": 16, "window_seconds": 30, "calculated_per_min": 32, "entry_method": "stepper"},
        "bp": "Carotid",
        "avpu": "Pain",
        "spo2": 91
      }
    }
  ]
}
```

### Response

```json
{
  "accepted": [
    {"local_event_id": "local-evt-001", "server_event_id": "uuid", "server_cursor": 1843}
  ],
  "duplicates": [],
  "rejected": [],
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

Clinical events should almost never be rejected. Bad-but-important data is accepted and flagged.

## GET /sync/log?incident_id=&since_cursor=&limit=

Primary pull endpoint.

- `since_cursor` maps to `events.sync_cursor`.
- Results are ordered by `sync_cursor asc`.
- Default limit: 500.
- Maximum limit: 2000.
- Client repeats until `has_more = false`.

### Response

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
      "payload_json": {"triage":"red"}
    }
  ],
  "next_cursor": 1844,
  "has_more": false
}
```

---

# 2. Immediate Sync Triggers

The app attempts immediate `/sync/log` after:

- draft incident created
- new patient / quick patient created
- vitals recorded
- treatment recorded
- tourniquet applied/released
- triage updated
- handover
- supply request
- building unstable
- Dead Man's Switch alert
- site clear

Fallback sync runs every 60–90 seconds with exponential retry: `5s → 15s → 30s → 60s → 90s max`.

---

# 3. Read APIs

```http
GET /incidents/:incidentId/dashboard
GET /incidents/:incidentId/patients
GET /patients/:patientId
GET /patients/:patientId/treatments
GET /incidents/:incidentId/inventory
GET /incidents/:incidentId/heatmap
GET /incidents/:incidentId/watchdog-alerts
GET /incidents/:incidentId/conflict-log
```

These are convenience read APIs. They are not the source of truth.

---

# 4. Command Actions

Command actions may be implemented as events through `/sync/log` or as thin wrappers that append events server-side:

```http
POST /incidents/:incidentId/confirm-draft
POST /incidents/:incidentId/merge-draft
POST /incidents/:incidentId/reject-draft
POST /sectors/:sectorId/site-clear
POST /sectors/:sectorId/building-status
```

---

# 5. AAR API

Generation is explicit.

```http
POST /incidents/:incidentId/aar/generate
GET  /incidents/:incidentId/aar
POST /incidents/:incidentId/aar/unlock
```

Recommended behavior:

1. `generate` creates/refreshes `aar_reports.report_json` from immutable events and KPI views.
2. `unlock` marks the generated report available for export after unlock conditions are met.
3. `GET` returns the current generated report.

---

# 6. Internal Worker APIs

Realtime outbox processing is internal only.

Do **not** expose these to mobile/web clients:

```http
GET /outbox/unprocessed
POST /outbox/:outboxId/processed
```

Only the backend worker/service-role process may read and mark `realtime_outbox` entries.
