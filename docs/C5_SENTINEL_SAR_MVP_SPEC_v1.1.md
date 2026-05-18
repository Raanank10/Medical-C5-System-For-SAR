# C5 Sentinel-SAR — MVP Product & Technical Specification v1.1

## Role
Full-Stack Engineer & UX Designer

## Objective
Build a mission-critical Medical Command & Control (C5) system for Search and Rescue (SAR) and mass-casualty scenarios.

The system consists of:

- **Mobile App** — Medics and Platoon Commanders / Supervisors
- **Web Dashboard** — Chamal, Company Commander, Platoon Commander, Logistics Officer
- **Backend / Database** — PostgreSQL / Supabase-compatible event-sourced backend
- **Realtime Layer** — Realtime Outbox + backend worker / Supabase Realtime / WebSocket

The system reduces operational fog of war across three domains:

1. **Clinical** — time-critical watchdogs: crush risk, reassessment intervals, tourniquet elapsed time, Golden Hour.
2. **Logistical** — supply requests, inventory burn rate, resupply flow, stock-out prevention.
3. **Command** — sector heatmap, casualty progression, medic status, final sweep control.

---

# 0. Seed / Demo Data

Initialize the application with a fully demonstrable state.

## Active Incident

```text
Incident: INC-001
Location: Tel Aviv
T₀ / T_injury default: 35 minutes ago
Status: Active
```

## Demo Users

```text
Medic Cohen — Medic
Medic Levi — Medic
PC Demo — Platoon Commander
Log-O Demo — Logistics Officer
CC Demo — Company Commander
Chamal Demo — Chamal
```

## Demo Patients

### P-001

```text
Triage: RED
Access: Trapped
Age group: Adult
Location: Building 15A, Floor 3, Apt 7
Tourniquet: applied 27 minutes ago, R-Leg
Vitals: HR 124, RR 32, BP Carotid, AVPU Pain, SpO₂ 91%
```

### P-002

```text
Triage: YELLOW
Algorithmic suggestion: RED
Manual override reason: "Ambulatory, minor lacerations"
Access: Partial
Age group: Adult
Location: Building 15A, Floor 2
Vitals: HR 96, RR 22, BP Radial, AVPU Alert, SpO₂ 97%
```

### P-003

```text
Triage: GREEN
Access: Free
Age group: Pediatric, age 6
Location: Building 15B, Floor 1
Vitals: HR 110, RR 28, BP Radial, AVPU Alert, SpO₂ 99%
```

## Demo Operational Data

```text
Conflict Log:
- P-002 override: Algorithm RED → Human YELLOW
- Reason: "Ambulatory, minor lacerations"
- Actor: Medic Cohen

Pending Supply Request:
- Requester: Medic Cohen
- Items: Combat Gauze ×2, Tourniquet ×2

Dead Man's Switch:
- Medic Levi last seen 6 minutes ago
- Supervisor alert should be active
```

## Patient ID Rule

Patient IDs auto-generate per incident:

```text
P-001, P-002, P-003...
```

The counter resets to `P-001` for each new incident.

---

# 1. Role & Authorization Matrix

Permissions must be enforced at both the **API layer** and **UI layer**.

## Roles

```text
Medic
Platoon Commander / Supervisor (PC)
Logistics Officer (Log-O)
Company Commander (CC)
Chamal
```

`PC` is the schema/auth role name for Platoon Commander. In the product language this is the field Supervisor role, so `pc` in the auth matrix should be read as "Platoon Commander / Supervisor".

## Incident Opening and T₀ Authority

Official incidents and official `T₀` can be created/set only by:

```text
Company Commander
Chamal
Platoon Commander, if authorized
```

A Medic may create a **local draft incident** only when no official incident is available. A draft incident allows field data capture but must later be confirmed by PC / CC / Chamal. The confirmation event is auditable. Draft state has a single source of truth: `incidents.status = 'draft'`; there is no separate `is_draft` flag.

## Authorization Matrix

| Action | Medic | PC / Supervisor | Log-O | CC | Chamal |
|---|---:|---:|---:|---:|---:|
| Create local draft incident | ✓ | ✓ | ✗ | ✓ | ✓ |
| Open official incident and set T₀ | ✗ | ✓ | ✗ | ✓ | ✓ |
| Confirm draft incident | ✗ | ✓ | ✗ | ✓ | ✓ |
| Close / reopen official incident | Limited | ✓ | ✗ | ✓ | ✓ |
| Register new patient | ✓ | ✓ | ✗ | ✗ | ✗ |
| Record vitals and interventions | ✓ | ✓ | ✗ | ✗ | ✗ |
| Override MSTART / JumpSTART triage | ✓ | ✓ | ✗ | ✗ | ✗ |
| Mark patient handed over | ✓ | ✓ | ✗ | ✗ | ✗ |
| Request resupply | ✓ | ✗ | ✗ | ✗ | ✗ |
| Dispatch supply to Log-O | ✗ | ✓ | ✗ | ✗ | ✗ |
| Manage kit templates | ✗ | ✓ | ✓ | ✓ | ✗ |
| Dispatch resupply runner | ✗ | ✗ | ✓ | ✗ | ✗ |
| Update building status | ✓ | ✓ | ✗ | ✓ | ✓ |
| Confirm Site Clear | ✗ | ✓ | ✗ | ✓ | ✓ |
| View full command dashboard | ✗ | ✓ | ✓ | ✓ | ✓ |
| View conflict log | ✗ | ✓ | ✗ | ✓ | ✓ |
| Unlock and export AAR | ✗ | ✓ | ✗ | ✓ | ✓ |

## Medic Site Close Rule

A Medic may initiate a local site-close action only after **all patients personally registered by that Medic** are marked `Handed Over`.

This action is recorded as:

```text
MEDIC_SITE_CLOSE_REQUESTED
```

A PC / CC / Chamal may reopen or reject the close request.

---

# 2. Core Logic & Data Architecture

## 2.1 Incident Time

### T₀ and T_injury

For this MVP:

```text
T_injury = T₀ by default
```

`T₀` is the strike / incident-zero time. It is set when the official incident is opened.

For simplicity, most clinical timers should use `T_injury`. Since `T_injury` defaults to `T₀`, this preserves clinical semantics while allowing future per-patient injury-time overrides.

Future option:

```text
A Medic may override T_injury for an individual patient if injury time is known to differ.
Any override is logged as PATIENT_T_INJURY_UPDATED.
```

### Site Guard and Draft-Incident Patient Creation

The `+ New Patient` button is enabled when either an official incident exists **or** a local draft incident exists.

```text
Official incident exists → Patient attaches to official incident.
Draft incident exists only → Patient attaches to draft incident and is marked Pending Incident Approval.
No official or draft incident exists → + New Patient is disabled; create draft incident first.
```

Patients, vitals, treatments, tourniquet records, and supply requests may be recorded under a draft incident. They remain operationally visible, local/offline-safe, and syncable.

If only a draft incident exists, every relevant screen must clearly show:

```text
DRAFT INCIDENT — pending confirmation
Patients may be recorded, but incident approval is required.
```

