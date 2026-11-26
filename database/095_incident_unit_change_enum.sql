-- Event types for moving a site to another company and for reinforcing it (WP-27,
-- docs/GAP_CLOSURE_PLAN.md, owner 2026-11-21).
--
-- Its own file because a new enum value cannot be used in the same transaction that adds it
-- (same pattern as 063 and 066). Only the server writes them (database/096 RPCs); sync-log does
-- not accept them from phones.

alter type event_type add value if not exists 'INCIDENT_UNIT_HANDED_OVER';
alter type event_type add value if not exists 'INCIDENT_UNIT_REINFORCED';
alter type event_type add value if not exists 'INCIDENT_UNIT_RELEASED';
alter type event_type add value if not exists 'INCIDENT_UNIT_ACCESS_ENDED';
alter type event_type add value if not exists 'INCIDENT_UNIT_RELIEF_CONFIRMED';
