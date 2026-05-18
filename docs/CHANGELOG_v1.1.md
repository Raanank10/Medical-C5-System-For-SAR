# C5 Sentinel-SAR v1.1 Changelog

Changes applied from the reviewed draft spec:

1. Renamed the document from `FINAL SPECIFICATION v2.0` to `MVP Product & Technical Specification v1.1`.
2. Fixed the contradiction around incident creation and T₀:
   - Official incidents and T₀ can be set by CC, Chamal, and authorized PC.
   - Medic can create only a local draft incident.
3. Added draft incident workflow and confirmation rule.
4. Replaced absolute inventory quantity model with append-only `inventory_ledger`.
5. Corrected offline sync:
   - Server accepts all unique events using `device_id + local_event_id`.
   - Events are not discarded because of identical timestamps.
   - Semantic conflicts create conflict records/events.
6. Changed offline sync from push-only to push + pull.
7. Expanded the PostgreSQL schema to include missing tables:
   - sectors
   - realtime_outbox
   - external_reports
   - external_patient_links
   - inventory_ledger
   - kit_templates
   - kit_template_items
   - supply_request_items
   - watchdog_alerts
   - device_presence
8. Added Quick Patient mode.
9. Added minimal triage logic for cases without full vitals.
10. Required Quick Patient mode to capture:
    - tourniquet used
    - pulse present
    - breathing present
11. Added `needs_full_assessment` to patient schema.
12. Added patient lifecycle status:
    - Identified
    - Treating
    - Observing
    - Extricated
    - Handed Over
    - Closed / Read-only
13. Clarified `T_injury = T₀` by default and added `t_injury` to patient schema.
14. Added pediatric safety wording:
    - system records/warns but does not prescribe medication doses.
15. Changed QR handover from embedded record to secure token/link.
16. Replaced AsyncStorage as primary offline store with SQLite.
17. Added Realtime Outbox architecture explicitly.
18. Added API surface file and endpoint list.
19. Corrected wording and typos:
    - Evocation → Evacuation
    - Compact gaze → Combat Gauze
    - platoon commandor → Platoon Commander
    - Search And Rescue → Search and Rescue
20. Added safety/privacy/scope section.


---

# v1.1 Changes

## Vitals UX
Restored tap-first counting with stepper correction:
- 15s HR window → medic taps each beat or corrects with steppers → system calculates `count × 4`.
- 30s RR window → medic taps each breath or corrects with steppers → system calculates `count × 2`.
- Payload stores raw count, window seconds, calculated value, and `entry_method`.

## Sync Protection

## Logistics Location
Added `location_at_time` to `inventory_ledger` so Command can analyze exactly where supplies were consumed or moved.

## Secure Handover
Added `handover_token`, `handover_token_used_at`, and `handover_token_expires_at` to `patients`.
QR codes now represent a secure one-time handover token/link, not raw patient data.

## Pediatric Safety
Historical note corrected: pediatric medication events must not be blocked; missing `weight_estimate_kg` is preserved and escalated.


---

# v1.1 Changes

1. Removed database-blocking pediatric medication constraint.
   - Pediatric medication without `weight_estimate_kg` is now accepted, flagged as `HIGH_RISK_CLINICAL_VIOLATION`, and escalated via Watchdog.

2. Reworked sync model.
   - Added clinical timestamp LWW for read-model projections only.
   - Immutable events are still never discarded.

3. Automated logistics location capture.
   - `inventory_ledger.location_at_time` is auto-filled from patient location when available.
   - Medics are not expected to manually enter floor/building for each consumed item.

4. Reframed API as sync-log-first.
   - Main write endpoint is now `POST /sync/log`.
   - Main pull endpoint is now `GET /sync/log?since_cursor=`.
   - Public outbox endpoints removed from client API.

5. Added first-class Dead Man's Switch escalation.
   - Added function to create `watchdog_alerts` for silent medics and escalate to PC.

6. Added Supabase RLS baseline.
   - Role-based policies for clinical events, logistics, command views, conflict logs, and AAR.

7. Fixed inert incident time constraint.
   - `t_injury_default >= t_zero`.

8. Removed UX/sync telemetry from clinical event enum.
   - UX telemetry and sync attempt telemetry are no longer clinical event types.

9. Fixed KPI Cartesian product bug.
   - `vw_kpi_incident_command_summary` now aggregates patients, watchdog alerts, and device presence separately before joining.

10. Fixed duplicate demo tourniquet seed.
    - P-001 now has only one tourniquet event.

11. Clarified Actiq/Fentanyl warning.
    - Reduced AVPU/TBI-context warning applies to Actiq/Fentanyl in MVP.

12. Removed redundant `is_draft`.
    - `incidents.status = 'draft'` is now the single draft source of truth.

13. Added `TOURNIQUET_RELEASED` event and active tourniquet projection.

14. Documented sync request/response bodies, cursors, batching, and pagination.

15. Added explicit AAR generation endpoint.

16. Cleaned redundant seed `UPDATE supply_requests`.

17. Added non-null auto-filled `sector_label` for heatmap display.

9. Added `incident_memberships` and scoped RLS policies so direct table access is not blanket-authenticated.


---

# v1.1 Alignment Pass

1. Added package README.
2. Standardized AAR endpoints to command-only `/command/incidents/:incidentId/aar/...`.
3. Removed stale non-command AAR endpoint references.
4. Replaced the last out-of-stock blocking sentence with save-and-alert behavior.
5. Rechecked stale terms across spec, API, schema, seed, changelog, and README.
6. Clarified `pc` as the Platoon Commander / field Supervisor role.
7. Reintroduced large tap controls for pulse and respiratory-rate entry in the demo while preserving stepper correction.
