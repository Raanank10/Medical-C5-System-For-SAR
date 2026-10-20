-- Treatment history for other devices (WP-3 step 6, docs/GAP_CLOSURE_PLAN.md, V2.99.41).
--
-- Decided by the repo owner 2026-10-20: the patient card on other devices (CC, PC, another medic)
-- shows treatments recorded on another phone. Since V2.99.37 (WP-3) treatments, medications and
-- opened airways reach the server, but no device read them back.
--
-- vw_patient_treatment_history (security_invoker, so events RLS decides who reads what) had two
-- gaps for that:
-- - it listed INTERVENTION_RECORDED, MEDICATION_ADMINISTERED and TOURNIQUET_APPLIED but not
--   AIRWAY_MANAGED, which the client sends for an opened airway (WP-3 follow-up);
-- - it had no device_id, so a phone could not tell its own treatments (already on its card) from
--   another device's.
-- Same columns in the same order, plus device_id and local_event_id at the end (create or replace
-- view may only add columns at the end). security_invoker is restated so it cannot be lost.

create or replace view public.vw_patient_treatment_history
with (security_invoker = true)
as
select
  e.id as event_id,
  e.incident_id,
  e.patient_id,
  e.actor_id,
  e.type,
  e.local_timestamp,
  e.payload_json ->> 'treatment_type' as treatment_type,
  e.payload_json ->> 'limb' as limb,
  e.payload_json ->> 'medication' as medication,
  e.payload_json -> 'location_at_time' as location_at_time,
  e.payload_json,
  e.device_id,
  e.local_event_id
from events e
where e.type = any (array[
  'INTERVENTION_RECORDED'::event_type, 'MEDICATION_ADMINISTERED'::event_type,
  'TOURNIQUET_APPLIED'::event_type, 'AIRWAY_MANAGED'::event_type
])
order by e.patient_id, e.local_timestamp;