PC / CC / Chamal screens must show a high-priority blinking/pulsing approval banner until the draft incident is approved, merged, rejected, or explicitly acknowledged.

---

## 2.2 Event-Sourcing

Every user action is an immutable, timestamped event.

Examples:

- Vitals entry
- Location update
- Access update
- Tourniquet record
- Triage assignment
- Override reason
- Intervention
- Handover
- Supply request
- Building status update
- Site clear confirmation

The event log is the ground truth.

Projection tables such as `patients`, `device_presence`, and dashboard views are read models only.

## Example Event

```json
{
  "id": "evt_uuid",
  "patient_id": "patient_uuid",
  "incident_id": "incident_uuid",
  "actor_id": "user_uuid",
  "actor_role": "Medic",
  "type": "VITALS_RECORDED",
  "payload": {
    "hr": 124,
    "rr": 32,
    "bp": "Carotid",
    "avpu": "Pain",
    "spo2": 91
  },
  "device_id": "device_uuid",
  "local_event_id": "local_uuid",
  "local_timestamp": "2026-05-09T10:35:00.000Z",
  "server_timestamp": "2026-05-09T10:35:03.000Z",
  "synced_at": null
}
```

---

## 2.3 Offline-First Sync

All writes are stored locally first.

### Mobile Local Storage

Use SQLite as the primary mobile event store.

```text
SQLite = local event queue and local projections
AsyncStorage = preferences/session flags only
```

### Web Local Storage

Use IndexedDB or LocalStorage only for limited dashboard cache.

### Sync Strategy — Event-Driven Immediate Sync + Fallback

The sync model is **push + pull**, not push-only.

The primary sync trigger is the user action itself. Critical events attempt sync immediately after they are written locally.

```text
1. User action writes immediately to local SQLite.
2. Event appears in UI instantly with sync status = pending.
3. Critical events trigger immediate sync attempt.
4. Unsynced local events are pushed to backend in local_timestamp order.
5. Device pulls remote events since last_sync_cursor.
6. Local projections are rebuilt/updated from the merged event log.
7. Local events are never overwritten directly.
8. Fallback background sync runs every 60–90 seconds.
```

Critical events that trigger immediate sync:

```text
Draft incident created
Draft incident approved / merged / rejected
New Patient created
Quick Patient created
Vitals recorded
Treatment recorded
Tourniquet applied
Triage updated
Patient handed over
Supply request created
Building marked unstable
Dead Man’s Switch alert
Site Clear confirmed
```

Failed sync attempts use exponential backoff:

```text
5s → 15s → 30s → 60s → 90s max
```

This keeps critical operational data fast without wasting battery through constant polling.

### Idempotency Rule

The server accepts all unique events using:

```text
device_id + local_event_id
```

as the idempotency key.

### Conflict Rule

The server does **not discard events** because of identical timestamps.

If two events are semantically conflicting, both are retained in the immutable event log and the system creates a `SYNC_CONFLICT` event or conflict-log record.

Conflict resolution affects read-model projections only, never the immutable event history.

---

## 2.4 Realtime Chamal Updates

Realtime updates must use the **Transactional Outbox Pattern**.

```text
events table
↓
PostgreSQL trigger updates projections
↓
PostgreSQL trigger writes to realtime_outbox
↓
Backend worker / Supabase Realtime reads outbox
↓
WebSocket / Realtime channel pushes update to Chamal dashboard
```

The database must not call the web app directly.

---

## 2.5 Watchdog Stack

Watchdogs run locally and should also be reproducible server-side for Chamal/AAR validation.

| Watchdog | Trigger | Threshold | Alert |
|---|---|---:|---|
| Crush Syndrome | Access = Trapped or Partial | T_injury + 45m | Amber → Red |
| Golden Hour | Any registered patient | T_injury + 45m | Amber |
| Golden Hour | Any registered patient | T_injury + 60m | Red |
| Tourniquet Warning | Tourniquet per limb | +60m from application | Amber |
| Tourniquet Critical | Tourniquet per limb | +120m from application | Red |
| Reassessment RED | Triage = RED | Every 10m | Prompt |
| Reassessment YELLOW | Triage = YELLOW | Every 30m | Prompt |
| Dead Man's Switch | Medic inactivity | >5m with no events/heartbeat | Supervisor alert |

Persistent banners must remain visible until acknowledged/resolved.

Reassessment prompts include:

```text
Vitals Updated
Unable to Assess
Dismiss with Reason
```

Each action logs a reassessment event.

---

# 3. Triage Algorithms

## 3.1 Fast / Minimal Triage Mode

The 7-step flow is the primary workflow, but the system must support a **Quick Patient** mode for high-load chaos.

Quick Patient mode captures the minimum safe operational record:

```text
1. Location
2. Access status
3. Tourniquet used? YES / NO
4. Pulse present? YES / NO / Unknown
5. Breathing present? YES / NO / Unknown
6. Initial triage assignment
7. Save
```

This mode does **not** replace full vitals. It creates a patient record quickly and marks it:

```text
NEEDS_FULL_ASSESSMENT
```

The patient card must show a high-visibility prompt:

```text
⚠ Full vitals missing
```

### How triage works without full vitals

If full vitals are not available, the app uses **minimal triage support**, not a full MSTART/JumpSTART calculation.

Rules:

```text
No breathing in MCI mode → BLACK suggestion
Breathing present + major bleeding/tourniquet used → RED suggestion
Breathing present + pulse present + ambulatory/minor injury → GREEN or YELLOW manual assignment
Unknown pulse/breathing → PENDING / requires assessment
```

A full algorithmic triage label is calculated only after required vitals are entered.

The UI must visually distinguish `pending` from `green`: pending means "not enough data / not triaged yet", while green means minor/non-urgent.

---

## 3.2 MSTART — Adult, age ≥ 8

Required fields for full MSTART:

```text
RR
BP palpation
AVPU
```

Algorithm:

```text
IF RR = 0                  → BLACK
IF RR > 30                 → RED
IF RR < 8                  → RED
IF BP = None               → RED
IF AVPU = Unresponsive     → RED
IF AVPU = Pain             → YELLOW
ELSE                       → GREEN
```

### MCI BP Override

In a declared MCI, `BP=None` may be downgraded from RED to YELLOW only by Supervisor / PC / CC.

Reason is mandatory and logged to the Conflict Log.

---

## 3.3 JumpSTART — Pediatric, age < 8

JumpSTART activates when the Pediatric flag is set.

Algorithm support:

```text
IF RR = 0:
  Check pulse
  IF no pulse → BLACK
  IF pulse present → prompt rescue-breath protocol per authorized doctrine

IF RR < 15 OR RR > 45 → RED
IF BP = None → RED
IF AVPU = Unresponsive → RED
IF AVPU = Pain → YELLOW
ELSE → GREEN
```

### Pediatric Medication Safety

Pediatric mode does not prescribe medication doses.

Medication fields are flagged:

```text
Weight-estimated — confirm per protocol
```

The system records and warns; it does not independently prescribe treatment.

---

## 3.4 Override Protocol

