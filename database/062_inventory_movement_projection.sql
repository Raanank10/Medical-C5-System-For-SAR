-- Inventory on the server, part 2 of 2 (WP-9, docs/GAP_CLOSURE_PLAN.md, V2.99.46).
--
-- Every stock change on a phone is written as INVENTORY_LEDGER_MOVEMENT (consumeFieldSupply,
-- receiveLogisticsSupply, and since V2.99.46 the PC truck's issue on an approved resupply). A
-- consumption is also written as SUPPLY_CONSUMED, with the same numbers, for the patient timeline
-- and the audit log. Only INVENTORY_LEDGER_MOVEMENT is projected, so nothing is counted twice.
--
-- project_inventory_movement(), AFTER INSERT on events, SECURITY DEFINER, never raises:
-- - item_type must be one of the client's item keys; quantity_delta a non-zero integer within
--   +/-500; an unknown movement_type is ignored.
-- - stock_owner: 'pc_truck' when the payload names the PC truck (destination_node / source_node),
--   else 'medic_bag'. Who may write which (role read from profiles, never from events.actor_role):
--   a medic bag: medic, paramedic, pc, physician, admin (whoever treats in the field); a PC truck:
--   pc, cc, logistics_officer, admin. Any other sender's event stays in events and changes nothing.
-- - patient_id is kept only when it is a real patient (the payload may carry a client-side id).
-- - one row per (device_id, local_event_id): a resent event is not counted twice.
--
-- The direct insert policy on inventory_ledger_v12 is closed (with check (false)): the client never
-- wrote the table directly, and now the trigger is the only writer, so a client cannot forge stock
-- rows. Altered rather than dropped, so the policy's history stays visible.
--
-- trg_process_logistics_event_safety_v12() used to sum the whole incident's deltas and raise
-- INVENTORY_NEGATIVE_STOCK_USED below zero. With deltas only (the starting stock is on the phone),
-- that sum goes negative on the first use, so it would alert on every treatment. It now alerts when
-- one holder's own count after the movement is below zero (an item used that the bag did not have),
-- and the alert can never block the ledger row.

alter policy inventory_ledger_v12_write on inventory_ledger_v12 with check (false);

create or replace function trg_process_logistics_event_safety_v12()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.stock_after is not null and new.stock_after < 0 and new.quantity_delta < 0 then
    begin
      insert into watchdog_alerts (incident_id, patient_id, actor_id, alert_type, severity, message, payload_json)
      values (
        new.incident_id, new.patient_id, new.actor_id, 'INVENTORY_NEGATIVE_STOCK_USED', 'warning',
        'פריט באפס מלאי נמצא בשימוש בשטח. נדרש דחף אספקה מיידי.',
        jsonb_build_object('item_type', new.item_type, 'stock_owner', new.stock_owner, 'stock_after', new.stock_after,
                           'medic_id', new.actor_id, 'device_id', new.device_id)
      );
    exception when others then
      null; -- the ledger row matters more than its alert
    end;
  end if;
  return new;
end;
$$;
revoke execute on function trg_process_logistics_event_safety_v12() from public, anon, authenticated;

create or replace function project_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p jsonb := new.payload_json;
  v_item text;
  v_delta integer;
  v_after integer;
  v_owner text;
  v_movement logistics_movement_type;
  v_role text;
  v_patient uuid;
begin
  if new.type <> 'INVENTORY_LEDGER_MOVEMENT' or new.incident_id is null then
    return new;
  end if;

  begin
    v_item := p->>'item_type';
    if v_item is null or v_item not in ('tourniquets','pressureDressings','hemostaticGauze','airwayEquipment','ivKits','blankets','batteryPacks') then
      return new;
    end if;
    v_delta := (p->>'quantity_delta')::integer;
    if v_delta is null or v_delta = 0 or abs(v_delta) > 500 then
      return new;
    end if;

    v_owner := case when p->>'destination_node' = 'pc_truck' or p->>'source_node' = 'pc_truck' then 'pc_truck' else 'medic_bag' end;
    begin
      v_after := coalesce(p->>'local_stock_after', p->>'pc_truck_stock_after')::integer;
    exception when others then
      v_after := null;
    end;

    v_movement := case p->>'movement_type'
      when 'treatment_consumed' then 'treatment_consumed'
      when 'correction_reversed' then 'correction'
      when 'quantity_corrected' then 'correction'
      when 'logistics_manual_received' then 'resupply_received'
      when 'resupply_received' then 'resupply_received'
      when 'pc_truck_issued' then 'pc_truck_issued'
      else null end;
    if v_movement is null then
      return new;
    end if;

    select pr.role::text into v_role from profiles pr where pr.id = new.actor_id;
    if v_role is null
       or (v_owner = 'medic_bag' and v_role not in ('medic','paramedic','pc','physician','admin'))
       or (v_owner = 'pc_truck' and v_role not in ('pc','cc','logistics_officer','admin')) then
      return new; -- kept in events as the audit record, no ledger row
    end if;

    begin
      select pt.id into v_patient from patients pt where pt.id = nullif(coalesce(p->>'patient_id', p->>'patient_context'), '')::uuid;
    exception when others then
      v_patient := null;
    end;

    insert into inventory_ledger_v12 (incident_id, actor_id, item_type, movement_type, quantity_delta, device_id,
                                      local_event_id, patient_id, payload_json, stock_owner, stock_after, occurred_at)
    values (new.incident_id, new.actor_id, v_item, v_movement, v_delta, new.device_id,
            new.local_event_id, v_patient, p, v_owner, v_after, new.local_timestamp)
    on conflict (device_id, local_event_id) do nothing;
  exception when others then
    null; -- never fail the event insert over the projection
  end;
  return new;
end;
$$;
revoke execute on function project_inventory_movement() from public, anon, authenticated;

drop trigger if exists trg_project_inventory_movement on events;
create trigger trg_project_inventory_movement
after insert on events
for each row execute function project_inventory_movement();
