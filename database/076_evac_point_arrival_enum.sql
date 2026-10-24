-- WP-18 (V2.99.66): arrival at the site's evacuation point (נקודת פינוי) as its own event.
--
-- PATIENT_EVAC_POINT_ARRIVED: a medic, paramedic, physician or PC of the incident confirms that a
-- patient the rescuers were moving (status evacuating) has reached the evacuation point and is
-- waiting there for an MDA ambulance. 077 projects it into patients.
--
-- Applied live 2026-10-24 under the name 075_evac_point_arrival_enum, before main's
-- 075_events_actor_role_bound_and_advanced_procedures took that number; renumbered 076 in the repo.
--
-- Own file/transaction: Postgres forbids using a new enum value in the same transaction that
-- adds it (same reason 043 and 044 are split) - 077 uses this value.

alter type event_type add value if not exists 'PATIENT_EVAC_POINT_ARRIVED';