Any manual triage assignment that differs from the algorithmic suggestion requires a free-text reason.

Minimum reason length:

```text
10 characters
```

Override consequences:

- Write event to immutable event log
- Create conflict-log entry
- Show ⚠ on patient card
- Include in AAR triage-analysis section

---

# 4. Mobile Interface — React Native / Expo

## 4.1 Dashboard

### Header

- Incident name
- Incident clock since `T₀ / T_injury`
- Sync status: 🟢 Live / 🔴 Offline / 🟡 Syncing
- Draft incident badge, if relevant

### Draft Incident Approval Banner — PC / CC / Chamal

When a draft incident exists, PC / CC / Chamal screens display a high-priority blinking/pulsing banner:

```text
⚠ Draft Incident Pending Approval
Medic Cohen opened Draft Incident INC-DRAFT-001
Patients already registered: [count]
Location: [location]
Created: [elapsed]

[Approve & Set T₀]
[Merge Into Existing Incident]
[Reject / Archive]
```

Behavior:

```text
First 60 seconds: blinking/pulsing banner
After acknowledgment: persistent amber banner
If patients are attached: remains high-priority until resolved
```

Medic screens show a non-blocking draft badge, but PC / CC / Chamal screens require explicit action.

### Stat Row

```text
Black / Red / Yellow / Green / Total
```

### Primary Actions

```text
+ New Patient
Quick Patient
Request Resupply
Open / Confirm Incident, role-dependent
```

### Patient Cards

Sorted by urgency and attention requirement.

Each card shows:

- Patient ID
- Triage badge
- Location
- Access status
- Last vitals snapshot
- Golden Hour progress
- Tourniquet elapsed badge, if applied
- Next vitals countdown
- Missing full vitals warning, if Quick Patient mode was used
- Override/conflict icon, if applicable

### Medic Stock Panel

Shows current inventory based on `inventory_ledger` SUM.

Low-stock threshold:

```text
≤2 units
```

---

## 4.2 Treatment Pipeline

The full workflow has 7 steps. After first save, all steps are navigable.

## Step 1 — Location

Fields:

- Building number
- Floor selector
- Apartment / room
- Building status: Stable / Unstable / Unknown

Setting `Unstable` broadcasts a persistent incident banner and changes sector heatmap styling.

## Step 2 — Access & Extraction

Options:

```text
FREE — Patient accessible
PARTIAL — Partial extraction needed
TRAPPED — Full rescue required
```

Selecting `TRAPPED` or `PARTIAL` arms crush watchdog.

## Step 3 — Tourniquet / TQ

Required question:

```text
Was a tourniquet used? YES / NO / Unknown
```

If YES:

- Limb selector: L-Arm / R-Arm / L-Leg / R-Leg
- Time applied: current time auto-filled, editable
- Badge: amber at 60m, red at 120m

This information is captured even in Quick Patient mode.

Once a tourniquet is recorded, the patient card, patient detail view, and command row must show a persistent elapsed timer. The timer is a clinical clock, not a passive history item.

## Step 4 — Vitals

Stepper-based vitals entry must show the calculation behind the value, for example:

```text
15 beats in 15 seconds = 60 BPM
8 breaths in 30 seconds = 16/min
```

## Step 5 — Injury Map

The MVP supports a body-map injury capture model. Selected anatomical zones are stored as `patients.injury_zones` and mirrored in event payloads as `injury_zones`.

Example zones:

```text
head, chest, abdomen, left_arm, right_arm, left_leg, right_leg
```

Required for full MSTART/JumpSTART:

- AVPU
- BP palpation
- Heart rate
- Respiratory rate

Optional:

- SpO₂

Personnel ID is auto-populated from login and is non-editable.

### Tap + Stepper Vitals Entry

The MVP supports the original **large tap-every-beat / tap-every-breath control** and keeps steppers as the correction path. This preserves the gloved-hands field UX while still allowing a medic to fix an over-count or under-count quickly.

Heart Rate uses a 15-second count:

```text
Pulse Count — 15 sec
[Tap Beat]   [-1]   25   [+1]
Calculated HR: 100 bpm
```

Respiratory Rate uses a 30-second count:

```text
Resp Count — 30 sec
[Tap Breath]   [-1]   10   [+1]
Calculated RR: 20/min
```

Defaults:

```text
HR raw count default = 25  → 25 × 4 = 100 bpm
RR raw count default = 10  → 10 × 2 = 20/min
```

The medic can use the large tap control as the primary path, then use the stepper buttons to correct the raw count if needed.

Stored payload includes raw count, window seconds, calculated value, and `entry_method`. Allowed MVP values are `tap`, `stepper`, and `clinical_override` for explicit no-breathing decisions.

## Step 5 — Triage

- Adult / Pediatric toggle
- Algorithmic suggestion
- Manual assignment: RED / YELLOW / GREEN / BLACK
- Mandatory reason for override
- Conflict chip if override exists

## Step 6 — Status

Lifecycle statuses:

```text
Identified
Treating
Observing
Extricated
Handed Over
Closed / Read-only
```

`Handed Over` is a final clinical field status and makes the patient read-only except for supervisor/command audit annotations.

## Step 7 — Interventions

Rows / counters:

- IV Fluids
- Actiq / Fentanyl, if authorized
- Combat Gauze
- Tourniquet
- First-aid bandage
- Airway adjunct
- Other

Counters auto-write `inventory_ledger` entries.

Out-of-stock does **not** block treatment documentation. The treatment is saved, inventory may temporarily go negative, and the system creates an `INVENTORY_NEGATIVE_STOCK_USED` alert for PC / Log-O reconciliation.

### TBI Safety Guard

If medication is recorded and AVPU is Pain or Unresponsive, show a soft warning:

```text
Possible TBI — confirm indication per protocol.
```

The medic may proceed. The warning and confirmation are logged to the Conflict Log.

### Tourniquet Limb Consistency Check

If the tourniquet limb conflicts with recorded injury location, a quiet review flag is sent to PC / CC dashboard.

---

## 4.3 MIST Handover & Patient QR

Generates:

1. MIST script
2. Secure QR handover token/link

The QR must not encode the full medical record directly. It contains a secure token or link to the patient record. Access requires authorization.

### MIST Script

```text
M — Mechanism:
Strike event T+[elapsed] | Building [X], Floor [Y], Apt [Z]

I — Injuries:
Access: [Free/Partial/Trapped]
Triage: [T1/T2/T3/T4] — [Label]
Tourniquet: [Limb] applied at [HH:MM] | Duration: [elapsed]

S — Signs:
HR: [X] bpm | RR: [X]/min
BP: [Radial/Carotid/None]
AVPU: [X] | SpO₂: [X]%

T — Treatment:
IV Fluids: [count]
Actiq: [count]
Bandage / Combat Gauze / TQ / Airway: [count]
```

### Handover Confirmation

Button:

```text
✓ Patient Handed Over to Evacuation / MDA
```

Action:

- Writes `PATIENT_HANDED_OVER` event
- Sets patient status to `handed_over`
- Makes field file read-only
- Updates heatmap sector state

