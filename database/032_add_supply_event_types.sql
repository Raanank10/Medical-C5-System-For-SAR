-- The real client (index.html) has always emitted these event types from its
-- supply-consumption and PC-truck resupply flow (consumeFieldSupply,
-- receiveLogisticsSupply, submitMedicResupplyRequest, updateResupplyStatus),
-- but they were never added to the event_type enum - only SUPPLY_REQUEST_*
-- (schema-native, unused by the client) made it in back in 001. A prior
-- session fixed the sync-log Edge Function's ROLE_ALLOWED_EVENT_TYPES
-- allow-list to stop rejecting these with FORBIDDEN_ACTOR_ROLE, but that
-- fix alone is not sufficient: events.type is `event_type not null`, so an
-- insert with one of these values would still fail at the database layer
-- with "invalid input value for enum event_type" even once the Edge
-- Function let it through. This migration is the other half of that fix.
--
-- Own file/transaction: Postgres forbids using a new enum value in the same
-- transaction that adds it (same reason 006/019/024 split their enum adds
-- this way) - 033 (supply request projection) depends on these values and
-- is therefore a separate, later file.

alter type event_type add value if not exists 'SUPPLY_CONSUMED';
alter type event_type add value if not exists 'SUPPLY_USE_CANCELLED';
alter type event_type add value if not exists 'INVENTORY_LEDGER_MOVEMENT';
alter type event_type add value if not exists 'LOCAL_STOCKOUT_WARNING';
alter type event_type add value if not exists 'RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE';
alter type event_type add value if not exists 'RESUPPLY_REQUEST_ESCALATED_CC';
alter type event_type add value if not exists 'RESUPPLY_APPROVED_FROM_PC_TRUCK';
alter type event_type add value if not exists 'PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED';
alter type event_type add value if not exists 'RESUPPLY_ESCALATED_TO_CC';
