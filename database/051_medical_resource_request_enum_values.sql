-- Medical reinforcement and death-certification requests (WP-5, docs/GAP_CLOSURE_PLAN.md) - enum
-- values only. 052 projects them.
--
-- Kept in its own file, like 043 before 044 and 049 before 050: a new enum value cannot be used in
-- the same transaction that adds it.
--
-- The client already writes these three names (createMedicalResourceRequest(),
-- updateReinforcementStatus() in index.html), but none of them was in the event_type enum, so
-- sync-log could not store them and no other device ever saw a request:
-- - MEDICAL_REINFORCEMENT_REQUESTED: a medic / PC / CC / physician asks for a medic, paramedic,
--   doctor, evacuation or equipment.
-- - DOCTOR_DEATH_CERTIFICATION_REQUESTED: a medic marks a casualty "suspected deceased / not
--   salvageable"; a physician must certify the death.
-- - MEDICAL_REINFORCEMENT_STATUS_UPDATED: acknowledged / assigned / en route / arrived / resolved /
--   cancelled ..., for either kind of request.

alter type event_type add value if not exists 'MEDICAL_REINFORCEMENT_REQUESTED';
alter type event_type add value if not exists 'DOCTOR_DEATH_CERTIFICATION_REQUESTED';
alter type event_type add value if not exists 'MEDICAL_REINFORCEMENT_STATUS_UPDATED';