No external evacuation/MDA signature is required in the MVP.

---



---

# Treatment Update Protocol v1.1

The system supports a dedicated **New Treatment** workflow equivalent in importance to the Vitals Update workflow.

## Entry Points

Treatment can be added from both:

1. **Patient Card** — quick action: `+ Treatment`.
2. **Patient Detail Screen** — full action: `Add Treatment`, with treatment history visible.

This allows fast field documentation without forcing the medic to reopen the full 7-step patient creation flow.

## UX Flow

```text
Patient Card / Patient Detail
→ Add Treatment
→ Select treatment type
→ Fill treatment-specific fields
→ Run safety checks
→ Confirm
→ Append treatment event
→ Deduct inventory through inventory_ledger
→ Write realtime_outbox update
→ Chamal / PC dashboard updates live
```

## MVP Treatment Types

The MVP treatment list is:

```text
Tourniquet
Pressure Bandage
Combat Gauze
Airway Intervention
IV Access
IV Fluids
Actiq / Fentanyl
CPR
Other
```

Morphine is intentionally excluded from the MVP treatment list.

## Auto Signature

Every treatment event is automatically signed from the authenticated device/session:

```text
actor_id
actor_role
device_id
local_timestamp
```

Manual medic-name entry is not allowed in the MVP. This is the same principle as vitals documentation.

## Tourniquet Handling

Tourniquet is handled in both ways:

1. UX: appears as a normal treatment choice.
2. Data/event model: creates a specific `TOURNIQUET_APPLIED` event because it arms its own timer/watchdog.

Required tourniquet fields:

```text
limb: L-Arm / R-Arm / L-Leg / R-Leg
application_time
applied_by actor_id/device_id
location_at_time
```

Tourniquet events also create inventory ledger deductions for the tourniquet item.

## Treatment Safety Checks

Before saving, the system runs safety checks:

### Pediatric Medication Safety

If patient is pediatric and the treatment is medication-related, `weight_estimate_kg` is required for completeness and safety review, but it is **not save-blocking**.

If missing, the treatment is still saved, and the system creates a critical Watchdog alert and a High-Risk Clinical Violation entry.

### Reduced AVPU / TBI Context Warning

If AVPU is `Pain` or `Unresponsive`, medication-related events and selected interventions trigger a soft warning:

```text
Reduced AVPU — confirm per protocol.
```

The medic may continue only after confirmation. The confirmation is logged as part of the treatment event and materialized in `conflict_log` when relevant.

### Missing Recent Vitals Warning

If there are no vitals for the patient, or the latest vitals are older than the configured reassessment interval, the system warns:

```text
No recent vitals — confirm treatment documentation.
```

This is a warning, not a hard block.

### Out-of-Stock / Negative Stock Protection

Inventory state must never block treatment documentation.

If the relevant item appears out of stock:

- the treatment event is still saved
- the inventory ledger entry is still written
- stock may temporarily go negative
- the system creates an `INVENTORY_NEGATIVE_STOCK_USED` Watchdog alert
- PC / Log-O reviews the discrepancy after the clinical action

The inventory model supports command awareness; it must not prevent a medic from preserving clinical history.

## Treatment Event Payload

Generic intervention event:

```json
{
  "treatment_type": "COMBAT_GAUZE",
  "quantity": 1,
  "notes": "Packed wound, bleeding controlled",
  "safety_checks": {
    "recent_vitals_available": true,
    "reduced_avpu_warning": false,
    "pediatric_weight_required": false,
    "inventory_available": true
  },
  "inventory_deductions": [
    { "sku": "COMBAT_GAUZE", "quantity_change": -1 }
  ],
  "location_at_time": {
    "building": "15A",
    "floor": "3",
    "apartment": "7"
  }
}
```

Medication event example:

```json
{
  "treatment_type": "ACTIQ",
  "medication": "ACTIQ",
  "quantity": 1,
  "weight_estimate_kg": 22,
  "confirmed_per_protocol": true,
  "inventory_deductions": [
    { "sku": "ACTIQ", "quantity_change": -1 }
  ],
  "location_at_time": {
    "building": "15B",
    "floor": "1"
  }
}
```

Tourniquet event example:

```json
{
  "treatment_type": "TOURNIQUET",
  "limb": "R-Leg",
  "application_time": "2026-05-13T10:18:00Z",
  "inventory_deductions": [
    { "sku": "TQ", "quantity_change": -1 }
  ],
  "location_at_time": {
    "building": "15A",
    "floor": "3",
    "apartment": "7"
  }
}
```

## Treatment History

Patient Detail must show treatment history as an immutable timeline:

```text
12:08 — Tourniquet applied — R-Leg — Medic Cohen
12:13 — Combat Gauze ×1 — Medic Cohen
12:17 — IV Access — Medic Cohen
12:20 — IV Fluids ×1 — Medic Cohen
```

## Database Behavior

Saving a treatment must create:

1. Event row:
   - `INTERVENTION_RECORDED`, `MEDICATION_ADMINISTERED`, or `TOURNIQUET_APPLIED`
2. One or more `inventory_ledger` rows with negative `quantity_change`
3. Optional `conflict_log` entry if a safety warning is overridden
4. `realtime_outbox` row for Chamal/PC updates

There is no mutable `treatments` table in the MVP. The event log is the source of truth.


# 5. Web Interface — React / Tailwind

## 5.1 Tactical Funnel

```text
Identified → In Treatment / Stabilized → Extricated → Handed Over
```

Each stage shows count and proportional fill.

Clicking a stage filters the patient list.

## 5.2 Final Sweep Heatmap

| State | Color | Condition |
|---|---|---|
| No patients | Neutral grey | No registered patients |
| Active | Red | Any RED patient not handed over |
| Caution | Amber | Any YELLOW patient not handed over |
| Monitoring | Blue | GREEN-only patients not handed over |
| Clear | Green | All patients handed over and PC/CC/Chamal confirms Site Clear |
| Unstable | Red border + ⚠ | Building status = Unstable |

`Site Clear` is a two-tap action.

## 5.3 Patient Detail View

- Immutable event timeline
- Sparkline graphs: HR, SpO₂, AVPU
- Triage history
- Override flags
- Handover details

AVPU numeric mapping for charts:

```text
Alert = 4
Voice = 3
Pain = 2
Unresponsive = 1
```

## 5.4 Conflict Log

Shows:

- MSTART / JumpSTART override
- TBI warning confirmation
- MCI BP override
- sync conflict
- duplicate suspected

Fields:

- Patient ID
- Timestamp
- Actor
- Algorithm value
- Human value
- Reason

## 5.5 Medic Status Panel

Shows:

- Active medics
- Current location
- Active patient(s)
- Last activity
- Dead Man’s Switch badge

## 5.6 Logistics Hub

- Kit templates, editable only in staging/non-active incident mode
- Burn rate by item
- Supply request queue
- Dispatch to Log-O
- Runner ETA
- Delivered confirmation

## 5.7 Ratio Gauge

Displays:

```text
Personnel deployed vs critical patients per sector
```

Purpose: resource-allocation decision support.

---

