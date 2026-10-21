-- Inventory on the server, part 1 of 2 (WP-9, docs/GAP_CLOSURE_PLAN.md, V2.99.46). 062 projects.
--
-- Decision D2 (owner, 2026-10-21): keep inventory_ledger_v12, archive the v1.1 inventory_ledger.
-- Both were empty live that day. v12's plain-text item_type matches the client's own item keys
-- (tourniquets, ivKits ...), so no key-to-id mapping is needed.
--
-- 1. Archive v1.1: renamed, not dropped (the owner's rule: no data dropped without the owner). Its
--    views and triggers follow the table. Writes are revoked so nothing lands there by mistake.
-- 2. Two movement kinds the client has and the enum did not: a correction of a recorded use
--    ('correction', positive or negative), and stock the PC truck hands out when the PC approves a
--    resupply request ('pc_truck_issued'). Added here, used in 062 (a new enum value cannot be used
--    in the same transaction that adds it).
-- 3. v12 had no idea whose stock a row belongs to. stock_owner says medic bag or PC truck (the
--    holder is actor_id); stock_after is the holder's count after the movement, as the phone saw
--    it; occurred_at is the phone's own time of the movement (created_at is server arrival time,
--    which can be much later after offline work). With stock_after, the latest row per holder and
--    item is that holder's current stock, without the server needing the client's starting
--    quantities.

alter type logistics_movement_type add value if not exists 'correction';
alter type logistics_movement_type add value if not exists 'pc_truck_issued';

do $$
begin
  if to_regclass('public.inventory_ledger') is not null and to_regclass('public.inventory_ledger_v11_archived') is null then
    execute 'alter table public.inventory_ledger rename to inventory_ledger_v11_archived';
  end if;
end $$;
comment on table inventory_ledger_v11_archived is
  'Archived by decision D2 (2026-10-21, docs/GAP_CLOSURE_PLAN.md): v1.1 inventory ledger, never written by the client. inventory_ledger_v12 is the live ledger. Kept for history; writes revoked.';
revoke insert, update, delete on inventory_ledger_v11_archived from anon, authenticated;

alter table inventory_ledger_v12 add column if not exists stock_owner text not null default 'medic_bag';
alter table inventory_ledger_v12 add column if not exists stock_after integer;
alter table inventory_ledger_v12 add column if not exists occurred_at timestamptz;
do $$ begin
  alter table inventory_ledger_v12 add constraint inventory_ledger_v12_stock_owner_check check (stock_owner in ('medic_bag', 'pc_truck'));
exception when duplicate_object then null; end $$;
create index if not exists idx_ledger_v12_incident_occurred on inventory_ledger_v12 (incident_id, occurred_at desc);
