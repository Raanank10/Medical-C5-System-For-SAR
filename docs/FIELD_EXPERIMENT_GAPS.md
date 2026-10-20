# Field Experiment Gap Register

This repo is a development prototype, not a field-ready shared system. This register says what a field experiment with synthetic data can rely on today and what is still missing. Updated for V2.99.34 (it previously described the pre-backend prototype, when storage was browser-only and there was no multi-device visibility, which stopped being true with Phase 3).

## Current Prototype Truth

| Component | Current state | Still missing for a field experiment |
| --- | --- | --- |
| Persistence | Logged-in devices sync to the live Supabase Postgres project through `/sync/log` (`docs/ARCHITECTURE.md`, "Backend Deployment Status"). Clinically relevant `localStorage` is encrypted at rest behind a device PIN. | Backup/restore testing (`docs/BACKUP_AND_INCIDENT_RESPONSE_PLAN.md`). |
| Incident lifecycle | Logged-in mode starts empty. Incidents are opened from the field: a medic opens a draft that command confirms or rejects, command opens an official incident directly, other devices join from the incident picker (`database/038`, V2.99.26). An incident cannot be closed while patients are not handed over; only medical command can override, with a recorded reason (`database/040`, V2.99.28). | Draft merge into another incident; a "leave incident" action; closing needs a server connection. |
| Multi-device visibility | Real push/pull, projected patient state, device presence and command-state snapshots across devices in the same incident. A medic's resupply request now reaches pc/cc/logistics through the server queue (V2.99.32). A patient received from another device shows no vitals values ("מדדים אצל החובש") instead of placeholder numbers (V2.99.32). | Session 2 of `docs/FIELD_USABILITY_TEST_PLAN.md` (real offline/intermittent drill) has not run yet. Active tourniquets and their timers now reach other devices through the server `tourniquets` table (V2.99.34); a limb recorded after application, effectiveness and notes stay on the recording device, and a tourniquet on a handed-over patient keeps its server row active. Vitals values stay on the recording device. Since V2.99.39, treatments (`INTERVENTION_RECORDED`, `AIRWAY_MANAGED`), intake medications, pediatric high-risk confirmations and injury zones reach the server with the patient's id; other devices still do not display them. A full-flow patient's vitals time and a quick capture's needs-assessment flag also reach other devices now (V2.99.34). Since V2.99.38, doctor/paramedic/evacuation/death-certification requests and their status changes reach pc/cc/chamal/physician/admin and the requester on other devices (`database/052`); a physician's death confirmation closes the request. PC-side resupply status updates are still never pushed. Since V2.99.40, "בטיפול" on an alert is shared: every device sees who is handling the patient, and the alert comes back everywhere if the patient gets worse. Signed in, the CC platoon tiles and load rows use the real platoons (V2.99.39, `database/053`); the platoon-reassignment demo buttons stay local-demo only. |
| Synthetic data | Option A: people play medics and enter casualties live. A scenario injector (virtual medics pushing a synthetic timeline through the real `/sync/log`) is the planned option B. | The injector itself (PR3 of the incident-lifecycle work). |
| Phone field testing | Not certified. Browser smoke tests cover the page itself. | Real iOS/Android testing: one-handed, glove mode, sunlight, lock screen, poor network. |
| Role separation | Real Supabase Auth; role comes from the server profile; RLS audited (`docs/RLS_AUDIT_v1.md`). | Platoon scoping is real (`database/045`, `053`): pc and rpc reach their own platoon's sites, medics only assigned or drafted ones, the rescue chain reads no clinical events. One company by decision. `logistics_officer` can still list and join any open incident. `053` is not applied live yet. |
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