# 6. PostgreSQL / Supabase Database Schema

The database is event-sourced and PostgreSQL-native.

## Required Tables

```text
profiles
incidents
sectors
patients
events
realtime_outbox
external_reports
external_patient_links
inventory_items
inventory_ledger
kit_templates
kit_template_items
supply_requests
supply_request_items
watchdog_alerts
device_presence
conflict_log
```

## Required Views

```text
vw_patient_latest_vitals
vw_incident_tactical_funnel
vw_sector_clearance_status
vw_current_inventory
vw_active_patient_priority
vw_active_watchdog_alerts_by_severity
```

## Schema Principles

- `events` is immutable and append-only.
- `inventory_ledger` is append-only and replaces absolute inventory quantity.
- `patients` is a projection/read model.
- `realtime_outbox` feeds Chamal/dashboard updates.
- `device_id + local_event_id` prevents duplicate sync.
- JSON payloads use `jsonb`.
- JSONB GIN/expression indexes support fast dashboard queries.

---

# 7. API Surface — Sync-Log First

The mobile app must not depend on REST read endpoints for operational work.

Operational rule:

```text
Mobile UI reads from local SQLite only.
Network is used only to push/pull the sync log in the background.
If it is not in local SQLite, it is not operationally available to the medic.
```

## 7.1 Primary Client-Facing API

```http
POST /sync/log
GET  /sync/log?incident_id=&since_cursor=&limit=
```

`POST /sync/log` is batch-based but **not all-or-nothing**.
The server processes each event independently using atomic individual event processing.

If a batch contains 50 events and one is malformed:

```text
49 valid events are accepted.
1 malformed event is rejected/quarantined.
The device receives a terminal per-event error and does not keep retrying the poison event forever.
```

Clinical events should almost never be rejected. Bad-but-important clinical data is accepted, preserved, and flagged. Truly malformed envelopes that cannot be mapped to an event are written to `sync_ingestion_errors`.

## 7.2 Sync Pull

`GET /sync/log` returns events ordered by `sync_cursor ASC`.

- `since_cursor` maps to `events.sync_cursor`.
- Default limit: 500.
- Maximum limit: 2000.
- Client repeats until `has_more = false`.

## 7.3 Dashboard / Command Reads

Web dashboard reads may use service-role backed views, materialized projections, or command-state tables.
These are **not** mobile operational dependencies.

Dashboard APIs:

```http
GET /command/incidents/:incidentId/dashboard-state
GET /command/incidents/:incidentId/heatmap
GET /command/incidents/:incidentId/aar/live-timeline
```

## 7.4 Internal Worker APIs

Realtime outbox processing is internal-only. It has no client-facing route. Only service-role/backend worker code may read and mark `realtime_outbox` rows as processed.

## 7.5 AAR API

The AAR is continuously built as a rolling timeline during the incident.
Manual generation is a refresh/finalization action, not the first moment the AAR exists.

```http
GET  /command/incidents/:incidentId/aar/live-timeline
POST /command/incidents/:incidentId/aar/context-note
POST /command/incidents/:incidentId/aar/voice-memo
POST /command/incidents/:incidentId/aar/generate-final
GET  /command/incidents/:incidentId/aar
POST /command/incidents/:incidentId/aar/unlock
```

---
# 8. Design System

## Theme

```text
Tactical Dark Mode
Base background: #090B0D
Surface layers: #111518 / #181D22 / #1E252C / #252D36
```

## Triage Colors

```text
RED: #FF3B30
YELLOW: #FFD60A — black text on yellow backgrounds
GREEN: #34C759
BLACK: #3A3A3A
PENDING: #0A84FF
```

## Alert Colors

```text
Amber: #FF9F0A
Critical Red: #FF3B30
```

## Typography

Use monospaced font for:

- Timers
- Vitals
- Patient IDs
- Clocks

Use system sans-serif for labels and descriptions.

## Interaction

- Haptic feedback on stepper adjustments, confirmations, alerts, and destructive-action confirmations
- Long-press 500ms to delete, with confirmation
- Destructive actions require two-step confirmation
- Minimum mobile touch target: 44×44px
- Never communicate triage by color only; always pair with text label

---

# 9. After-Action Report Engine

## Unlock Conditions

AAR is locked until:

1. All patients across all sectors are marked `Handed Over`
2. All active sectors/buildings have confirmed `Site Clear`

PC / CC / Chamal can unlock the AAR.

The report is read-only and exportable as PDF.

## Clinical Section

- Triage accuracy: algorithmic suggestion vs final assignment
- Override rate and override reason categories
- Golden Hour compliance
- Medication summary
- TBI warning confirmations

## Operational Section

- Time-to-clear by sector
- Registration → Handover time by triage category
- Medic-to-patient ratio over time
- Dead Man’s Switch events

## Logistics Section

- Total items consumed
- Burn rate per patient type
- Supply request lead times
- Stock-out events

---


---

# 10. KPI Framework and MVP Dashboard Metrics

The system should measure KPIs across four domains: Clinical, Operational, Logistics, and System / Adoption.

## 10.1 Clinical KPIs

| KPI | Calculation | Why it matters |
|---|---|---|
| Time to first patient registration | `PATIENT_CREATED - T_injury` | Measures how quickly field documentation starts |
| Time to first vitals | First `VITALS_RECORDED - PATIENT_CREATED` | Measures clinical assessment speed |
| Vitals reassessment compliance | RED every ≤10m, YELLOW every ≤30m | Validates watchdog effectiveness |
| Golden Hour compliance | `% handed over ≤60m from T_injury` | Tracks time-critical evacuation performance |
| Tourniquet time compliance | TQ warning/critical timing and duration until handover | Tracks time-sensitive TQ risk |
| Triage override rate | `Overrides / total triage assignments` | Measures algorithm-human disagreement |
| Missing full assessment rate | `patients with needs_full_assessment / active patients` | Tracks Quick Patient debt |

## 10.2 Operational KPIs

| KPI | Calculation | Why it matters |
|---|---|---|
| Patient progression funnel | Identified → Treating/Observing → Extricated → Handed Over | Shows operational flow |
| Registration-to-handover time | `PATIENT_HANDED_OVER - PATIENT_CREATED` | Measures casualty throughput |
| Sector clearance time | `SITE_CLEAR_CONFIRMED - T_injury` | Tracks building/floor clearance |
| Active critical load | Active RED patients not handed over | Shows current operational pressure |
| Medic-to-critical-patient ratio | Active medics / active RED patients, by sector | Supports resource allocation |
| Dead Man’s Switch events | count, duration, time to acknowledgment | Tracks medic/device inactivity risk |

## 10.3 Logistics KPIs

| KPI | Calculation | Why it matters |
|---|---|---|
| Supply burn rate | Items consumed per 10m / per patient / per RED patient | Predicts depletion |
| Stock-out risk | Current stock / recent burn rate | Warns before stock-out |
| Medic low-stock rate | `% medics with critical item ≤2` | Shows field readiness |
| Resupply lead time | `delivered_at - requested_at` | Measures logistics response |
| Emergency direct refill rate | Direct Log-O → Medic refills / all refills | Tracks override-path usage |
| Platoon Stock utilization | `% requests fulfilled from Platoon Stock` and `% escalated to Log-O` | Measures value of Platoon Stock layer |

