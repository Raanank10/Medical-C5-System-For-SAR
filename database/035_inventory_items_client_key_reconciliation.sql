-- Kit templates (database/001's kit_templates/kit_template_items, still unused by the client -
-- see docs/ARCHITECTURE.md's Backend Deployment Status for the audit that found this) normalize
-- to inventory_items.id, but the client's real item vocabulary (SUPPLY_LABELS in index.html:
-- tourniquets/pressureDressings/hemostaticGauze/airwayEquipment/ivKits/blankets/batteryPacks)
-- and inventory_items.sku (TQ/BANDAGE/COMBAT_GAUZE/...) are two different naming conventions for
-- what turn out to be, for 6 of the 7 items, the SAME physical thing:
--
--   tourniquets      -> TQ               (Tourniquet)
--   pressureDressings-> BANDAGE          (First-aid Bandage)
--   hemostaticGauze   -> COMBAT_GAUZE     (Combat Gauze)
--   airwayEquipment   -> AIRWAY           (Airway Adjunct)
--   ivKits            -> FLUID_500        (IV Fluids 500ml)
--   blankets          -> THERMAL_BLANKET  (Thermal Blanket)
--   batteryPacks      -> (no existing row - not a medical consumable, added new below)
--
-- Unlike supply_request_items (left unpopulated in database/033, items_json used instead) or
-- inventory_ledger (v1.1, superseded by inventory_ledger_v12's item_type text column per
-- docs/ARCHITECTURE.md), kit templates are small and admin-curated rather than medic-typed
-- free text at the point of care - the mismatch is worth reconciling properly here instead of
-- routing around it a third time. client_item_key is the join key kit-template UI code uses to
-- resolve between normalizeSupplyItem()'s vocabulary and inventory_items.id, without duplicating
-- the 6 items that already exist under a different name.
--
-- Bigger finding than the naming mismatch itself, live-verified rather than assumed: the real
-- project's inventory_items table was empty (0 rows) before this migration.
-- 002_seed_demo_data_v1.2.sql's catalog insert (the 8 base items) was never actually applied to
-- this project - treatment_catalog shows the same pattern (1 live row vs 10 seeded), so this
-- looks like the live project only ever got a smaller, hand-curated seed, not 002's full fixture
-- set. Out of scope to backfill treatment_catalog/treatment_inventory_items here (unrelated to
-- kit templates), but inventory_items' base 8 rows are a real prerequisite for this feature to
-- reference anything, so they're seeded here rather than assumed present.

alter table inventory_items add column if not exists client_item_key text unique;

insert into inventory_items (sku, name, category, unit, is_life_saving, client_item_key)
values
  ('TQ', 'Tourniquet', 'hemorrhage', 'unit', true, 'tourniquets'),
  ('BANDAGE', 'First-aid Bandage', 'hemorrhage', 'unit', true, 'pressureDressings'),
  ('COMBAT_GAUZE', 'Combat Gauze', 'hemorrhage', 'unit', true, 'hemostaticGauze'),
  ('FLUID_500', 'IV Fluids 500ml', 'circulation', 'bag', true, 'ivKits'),
  ('MORPHINE', 'Morphine', 'medication', 'mg', true, null),
  ('ACTIQ', 'Actiq / Fentanyl', 'medication', 'unit', true, null),
  ('AIRWAY', 'Airway Adjunct', 'airway', 'unit', true, 'airwayEquipment'),
  ('THERMAL_BLANKET', 'Thermal Blanket', 'exposure', 'unit', false, 'blankets'),
  ('BATTERY_PACK', 'Battery Pack', 'equipment', 'unit', false, 'batteryPacks')
on conflict (sku) do update set client_item_key = excluded.client_item_key where inventory_items.client_item_key is null;
