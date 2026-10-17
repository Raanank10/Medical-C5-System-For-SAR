# Field Experiment Gap Register

This repo is a development prototype, not a field-ready shared system. This register says what a field experiment with synthetic data can rely on today and what is still missing. Updated for V2.99.31 (it previously described the pre-backend prototype, when storage was browser-only and there was no multi-device visibility, which stopped being true with Phase 3).

## Current Prototype Truth

| Component | Current state | Still missing for a field experiment |
| --- | --- | --- |
| Persistence | Logged-in devices sync to the live Supabase Postgres project through `/sync/log` (`docs/ARCHITECTURE.md`, "Backend Deployment Status"). Clinically relevant `localStorage` is encrypted at rest behind a device PIN. | Backup/restore testing (`docs/BACKUP_AND_INCIDENT_RESPONSE_PLAN.md`). |
| Incident lifecycle | Logged-in mode starts empty. Incidents are opened from the field: a medic opens a draft that command confirms or rejects, command opens an official incident directly, other devices join from the incident picker (`database/038`, V2.99.26). An incident cannot be closed while patients are not handed over; only medical command can override, with a recorded reason (`database/040`, V2.99.28). | Draft merge into another incident; a "leave incident" action; closing needs a server connection. |
| Multi-device visibility | Real push/pull, projected patient state, device presence and command-state snapshots across devices in the same incident. A medic's resupply request now reaches pc/cc/logistics through the server queue (V2.99.31). A patient received from another device shows no vitals values ("מדדים אצל החובש") instead of placeholder numbers (V2.99.31). | Session 2 of `docs/FIELD_USABILITY_TEST_PLAN.md` (real offline/intermittent drill) has not run yet. Vitals values, injuries, location, treatments and tourniquets stay on the recording device: the Quick/Extended patient flow sends `TOURNIQUET_APPLIED` without a `patient_id`, so the server never projects it, and no client reads the `tourniquets` table. Doctor/paramedic/evacuation/death-certification requests (`MEDICAL_REINFORCEMENT_REQUESTED`) and PC-side resupply status updates are never pushed. The CC platoon-load panel is still built from `DEMO_PLATOONS`/`DEMO_USERS`. |
| Synthetic data | Option A: people play medics and enter casualties live. A scenario injector (virtual medics pushing a synthetic timeline through the real `/sync/log`) is the planned option B. | The injector itself (PR3 of the incident-lifecycle work). |
| Phone field testing | Not certified. Browser smoke tests cover the page itself. | Real iOS/Android testing: one-handed, glove mode, sunlight, lock screen, poor network. |
| Role separation | Real Supabase Auth; role comes from the server profile; RLS audited (`docs/RLS_AUDIT_v1.md`). | Unit (platoon/company) scoping; any active account can currently list and join any open incident. |
| Watchdog timers | Browser-derived for visibility; server-side `watchdog_alerts` exist for some rules. | Durable backend watchdog worker with idempotent alert dedupe. |

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