## 10.4 System / Adoption KPIs

| KPI | Calculation | Why it matters |
|---|---|---|
| Sync latency | `server_timestamp - local_timestamp`, by event type | Measures realtime reliability |
| Unsynced event backlog | local events where `synced_at IS NULL` | Shows offline risk |
| Sync failure rate | failed attempts / total attempts | Shows network/system health |
| Data completeness score | Location + Access + Triage + Vitals + Treatment/Handover completeness | Measures record quality |
| Time to create patient | save timestamp - screen opened timestamp | UX speed metric |
| Time to update vitals | `VITALS_RECORDED saved_at - vitals modal opened_at` | UX speed metric |
| Time to record treatment | `INTERVENTION_RECORDED saved_at - treatment modal opened_at` | UX speed metric |

## 10.5 MVP KPI Dashboard — First 10 Metrics

The first Chamal/Command dashboard should focus on these metrics:

```text
1. Active RED patients
2. Patients missing full vitals
3. Time to first vitals
4. Vitals reassessment compliance
5. Golden Hour compliance
6. Patient progression funnel
7. Medic-to-RED-patient ratio
8. Dead Man’s Switch active alerts
9. Stock-out risk / low stock
10. Sync latency / unsynced backlog
```

These 10 are enough for a strong MVP because they connect clinical safety, command visibility, logistics, and system reliability.

---

# 11. Technical Architecture

## Stack

```text
Mobile: React Native / Expo
Mobile Offline DB: SQLite
Web Dashboard: React + Tailwind
Backend: Node.js / Express or Supabase Edge Functions
Database: PostgreSQL / Supabase
Realtime: Realtime Outbox + WebSocket / Supabase Realtime
Web Offline Cache: IndexedDB / LocalStorage, limited use
```

## Build Priority Order

1. PostgreSQL event-sourced schema
2. Seed/demo data
3. API event ingestion
4. Mobile local SQLite event queue
5. Sync push/pull engine
6. Mobile vitals stepper logic
7. Quick Patient mode
8. Crush/Tourniquet/Golden Hour watchdogs
9. Dead Man’s Switch
10. Realtime Outbox + Chamal dashboard updates
11. Tactical Funnel + Final Sweep Heatmap
12. MIST handover + secure QR token
13. Logistics inventory ledger automation
14. AAR engine

---

# 12. Safety, Privacy, and Scope

This MVP is a prototype and must not store real patient-identifiable medical data unless proper authorization, privacy controls, and organizational approval exist.

The system:

- Records operational/clinical data
- Provides reminders and warnings
- Supports decision-making
- Does not replace certified medical doctrine
- Does not independently prescribe medication doses
- Requires authorized users and audit logging

QR handover uses a secure token/link, not raw embedded patient data.

---

# 13. What This System Solves

## Clinical

The system watches critical clocks for the medic:

- Crush risk
- Golden Hour
- Tourniquet duration
- Reassessment intervals
- Deterioration indicators

## Logistical

The system watches supply flow for supervisors:

- Burn rate
- Supply request queue
- In-transit ETA
- Low-stock and stock-out events

## Command

The system watches the building for command:

- Patient progression
- Sector status
- Medic inactivity
- Final sweep
- Heatmap clearance

The heatmap never turns green until every known patient is handed over and the sector is signed off.


---

# v1.1 Corrections and Safety Updates

## Vitals UX — Tap Primary, Stepper Correction

The large tap model is preserved for field use, with steppers retained for correction.

For Heart Rate:
- Default raw count is 25 beats in 15 seconds.
- Medic taps once per beat or adjusts using `-1 / +1`.
- System calculates `heart_rate = raw_count × 4`.

For Respiratory Rate:
- Default raw count is 10 breaths in 30 seconds.
- Medic taps once per breath or adjusts using `-1 / +1`.
- System calculates `respiratory_rate = raw_count × 2`.

The system stores:
- raw count
- measurement window seconds
- calculated per-minute value
- entry method: `tap`, `stepper`, or `clinical_override`

This keeps the fastest field interaction while preserving a clear audit trail.

## Sync Deduplication and Projection Conflict Resolution

There is no separate “sync echo cancellation” mechanism.

Clients deduplicate using:

```text
device_id + local_event_id
server sync_cursor
```

A device ignores events it already has locally because the event identity already exists in SQLite. Conflict handling is not based on filtering out the sender’s device ID.

If two devices record conflicting observations, both immutable events are preserved. Read-model projections use explicit conflict rules, primarily clinical `local_timestamp` LWW for status-like projection fields. The event history remains complete.

## Logistics Location-at-Time

`inventory_ledger` records `location_at_time` for every supply movement or consumption event.

This allows Command / Chamal to answer:
- where supplies were consumed
- which building/floor has high burn rate
- which medic bag or sector is at risk of stock-out
- where resupply runners should go

Example:

```json
{
  "building": "15A",
  "floor": "3",
  "apartment": "7",
  "sector_id": "uuid"
}
```

## Secure Handover QR

QR codes do not encode raw patient data.

Each patient has a `handover_token`, generated by the backend. The QR code contains a secure one-time-use handover URL/token.

When scanned:
1. Backend validates the token.
2. If valid and unused, it returns the authorized handover view.
3. Token is marked as used.
4. Future scans are rejected or require supervisor/command override.

This protects patient data and prevents uncontrolled sharing of the immutable record.

## Pediatric Medication Safety

For pediatric patients, medication events should include `weight_estimate_kg`; if missing, the event is still preserved and escalated.

The database must not block the medication event. Missing `weight_estimate_kg` is accepted, preserved, and escalated as a critical Watchdog / High-Risk Clinical Violation.

The system still does not prescribe medication doses. It records medication actions and flags missing pediatric weight context for immediate review.


---

# v1.1 Platoon Stock Logistics Layer

## Inventory hierarchy

C5 Sentinel-SAR uses a three-level logistics chain:

```text
Log-O / Truck Stock
        ↓ refill
Platoon Stock
        ↓ resupply
Medic Personal Bag
        ↓ consumed during treatment
Patient Treatment Event
```

## Platoon Stock definition

**Platoon Stock** is a small forward inventory controlled by the Platoon Commander. It exists between Log-O / Truck Stock and the medics' personal bags.

Purpose:
- allow the Platoon Commander to resupply assigned medics quickly
- aggregate medic requests before escalating to Log-O
- give Command and Chamal visibility into stock depletion by platoon, building, floor, and sector

## Permissions

