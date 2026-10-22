-- Event type for merging a duplicate incident into another (decision D8, revised by D10;
-- docs/GAP_CLOSURE_PLAN.md WP-11 part 2 PR B, V2.99.50).
--
-- Its own file because a new enum value cannot be used in the same transaction that adds it
-- (same pattern as 063). Applied live as 065_incident_merged_enum_value. The existing INCIDENT_DRAFT_MERGED is not reused: there are no drafts
-- any more (D10), and the audit trail should say what really happened. Only the server writes
-- it (merge_incident(), database/067); sync-log does not accept it from phones.

alter type event_type add value if not exists 'INCIDENT_MERGED';
