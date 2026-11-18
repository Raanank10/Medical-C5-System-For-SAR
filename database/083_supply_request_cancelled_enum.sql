-- A resupply request cancelled by command (WP-24, docs/GAP_CLOSURE_PLAN.md, repo owner 2026-11-18) -
-- enum value only. 084 projects it.
--
-- Kept in its own file, like 080/081: a new enum value cannot be used in the same transaction that
-- adds it.
--
-- SUPPLY_REQUEST_CANCELLED: a request no longer to be filled. Payload: supply_request_id (the
-- server id), reason (not_needed / duplicate / supplied_otherwise / other), note (required for
-- other), the request's level and status as the phone saw them.

alter type event_type add value if not exists 'SUPPLY_REQUEST_CANCELLED';