| Action | Medic | Platoon Commander | Log-O | CC | Chamal |
|---|---:|---:|---:|---:|---:|
| View Platoon Stock | ✓ | ✓ | ✓ | ✓ | ✓ |
| Manually initialize Platoon Stock during staging | ✗ | ✓ | ✗ | ✗ | ✗ |
| Refill Platoon Stock during active incident | ✗ | ✓ | ✓ | ✗ | ✗ |
| Request supplies from Platoon Stock | ✓ | ✓ | ✗ | ✗ | ✗ |
| Take supplies from Platoon Stock | ✓, with PC permission | ✓ | ✗ | ✗ | ✗ |
| Transfer Platoon Stock to Medic Bag | ✗ | ✓ | ✗ | ✗ | ✗ |
| Aggregate medic requests and send to Log-O | ✗ | ✓ | ✗ | ✗ | ✗ |
| Direct Log-O → Medic emergency refill | ✗ | ✗ | ✓ | view | view |
| Edit stock after ledger entry is written | ✗ | ✗ | ✗ | ✗ | ✗ |

## Normal resupply path

```text
Medic requests supplies
↓
PC reviews requests
↓
PC approves and supplies from Platoon Stock
↓
System writes paired inventory ledger entries:
  Platoon Stock: -X
  Medic Bag: +X
```

## PC aggregation path to Log-O

```text
Multiple medics request supplies
↓
PC aggregates requests into one Platoon Stock refill request
↓
Log-O dispatches supplies to Platoon Stock
↓
System writes paired inventory ledger entries:
  Log-O / Truck Stock: -X
  Platoon Stock: +X
```

## Emergency override path

The normal path is:

```text
Log-O → Platoon Stock → Medic
```

Emergency direct path is allowed only as an override:

```text
Log-O → Medic
```

This must be logged as `DIRECT_LOGO_TO_MEDIC` with a required reason. It appears in the Command/Chamal logistics audit trail.

## Initial manual fill

During staging, the Platoon Commander may manually initialize Platoon Stock once.

The system writes `INITIAL_STOCK` entries to `inventory_ledger` with:
- owner_type = `platoon_stock`
- owner_id = PC user ID
- owner_label = `Platoon Stock`
- location_at_time = staging location / platoon location

Manual initialization is append-only. Corrections are recorded as `MANUAL_ADJUSTMENT` ledger entries, not edits.

## Inventory transfer rule

Every transfer is represented by paired ledger rows sharing the same `transfer_group_id`:

```text
Source owner: negative quantity_change
Target owner: positive quantity_change
```

Example:

```text
Platoon Stock -2 Tourniquets TRANSFER_OUT
Medic Cohen Bag +2 Tourniquets TRANSFER_IN
```

This keeps inventory auditable, offline-safe, and compatible with after-action logistics analysis.


---

# v1.1 Draft Incident, Sync, Vitals, and KPI Updates

## Draft Incident Patient Creation

`+ New Patient` is allowed under a draft incident. Patients created under a draft incident are marked `Pending Incident Approval` and remain syncable. PC / CC / Chamal screens show a blinking/pulsing approval banner until the draft incident is approved, merged, rejected, or acknowledged.

## Event-Driven Sync

Critical events trigger immediate sync attempts, including New Patient, Quick Patient, Vitals, Treatment, Triage, Handover, Supply Request, Building Unstable, Dead Man’s Switch, and Site Clear. Background sync is fallback only and runs every 60–90 seconds. Failed sync uses exponential backoff: 5s → 15s → 30s → 60s → 90s max.

## Tap + Stepper Vitals Entry

Vitals entry now uses a large tap control plus stepper correction:

```text
HR: default 25 beats / 15s → ×4
RR: default 10 breaths / 30s → ×2
```

The payload stores `entry_method = tap | stepper | clinical_override`.

## KPIs

Added KPI framework and MVP KPI dashboard metrics across Clinical, Operational, Logistics, and System / Adoption domains.


---

# v1.1 Architecture Corrections

## 1. Clinical Saves Are Never Blocked by Database Cleanliness

The database must not reject life-saving clinical documentation because a field is missing.

Example: pediatric medication without `weight_estimate_kg`.

Correct behavior:

```text
1. Save the clinical event.
2. Flag it as HIGH_RISK_CLINICAL_VIOLATION.
3. Create a critical Watchdog alert.
4. Show it immediately to Medic / PC / Chamal.
5. Include it in the AAR.
```

The system protects the patient first and data quality second.

## 2. Sync Conflict Model

`server cursor / sync metadata` is not used as the conflict-resolution mechanism.

The source of truth is the immutable event log. The server accepts all unique events by `device_id + local_event_id`.

Projection fields use clinical timestamp-based Last Write Wins only for read models:

```text
triage_recorded_at
status_recorded_at
access_recorded_at
location_recorded_at
```

If two events are semantically incompatible, both remain in the event log and a conflict record is created.

## 3. Logistics Location Is Automated

Medics do not manually enter `location_at_time` for every item used.

For treatment consumption, the system auto-fills inventory location from the active patient location. Manual location entry is reserved for PC / Log-O transfer corrections.

## 4. API Is Sync-Log First

The main write path is not `POST /patients` or `POST /events`.

The main write path is:

```http
POST /sync/log
GET  /sync/log?incident_id=&since_cursor=&limit=
```

All mobile saves are local-first. Network delivery is asynchronous and retry-safe.

## 5. Dead Man's Switch Is First-Class

Silent medic detection creates a real `watchdog_alerts` row with:

```text
alert_type = DEAD_MAN_SWITCH
severity = critical
escalate_to_role = PC
```

The alert remains active until acknowledged/resolved by PC / CC / Chamal.

## 6. Row Level Security

Supabase RLS is mandatory before any real deployment.

Direct table access is scoped by `incident_memberships`; global command roles may use service-role command dashboards, but ordinary authenticated users must not have blanket table access.

Baseline policies:

- Medics and PCs can create patients and clinical events only for incidents they are assigned to in `incident_memberships`.
- Log-O can manage logistics events, not clinical patient events.
- PC / CC / Chamal can read command dashboards and conflict logs.
- AAR is command-only.
- Backend service-role processes realtime outbox internally.

## 7. Event Log Purity

Clinical/operational event log must not contain UX telemetry.

UX telemetry and sync attempt telemetry are excluded from the clinical `event_type` enum. If needed, they belong in separate analytics / ingestion tables, not in the patient audit trail.

## 8. Tourniquet Lifecycle

Tourniquet has explicit lifecycle events:

```text
TOURNIQUET_APPLIED
TOURNIQUET_REASSESSMENT
TOURNIQUET_RELEASED
```

The active tourniquet projection is derived from these events. Offline reassessment and release events update watchdog state once synced. Active tourniquets require reassessment according to `next_reassessment_due_at`, derived from tourniquet clinical context and local doctrine. The maximum MVP interval is 120 minutes, but high-risk contexts may require 30–60 minute reassessment.

## 9. AAR Finalization

AAR is built continuously as a rolling incident timeline. Finalization uses command-only endpoints:

```http
GET  /command/incidents/:incidentId/aar/live-timeline
POST /command/incidents/:incidentId/aar/context-note
POST /command/incidents/:incidentId/aar/voice-memo
POST /command/incidents/:incidentId/aar/generate-final
GET  /command/incidents/:incidentId/aar
POST /command/incidents/:incidentId/aar/unlock
```

`generate-final` creates the exportable report from the rolling AAR timeline, immutable event history, KPI views, and command context notes.


