# Role Authorization and Watchdog Stack v1.2

This document defines the operating roles, the demo authorization matrix, and the local/server watchdog rules for the C5 Sentinel-SAR development prototype.

## Roles

| Role | Meaning |
| --- | --- |
| Medic | Field clinician. Creates casualty records, captures vitals/interventions, requests resupply, and may create a local draft incident only when no official incident is available. |
| חוג״ד / חפ״ק רפואי | Opens official incidents, confirms drafts, supervises clinical and command state, dispatches supply to Log-O, and unlocks live incident summary / AAR. |
| Logistics Officer (Log-O) | Manages kit templates, resupply runners, and company equipment status. Does not create or edit clinical casualty records. |
| מ״פ רפואה | Company medical-resource command authority for official incident confirmation, closure/reopen, site clear, resource allocation, dashboard, conflict log, and AAR. |
| Chamal | Higher command/operations room. Confirms draft incidents, manages official incident state, sees command dashboards, conflict log, and AAR. |

Medic-created draft incidents are local-first capture containers. They must later be confirmed by חוג״ד, מ״פ רפואה, or Chamal, and the confirmation must be represented as an auditable event.

## Authorization Matrix

| Action | Medic | חוג״ד | Log-O | מ״פ רפואה | Chamal |
| --- | ---: | ---: | ---: | ---: | ---: |
| Create local draft incident | Yes | Yes | No | Yes | Yes |
| Open official incident and set T0 | No | Yes | No | Yes | Yes |
| Confirm draft incident | No | Yes | No | Yes | Yes |
| Close / reopen official incident | Limited | Yes | No | Yes | Yes |
| Register new patient | Yes | Yes | No | No | No |
| Record vitals and interventions | Yes | Yes | No | No | No |
| Override MSTART / JumpSTART triage | Yes | Yes | No | No | No |
| Mark patient handed over | Yes | Yes | No | No | No |
| Request resupply | Yes | No | No | No | No |
| Dispatch supply to Log-O | No | Yes | No | No | No |
| Manage kit templates | No | Yes | Yes | Yes | No |
| Dispatch resupply runner | No | No | Yes | No | No |
| Update building status | Yes | Yes | No | Yes | Yes |
| Confirm Site Clear | No | Yes | No | Yes | Yes |
| View full command dashboard | No | Yes | Yes | Yes | Yes |
| View conflict log | No | Yes | No | Yes | Yes |
| Unlock and export AAR | No | Yes | No | Yes | Yes |

## Watchdog Stack

Watchdogs run locally for field awareness and must also be reproducible server-side for Chamal/AAR validation.

| Watchdog | Trigger | Threshold | Alert |
| --- | --- | ---: | --- |
| Crush Syndrome | Access = Trapped | T_injury +45m | Amber, escalating to Red if prolonged |
| Golden Hour | Any registered patient | T_injury +45m | Amber |
| Golden Hour | Any registered patient | T_injury +60m | Red |
| Tourniquet Warning | Tourniquet per limb | +60m from application | Amber |
| Tourniquet Critical | Tourniquet per limb | +120m from application | Red |
| Reassessment RED | Triage = RED | Every 10m | Prompt |
| Reassessment YELLOW | Triage = YELLOW | Every 30m | Prompt |
| Dead Man's Switch | Medic inactivity | >5m with no events/heartbeat | Supervisor alert |

## Current Implementation Notes

- The static demo now exposes the roles and authorization matrix in the `roles` screen.
- The command screen now shows a local Watchdog Stack panel using the same thresholds above.
- The PostgreSQL v1.2 schema already has a `user_role` enum with `medic`, `pc`, `logistics_officer`, `cc`, `chamal`, and `admin`, plus draft incident confirmation fields and RLS scaffolding.
- Production enforcement must still happen in the API/database layer, not only in the static HTML demo.
