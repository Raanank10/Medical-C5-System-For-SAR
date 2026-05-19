# C5 Sentinel-SAR API Surface v0.6

## Incident

```http
POST /incidents/draft
POST /incidents
POST /incidents/:incidentId/confirm-draft
POST /incidents/:incidentId/close
POST /incidents/:incidentId/reopen
GET  /incidents/:incidentId/dashboard
```

## Patients

```http
POST /patients
POST /patients/quick
GET  /incidents/:incidentId/patients
GET  /patients/:patientId
POST /patients/:patientId/handover
```

## Events / Sync

```http
POST /events
POST /sync/push
GET  /sync/pull?incident_id=&since_cursor=
GET  /outbox/unprocessed
POST /outbox/:outboxId/processed
```

## Logistics

```http
GET  /incidents/:incidentId/inventory
POST /inventory-ledger
POST /supply-requests
POST /supply-requests/:requestId/dispatch
POST /supply-requests/:requestId/in-transit
POST /supply-requests/:requestId/delivered
```

## Watchdogs / Conflict

```http
GET  /incidents/:incidentId/watchdog-alerts
POST /watchdog-alerts/:alertId/acknowledge
POST /watchdog-alerts/:alertId/resolve
GET  /incidents/:incidentId/conflict-log
```

## Command

```http
POST /sectors/:sectorId/site-clear
POST /sectors/:sectorId/building-status
GET  /incidents/:incidentId/heatmap
GET  /incidents/:incidentId/aar
POST /incidents/:incidentId/aar/unlock
```


---

# v0.6 API Changes

## Realtime Outbox / Sync Echo Protection

Realtime messages now include:

```json
{
  "origin_device_id": "device-123"
}
```

Client rule:

```text
if message.origin_device_id == currentDeviceId:
    ignore message
else:
    apply remote event/projection update
```

## Vitals Timer Payload

`POST /events` with `type = VITALS_RECORDED` should use:

```json
{
  "heart_rate": {
    "raw_count": 31,
    "window_seconds": 15,
    "calculated_bpm": 124
  },
  "respiratory_rate": {
    "raw_count": 16,
    "window_seconds": 30,
    "calculated_per_min": 32
  },
  "bp": "Carotid",
  "avpu": "Pain",
  "spo2": 91
}
```

## Inventory Ledger Location

`POST /inventory-ledger` or inventory-related event handlers should include:

```json
{
  "location_at_time": {
    "building": "15A",
    "floor": "3",
    "apartment": "7",
    "sector_id": "uuid"
  }
}
```

## Secure Handover

Recommended endpoints:

```http
POST /patients/:patientId/handover-token
GET  /handover/:handoverToken
POST /handover/:handoverToken/consume
```

The QR code contains only the handover URL/token, never raw patient data.

## Pediatric Medication Safety

For pediatric patients, medication events must include:

```json
{
  "medication": "ACTIQ",
  "quantity": 1,
  "weight_estimate_kg": 22
}
```

If `weight_estimate_kg` is missing, the database rejects the event.


---

# v0.6 Treatment Update API

## Add Treatment

```http
POST /patients/:patientId/treatments
```

Creates one append-only treatment event, creates required inventory ledger deductions, writes realtime outbox update, and returns the created event.

### Generic intervention body

```json
{
  "incident_id": "uuid",
  "actor_id": "uuid",
  "device_id": "device-cohen",
  "local_event_id": "local-treatment-001",
  "local_timestamp": "2026-05-13T10:35:00Z",
  "treatment_type": "COMBAT_GAUZE",
  "quantity": 1,
  "notes": "Bleeding controlled",
  "location_at_time": {
    "building": "15A",
    "floor": "3",
    "apartment": "7"
  }
}
```

### Tourniquet body

```json
{
  "incident_id": "uuid",
  "actor_id": "uuid",
  "device_id": "device-cohen",
  "local_event_id": "local-tq-001",
  "local_timestamp": "2026-05-13T10:35:00Z",
  "treatment_type": "TOURNIQUET",
  "limb": "R-Leg",
  "application_time": "2026-05-13T10:35:00Z",
  "location_at_time": {
    "building": "15A",
    "floor": "3",
    "apartment": "7"
  }
}
```

