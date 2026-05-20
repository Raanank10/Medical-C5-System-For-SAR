# Field Experiment Gap Register

This repo is a development prototype, not a field-ready shared system yet.

## Current Prototype Truth

| Component | Current state | Field experiment requirement |
| --- | --- | --- |
| Persistence | Browser-local `localStorage` only. Patient records survive normal refresh/reopen on the same browser profile, but this is not durable clinical storage. | Supabase/Postgres sync with encrypted offline queue and backup/restore testing. |
| Multi-device visibility | Not present in the static demo. Each device has its own local browser store. | Shared incident state through `/sync/log`, command read models, and realtime updates. |
| Phone field testing | Not certified. Browser smoke tests cover the local page only. | Real iOS/Android testing: one-handed, glove mode, sunlight, lock screen, poor network. |
| Role separation | UI role switching only. Database schema has RLS/role concepts, but the static app does not enforce auth. | Authenticated roles: medic, PC/commander, logistics, admin. |
| Watchdog timers | Browser-derived for demo visibility. They can pause if the tab sleeps. | Backend watchdog worker creates durable `watchdog_alerts`; local timers are only advisory. |

## Trap Status Decision

The patient flow now treats extraction status as binary:

- `trapped`
- `not_trapped`

This is intentionally recorded late in the flow, after vitals and triage, so the medic is not blocked early by a transport/extraction question. Legacy `partial/full/none` values are kept only for old demo data and schema migration compatibility.

## Production Gates Before Field Use

- Implement real `/sync/log` ingestion for every local event.
- Make command dashboard read backend snapshots, not local demo arrays.
- Add authenticated role routing and RLS-backed API tests.
- Run mobile device QA with browser lock/unlock, refresh, and airplane-mode sync recovery.
- Move watchdog execution to backend jobs and verify idempotent alert dedupe.
