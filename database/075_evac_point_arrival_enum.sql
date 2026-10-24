-- WP-18 (V2.99.65): arrival at the site's evacuation point (נקודת פינוי) as its own event.
--
-- PATIENT_EVAC_POINT_ARRIVED: a medic, paramedic, physician or PC of the incident confirms that a
-- patient the rescuers were moving (status evacuating) has reached the evacuation point and is
-- waiting there for an MDA ambulance. 076 projects it into patients.
--
-- Own file/transaction: Postgres forbids using a new enum value in the same transaction that
-- adds it (same reason 043 and 044 are split) - 076 uses this value.

alter type event_type add value if not exists 'PATIENT_EVAC_POINT_ARRIVED';