### Pediatric medication body

```json
{
  "incident_id": "uuid",
  "actor_id": "uuid",
  "device_id": "device-cohen",
  "local_event_id": "local-actiq-001",
  "local_timestamp": "2026-05-13T10:35:00Z",
  "treatment_type": "ACTIQ",
  "medication": "ACTIQ",
  "quantity": 1,
  "weight_estimate_kg": 22,
  "confirmed_per_protocol": true,
  "location_at_time": {
    "building": "15B",
    "floor": "1"
  }
}
```

## Treatment History

```http
GET /patients/:patientId/treatments
```

Returns immutable treatment history from `vw_patient_treatment_history`.

## Treatment Catalog

```http
GET /treatment-catalog
```

Returns active treatment actions and required fields.

## Backend responsibilities

The backend must:

1. Resolve treatment type from `treatment_catalog`.
2. Choose event type:
   - `TOURNIQUET_APPLIED`
   - `MEDICATION_ADMINISTERED`
   - `INTERVENTION_RECORDED`
3. Insert the event.
4. Insert negative `inventory_ledger` rows using `treatment_inventory_items`.
5. Include `location_at_time` in each inventory ledger row.
6. Write realtime outbox via database trigger.
7. Return safety warnings and conflict log IDs when relevant.


---

# v0.6 API Changes — Platoon Stock Logistics

## Inventory hierarchy

```text
Log-O / Truck Stock → Platoon Stock → Medic Bag → Treatment Consumption
```

## Endpoints

### Initialize Platoon Stock

```http
POST /incidents/:incidentId/platoon-stock/initialize
```

Allowed: Platoon Commander during staging.

Request:

```json
{
  "pc_id": "uuid",
  "device_id": "device-pc",
  "location_at_time": { "building": "staging", "floor": "ground" },
  "items": [
    { "sku": "TQ", "quantity": 8 },
    { "sku": "COMBAT_GAUZE", "quantity": 10 }
  ]
}
```

Effect: writes `INITIAL_STOCK` ledger rows with `owner_type = platoon_stock`.

### Medic requests from Platoon Stock

```http
POST /supply-requests/medic-to-pc
```

Allowed: Medic.

Request:

```json
{
  "incident_id": "uuid",
  "requester_id": "medic_uuid",
  "pc_id": "pc_uuid",
  "delivery_location_json": { "building": "15A", "floor": "3" },
  "items": [
    { "sku": "TQ", "quantity": 2 },
    { "sku": "COMBAT_GAUZE", "quantity": 2 }
  ]
}
```

Creates `supply_requests.request_level = medic_to_pc`.

### PC transfers Platoon Stock to Medic Bag

```http
POST /inventory/transfers/platoon-to-medic
```

Allowed: PC. Medic may take supplies only with PC permission.

Effect: creates paired ledger rows with the same `transfer_group_id`:

```text
Platoon Stock -X TRANSFER_OUT
Medic Bag +X TRANSFER_IN
```

### PC aggregates requests and sends to Log-O

```http
POST /supply-requests/pc-to-logo
```

Allowed: PC.

Creates `supply_requests.request_level = pc_to_logo` and links child medic requests with `parent_supply_request_id`.

### Log-O / PC refill Platoon Stock

```http
POST /inventory/transfers/logo-to-platoon
```

Allowed: Log-O or PC.

Effect:

```text
Truck/Logistics Stock -X TRANSFER_OUT
Platoon Stock +X TRANSFER_IN
```

### Emergency Log-O direct-to-medic refill

```http
POST /inventory/transfers/logo-to-medic-direct
```

Allowed: Log-O override path only.

Requires:

```json
{
  "direct_override_reason": "Urgent red patient load; PC stock inaccessible"
}
```

Effect:

```text
Truck/Logistics Stock -X TRANSFER_OUT
Medic Bag +X TRANSFER_IN
```

The action is marked `transfer_kind = DIRECT_LOGO_TO_MEDIC` and appears in the logistics audit trail.

## Dashboard additions

```http
GET /incidents/:incidentId/platoon-stock
GET /incidents/:incidentId/inventory-transfer-audit
```

Both CC and Chamal can view these endpoints but cannot edit stock.
