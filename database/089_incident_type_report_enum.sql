-- WP-25 (V2.99.82): a medic's incident-type change reaches the server.
--
-- INCIDENT_TYPE_SET_BY_MEDIC: a medic, paramedic or physician adds a type to the incident, or
--   removes one (payload action 'add' | 'remove', reportedType). 090 applies it when the authority
--   ladder allows; a removal it does not allow becomes a report for PC/CC/rescue.
-- INCIDENT_TYPE_MISMATCH_REPORTED: written by index.html since WP-8 (a medic's pick that differed
--   from the set type) but kept on the phone. With several types per incident (owner 2026-11-18)
--   a different pick is simply another type, so 090 treats it as an add. Kept for older phones.
--
-- Own file/transaction: Postgres forbids using a new enum value in the same transaction that adds
-- it (same reason 076 and 077 are split) - 090 uses these values.

alter type event_type add value if not exists 'INCIDENT_TYPE_SET_BY_MEDIC';
alter type event_type add value if not exists 'INCIDENT_TYPE_MISMATCH_REPORTED';
