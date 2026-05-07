C5 Sentinel-SAR
Mission-Critical Medical Command & Control for Home Front Command SAR Operations

What Is This?
C5 Sentinel-SAR is a full-stack C2 (Command & Control) system designed for Search & Rescue medical companies operating in mass-casualty scenarios.
The system eliminates the "Fog of War" in three domains:
🔥 Key Innovations**

**Clinical Watchdogs**: Automated "second-eye" alerts for Crush Syndrome (45m mark), Golden Hour expiration, and Tourniquet limits.
**Event-Sourced Architecture**: Every vital sign and intervention is an immutable event, providing a 100% auditable timeline for After-Action Reports (AAR).
**Tactical Funnel**: A command-level visualization tracking the patient progression from Trapped → In-Treatment (Stabilized) → Extricated → Evacuated.
**Logistics Intelligence**: Real-time "Burn Rate" monitoring that predicts supply exhaustion before it halts the mission.

**Origin**
This project was built from a real operational gap.
I serve in an IDF reserve SAR unit. During operations in central Israel, I recognized that while our teams are highly trained and prepared, the physical tools for data collection (such as paper triage tags and verbal radio relays) impose a "cognitive load" that technology can significantly alleviate.
As a data analyst by profession, I recognized the problem immediately:

A mass-casualty event is a data pipeline with a life-or-death SLA.

Every patient is a record. Every vital sign is an event. Every triage decision is a classification. The "Fog of War" is just missing data and broken observability. So I built the system I wished existed.

System Overview
The platform has two interfaces and five user roles:
Interfaces

**Frontend (Field)**: React Native / Expo (Optimized for one-handed, gloved operation).
**Dashboard (Command)**: React + Tailwind (Real-time Heatmaps & Funnels).

Roles
Medic → Platoon Commander → Logistics Officer → Company Commander (CC) → Chamal

Core Features
🏥 7-Step Treatment Pipeline (Mobile)

Location — Building, floor, apartment, structural status
Access — Free / Partial / Trapped (arms Crush Syndrome watchdog)
T-Kit — Tourniquet log with auto-applied time and elapsed counter
Vitals — Tap-to-count heart rate (15s × 4) and respiratory rate (30s × 2); AVPU 4-button; BP palpation 3-button
Triage — MSTART (adult) / JumpSTART (pediatric) with algorithmic suggestion, manual override with mandatory audit reason
Status — Treating / Observing / Extricated
Interventions — Morphine, IV Fluids, Actiq with auto-inventory decrement and TBI safety guard

⏱ Watchdog Stack (Local Clocks — No Connectivity Required)
 Alert 	 Trigger 
 Crush Syndrome 	 T+45 min from T₀ for any trapped patient 
 Golden Hour Amber 	 T+45 min from injury time 
 Golden Hour Red 	 T+60 min from injury time 
 T-Kit Warning: 60 min since tourniquet applied 
 T-Kit Critical 	 120 min since tourniquet applied 
 Re-assess RED 	 every 10 min 
 Re-assess YELLOW 	 Every 30 min 
 Dead Man's Switch 	 Medic device inactive >5m 
<img width="470" height="217" alt="image" src="https://github.com/user-attachments/assets/574ec9ca-3ec8-44d8-8b93-28302d92d582" />

🖥 Command Dashboard (Web)

Tactical Funnel — **Trapped** → **In-Treatment (Stabilized**) → **Extricated** → **Evacuated**
Final Sweep Heatmap — Building grid, sector turns green only when all patients are handed over + Platoon/Company commanders confirms Site Clear
Conflict Log — All triage overrides and clinical contraindication flags
Medic Status Panel — Real-time activity tracking with Dead Man's Switch badges
Logistics Hub — Pre-set kit templates, burn rate, supply request queue, dispatch workflow

📋 MIST Handover & QR Code
Auto-generated handover script (Mechanism / Injuries / Signs / Treatment) + patient QR code for evacuation paramedic scan. Confirms handover in one tap.
📊 After-Action Report (AAR)
Unlocks after all patients are handed over and all sectors cleared. Exports PDF covering:

Triage accuracy % (algorithm vs. human)
Golden Hour compliance rate
Time-to-clear per sector
Supply burn rate vs. predicted stock


Triage Algorithms
MSTART (Adult, age ≥ 8)
RR = 0           → BLACK
RR > 30 or < 8   → RED
BP = None        → RED (MCI override possible — PC/CC only, logged)
AVPU Unresponsive → RED
AVPU Pain        → YELLOW
else             → GREEN
JumpSTART (Pediatric, age < 8)
RR = 0 → check pulse
  No pulse        → BLACK
RR < 15 or > 45  → RED
BP = None        → RED
AVPU Unresponsive → RED
AVPU Pain        → YELLOW
else             → GREEN

Technical Architecture
Mobile (React Native / Expo)
      ↕ Offline-first / Append-only sync
Web Dashboard (React + Tailwind)
      ↕ Supabase Realtime subscriptions
PostgreSQL (Event-Sourced schema)
Design principle: Every action is an immutable, timestamped JSON event. Nothing is ever updated or deleted. The current state is computed by replaying the event log. This means:

100% auditability
Zero merge conflicts in offline-sync scenarios
Complete after-action reconstruction from any device's partial log


Database Schema (Simplified)
incidents     — id, t_zero, location, status
users         — id, name, role, device_id, last_seen
patients      — id, incident_id, visual_id, triage, location, status, handed_over
events        — id, patient_id, actor_id, type, payload, local_timestamp, synced_at
inventory     — owner_id, item_id, quantity, threshold
supply_requests — requester_id, items, status, eta
conflict_log  — event_id, patient_id, algo_value, human_value, reason, actor_id

Repo Structure
c5-sentinel-sar/
├── README.md
├── SPEC.md                          ← Full technical specification v1.0
├── docs/
│   └── linkedin-series.md           ← Project story & public communications (later on)
├── mobile/                          ← React Native / Expo app (planned)
│   ├── src/
│   │   ├── screens/
│   │   ├── components/
│   │   └── logic/
│   │       ├── mstart.js
│   │       ├── watchdog.js
│   │       └── eventStore.js
├── web/                             ← React dashboard (planned)
│   ├── src/
│   │   ├── views/
│   │   └── components/
└── supabase/                        ← DB schema & migrations (planned)
    └── schema.sql

Status

🔨 In Design & Specification Phase
Full technical specification complete. Build phase planned.

Author
Raanan Kelner
Data Analyst | IDF Reserve SAR Team Member [LinkedIn]([url](https://www.linkedin.com/in/raanan-kelner/)) 
Built from the field up. Every feature exists because a real operational gap made it necessary.
