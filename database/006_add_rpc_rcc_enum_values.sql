-- Adds the rpc (מ״מ, Rescue Platoon Commander) and rcc (מ״פ חילוץ, Rescue
-- Company Commander) roles - shipped client-side in V2.995 - to the actual
-- user_role enum. Split into its own file/transaction because Postgres
-- forbids using a new enum value in the same transaction that adds it
-- (see 007_rpc_rcc_site_authority_rls.sql for the RLS that depends on this).

alter type user_role add value if not exists 'rpc';
alter type user_role add value if not exists 'rcc';