---

# v1.1 Alignment Corrections

## 1. Sync Ingestion Errors

`sync_ingestion_errors` is now a first-class schema table.

`POST /sync/log` processes every event independently. A malformed/poison event is quarantined in `sync_ingestion_errors` and does not block valid events in the same batch.

Rules:

```text
Parseable but clinically incomplete event → accept + flag.
Malformed envelope → reject only that event + store in sync_ingestion_errors.
Duplicate device_id + local_event_id → return duplicate, do not insert again.
```

## 2. Pediatric Safety

Pediatric medication without `weight_estimate_kg` is never DB-blocked. The event is accepted and immediately escalated as:

```text
PEDIATRIC_MEDICATION_MISSING_WEIGHT
HIGH_RISK_CLINICAL_VIOLATION
```

## 3. Inventory Safety

Out-of-stock inventory does not block treatment recording. Negative stock is allowed temporarily and creates an `INVENTORY_NEGATIVE_STOCK_USED` alert for PC / Log-O reconciliation.

## 4. Command State Performance

Command dashboards should use `incident_command_state`, refreshed by a backend/service-role worker, instead of repeatedly scanning large event tables through RLS-heavy joins.

RLS remains mandatory for direct table access, but operational dashboard performance depends on precomputed command state.

## 5. Tourniquet Lifecycle

The vague `TOURNIQUET_STATUS_RECORDED` event is removed.

Tourniquet lifecycle is now explicit:

```text
TOURNIQUET_APPLIED
TOURNIQUET_REASSESSMENT
TOURNIQUET_RELEASED
```

Active tourniquets require reassessment according to `next_reassessment_due_at`, derived from tourniquet clinical context and local doctrine. The maximum MVP interval is 120 minutes, but high-risk contexts may require 30–60 minute reassessment.


---

# v1.1 Architecture and Field-Use Updates

## Dependency-Aware Sync Ingestion

`POST /sync/log` is still the only mobile write pipe, but partial success is now **dependency-aware**, not blind.

Every event envelope may include:

```json
{
  "device_id": "demo-device-cohen",
  "local_event_id": "evt-002",
  "depends_on": [
    { "device_id": "demo-device-cohen", "local_event_id": "evt-001" }
  ]
}
```

Rules:

1. Events are processed in dependency order where possible.
2. If a parent event is accepted, dependent child events may be accepted.
3. If a parent event is rejected or quarantined, child events are not inserted as orphan clinical records.
4. Blocked child events are stored in `sync_ingestion_errors` with `dependency_status = blocked_dependency`.
5. The server response tells the device which events are accepted, duplicated, rejected, or blocked by dependency.

This preserves the “one poison event does not kill the whole batch” principle without creating orphan vitals, orphan treatments, or orphan handovers.

## Proactive High-Risk Clinical UI

The database must preserve clinical history, but the UI must still intervene before high-risk saves.

For pediatric medication without `weight_estimate_kg`, reduced AVPU medication context, or other high-risk documentation gaps:

1. The normal confirmation button changes color and label.
2. The user sees a large warning.
3. The save action requires a **Double-Confirm Emergency Override**.
4. The event is still saved if confirmed.
5. The event is flagged in `watchdog_alerts`, `conflict_log`, and `high_risk_override_confirmations`.

Example label:

```text
⚠ Administer without weight estimate — emergency override
[Cancel] [Hold 2 sec to Confirm Override]
```

Server rule: if the event arrives without the override metadata, preserve it anyway and flag it as `HIGH_RISK_CLINICAL_VIOLATION`. The UI should prevent this path in normal use, but the backend must not destroy received medical history.

## Dynamic Tourniquet Context

Tourniquet watchdogs are no longer a single universal 120-minute rule.

Tourniquet application captures clinical context:

```text
arterial_bleed
amputation
crush_entrapment
venous_bleed
uncertain
unknown
```

The app proposes a reassessment interval based on context, with command/medical doctrine configurable per organization.

MVP default examples:

```text
crush_entrapment / uncertain: reassess every 30 minutes
arterial_bleed / amputation: reassess every 60 minutes
stable converted/down-graded context: reassess every 120 minutes max
```

Event lifecycle:

```text
TOURNIQUET_APPLIED
TOURNIQUET_REASSESSMENT
TOURNIQUET_CONTEXT_UPDATED
TOURNIQUET_RELEASED
```

The watchdog screams when `next_reassessment_due_at` is overdue, not merely when a fixed office timer expires.

## Data Freshness Indicator

Because mobile UI reads from local SQLite only, every operational screen must show data freshness.

Required header state:

```text
Fresh: last pull ≤ 60s
Stale: last pull > 60s
Critical stale: last pull > 5m
```

UI behavior:

- Fresh: normal tactical dark UI.
- Stale: yellow warning border/header.
- Critical stale: persistent warning banner: “Caution — local picture may be outdated.”

This prevents the “ghost dashboard” problem where a medic acts on old local data without realizing it.

## Command Snapshot Table

The Chamal/command dashboard should not perform large RLS-heavy joins during an MCI.

Use:

```text
incident_command_state
```

as a flat command snapshot table refreshed by a backend/service-role worker. The dashboard reads this table through a command API that performs one API-level permission check.

Direct client access to `incident_command_state` should be revoked. RLS remains mandatory for direct user-table access, but not as the hot path for dashboard aggregation.

## Idempotent, Time-Aware Watchdogs

Watchdogs must process events in chronological order and must be idempotent.

Rules:

1. Each alert has a deterministic `dedupe_key`.
2. Running the watchdog worker twice must not create duplicate active alerts.
3. If an event in the same sync batch resolves a risk, the alert is suppressed before it reaches the dashboard.
4. Example: if a batch contains “vitals overdue risk” and then `VITALS_RECORDED`, no active overdue-vitals alert should flash on Chamal.
5. Resolution is recorded with `resolved_by_event_id` for auditability.

## Panic Mode / Tactical High-Contrast UI

The clean UI is the default. SAR field use requires a second mode.

Panic Mode requirements:

- huge buttons
- no dropdowns for critical actions
- high-contrast colors
- haptic feedback for save/critical confirm
- optional loud audio cue where appropriate
- minimum 56×56px critical touch targets
- full-screen confirmation for high-risk medication / handover / site clear
- large Hebrew labels suitable for gloves, smoke, dust, rain, and blood on screen

Panic Mode can be toggled manually and can also auto-suggest when repeated mis-taps or low visibility mode is detected.

## Adaptive Battery-Aware Sync

Battery level is an operational clinical variable.

Modes:

```text
Normal: full immediate sync + normal pulls
Low Power (<30%): reduce noncritical telemetry and location frequency
Critical Only (<20%): immediate sync only for patient-critical events
```

Critical-only sync includes:

```text
New Patient
Vitals
Triage
Medication / Treatment
Tourniquet
Handover
Dead Man's Switch
Building unstable
```

Deferred while in critical-only mode:

```text
noncritical logistics details
fine-grained location updates
UX analytics
routine dashboard refreshes
```

The app must show:

```text
Battery Critical — Critical clinical sync only
```
