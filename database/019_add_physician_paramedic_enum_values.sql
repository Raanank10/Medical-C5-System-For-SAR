-- Adds physician and paramedic to the live user_role enum - the F3
-- cross-device conflict-resolution prerequisite recorded as open in
-- docs/CONFLICT_RESOLUTION_DECISION.md. Split into its own file/transaction
-- because Postgres forbids using a new enum value in the same transaction
-- that adds it (see 006_add_rpc_rcc_enum_values.sql for the same pattern).
-- RLS that depends on these values goes in 020_physician_paramedic_rls.sql.

alter type user_role add value if not exists 'physician';
alter type user_role add value if not exists 'paramedic';
