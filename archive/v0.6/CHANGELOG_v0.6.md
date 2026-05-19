# C5 Sentinel-SAR v0.6 Changelog

Changes applied from the reviewed draft spec:

1. Renamed the document from `FINAL SPECIFICATION v2.0` to `MVP Product & Technical Specification v0.6`.
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

# v0.6 Changes

## Vitals UX
Replaced tap-counting with a selectable timer model:
- 15s HR timer → medic enters counted beats → system calculates `count × 4`.
- 30s RR timer → medic enters counted breaths → system calculates `count × 2`.
- Payload stores raw count, window seconds, and calculated value.

## Sync Protection
Added `origin_device_id` to `realtime_outbox` so clients can ignore their own server-broadcasted updates and prevent sync echoes.

## Logistics Location
Added `location_at_time` to `inventory_ledger` so Command can analyze exactly where supplies were consumed or moved.

## Secure Handover
Added `handover_token`, `handover_token_used_at`, and `handover_token_expires_at` to `patients`.
QR codes now represent a secure one-time handover token/link, not raw patient data.

## Pediatric Safety
Added a database-level trigger that blocks `MEDICATION_ADMINISTERED` events for pediatric patients unless `weight_estimate_kg` is present in `payload_json`.
