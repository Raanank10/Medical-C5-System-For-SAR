# Field Experiment Gap Register

This repo is a development prototype, not a field-ready shared system. This register says what a field experiment with synthetic data can rely on today and what is still missing. Updated for V2.99.34 (it previously described the pre-backend prototype, when storage was browser-only and there was no multi-device visibility, which stopped being true with Phase 3).

## Current Prototype Truth

| Component | Current state | Still missing for a field experiment |
| --- | --- | --- |
| Persistence | Logged-in devices sync to the live Supabase Postgres project through `/sync/log` (`docs/ARCHITECTURE.md`, "Backend Deployment Status"). Clinically relevant `localStorage` is encrypted at rest behind a device PIN. | Backup/restore testing (`docs/BACKUP_AND_INCIDENT_RESPONSE_PLAN.md`). |
| Incident lifecycle | Logged-in mode starts empty. Incidents are opened from the field and are official at once; there are no drafts (D10, `database/064`, V2.99.48). Before a medic opens one, the phone offers to join an open incident of the medic's company; once opened, the company's PC and RCC, every RPC of the company (only the chosen platoon's once the PC or RCC sets it) and CC see a banner until each acknowledges it; the opener can cancel it as a false alarm while it has no patients. Other devices join from the incident picker (`database/038`, V2.99.26). An incident cannot be closed while patients are not handed over; only medical command can override, with a recorded reason (`database/040`, V2.99.28). | Closing and merging need a server connection. (Duplicate incidents are merged by CC, chamal or admin since V2.99.50, `database/067`.) ("Leave incident" was dropped by D9: closing the incident ends access.) |
| Multi-device visibility | Real push/pull, projected patient state, device presence and command-state snapshots across devices in the same incident. A medic's resupply request now reaches pc/cc/logistics through the server queue (V2.99.32). A patient received from another device shows no vitals values ("מדדים אצל החובש") instead of placeholder numbers (V2.99.32). | Session 2 of `docs/FIELD_USABILITY_TEST_PLAN.md` (real offline/intermittent drill) has not run yet. Active tourniquets and their timers now reach other devices through the server `tourniquets` table (V2.99.34); since V2.99.42 a limb recorded after application, an effectiveness check and a tourniquet ticked in the vitals-update screen reach the server too, and handover closes the server row (`database/056`-`058`); tourniquet notes stay on the recording device. Vitals values stay on the recording device. Since V2.99.39, treatments (`INTERVENTION_RECORDED`, `AIRWAY_MANAGED`), intake medications, pediatric high-risk confirmations and injury zones reach the server with the patient's id; since V2.99.41 other devices list them on the patient card under "טיפולים ממכשירים אחרים" (`database/055`). A full-flow patient's vitals time and a quick capture's needs-assessment flag also reach other devices now (V2.99.34). Since V2.99.38, doctor/paramedic/evacuation/death-certification requests and their status changes reach pc/cc/chamal/physician/admin and the requester on other devices (`database/052`); a physician's death confirmation closes the request. Since V2.99.43 the PC's resupply decision (approve from the truck, truck unavailable, escalate, delivered) reaches the medic, CC and logistics through the server queue (`database/059`); the CC's "fulfilled by company" / "closed" are still local. Since V2.99.44 rescue's T0, building status and site clear reach every phone in the incident (`database/060`); a medic's own incident-type pick still stays on the medic's phone. Since V2.99.46 each stock movement (medic bag use, PC truck issue or receipt) reaches the server (`database/062`): logistics and CC see the incident-wide burn rate and every bag's and truck's latest count; company stock is still a fixed starting value. Since V2.99.40, "בטיפול" on an alert is shared: every device sees who is handling the patient, and the alert comes back everywhere if the patient gets worse. Signed in, the CC platoon tiles and load rows use the real platoons (V2.99.39, `database/053`); the platoon-reassignment demo buttons stay local-demo only. |
| Synthetic data | Option A: people play medics and enter casualties live. Option B: `scripts/inject_scenario.js` has virtual medics push a synthetic timeline (`scenarios/`) through the real `/sync/log`, tagged `synthetic_source='injector'` so the AAR can separate it. | A live run of the injector during a field session. |
| Phone field testing | Not certified. Browser smoke tests cover the page itself. | Real iOS/Android testing: one-handed, glove mode, sunlight, lock screen, poor network. |
| Role separation | Real Supabase Auth; role comes from the server profile; RLS audited (`docs/RLS_AUDIT_v1.md`). | Unit scoping is real (`database/045`, `053`): pc and rcc reach their own company's sites, rpc its platoon's, medics only assigned or drafted ones; the rescue chain reads no clinical events. Three rescue companies, three platoons each, plus the ambulance team. `logistics_officer` can still list and join any open incident. `053` is live since 2026-10-20, but no companies or platoons are set up yet, so pc/rcc/rpc see only incidents they are members of until company command places them. |
| Watchdog timers | Browser-derived for visibility; server-side `watchdog_alerts` exist for some rules. | Durable backend watchdog worker with idempotent alert dedupe. |

## Before Testing With an Admin Account

Until V2.99.35 / `database/047`, an admin account could not create patients on the server (RLS), and the phone did not make that obvious. With `047` applied, admin works like a medic for patient intake. A patient the server rejects for any reason now shows "לא הגיע לשרת" on its tile and a red banner on its card, and the sync pill turns red. Treat any red pill during a test as "command cannot see this", and use the banner's resend button once the cause is fixed.

## Trap Status Decision

The patient flow treats extraction status as binary:

- `trapped`
- `not_trapped`

This is intentionally recorded late in the flow, after vitals and triage, so the medic is not blocked early by a transport/extraction question. Legacy `partial/full/none` values are kept only for old demo data and schema migration compatibility.

## Remaining Gates Before Any Real-World Use

- Run Field Usability Sessions 1-4 with synthetic data and record the results.
- Mobile device QA with browser lock/unlock, refresh, and airplane-mode sync recovery.
- Move watchdog execution to backend jobs and verify idempotent alert dedupe.
- Backup/incident-response plan and clinical/legal governance sign-off (`docs/OPERATIONS_SAFETY.md`).
