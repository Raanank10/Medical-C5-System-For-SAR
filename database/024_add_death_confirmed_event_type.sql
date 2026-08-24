-- Adds the event_type enum value for a real, physician-only "confirms death"
-- clinical action (docs/CONFLICT_RESOLUTION_DECISION.md's "Paramedic/physician
-- clinical-authority parity" section flagged this as a real gap: the existing
-- death-certification workflow was narrative/demo-only, no real event type,
-- no RLS, no functional action anywhere in the code).
--
-- Deliberately distinct from any legal "official death certification", which
-- stays explicitly out of scope - this is a physician's own clinical
-- confirmation, one authenticated fact among others in the event log, not a
-- legal instrument. The field-level black tag (PATIENT_TRIAGED_EXPECTANT,
-- already real) stays open to every clinical role, unchanged - see 025 for
-- the mechanism this event type drives.
--
-- Own file/transaction: Postgres forbids using a new enum value in the same
-- transaction that adds it (same reason 006/019 split their enum adds this way).

alter type event_type add value if not exists 'PATIENT_DEATH_CONFIRMED';
