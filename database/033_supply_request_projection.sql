-- Real cross-device resupply queue + dispatch/runner flow (docs/C5_SENTINEL_SAR_MVP_SPEC_v1.2.md
-- section 5.6 "Logistics Hub": supply request queue, dispatch to Log-O, runner ETA, delivered
-- confirmation). supply_requests/supply_request_items (001) already model this - status enum,
-- request_level tiers (medic_to_pc/pc_to_logo/logo_direct_to_medic), dispatched_at/in_transit_at/
-- delivered_at, eta_minutes - but nothing ever wrote to them: the client runs its own local-only
-- `reinforcementRequests` array, and pulled sync events are explicitly never projected back into
-- it (comment at index.html's AAR timeline: "Server-pulled events ... doesn't project into
-- patients[]" - the same is true for resupply requests). A logistics officer on a different
-- device from the requesting medic cannot see the request at all today.
--
-- This migration follows the same two-piece pattern already proven for patients: a
-- SECURITY DEFINER trigger on events (project_patient_state(), 013) does the writing, and a
-- SECURITY DEFINER RPC (get_incident_command_state(), 014) does the reading. Same two pieces,
-- here.
--
-- Item catalog mismatch (found while writing this, not assumed away): supply_request_items
-- normalizes to inventory_items.id, but inventory_items.sku ('TQ','BANDAGE','COMBAT_GAUZE',...)
-- and the client's real item keys ('tourniquets','pressureDressings','ivKits',
-- 'airwayEquipment','blankets','batteryPacks','other',...) are two different, unrelated
-- vocabularies - inventory_ledger_v12 exists specifically because the same mismatch already
-- broke the FK-normalized inventory_ledger for this client. Rather than silently auto-creating
-- inventory_items rows for whatever string a medic happens to type (a real catalog-integrity
-- decision, not a schema-plumbing one), this migration adds a plain items_json column on
-- supply_requests carrying the client's real {item, quantity} pairs, and deliberately does NOT
-- populate supply_request_items. Reconciling the two vocabularies (either migrate client item
-- keys to real skus, or extend inventory_items with them) is a follow-up decision, not made here.

alter table supply_requests add column if not exists origin_device_id text;
alter table supply_requests add column if not exists origin_client_request_id text;
alter table supply_requests add column if not exists items_json jsonb not null default '[]'::jsonb;
alter table supply_requests add column if not exists assigned_runner_name text;

-- Composite idempotency key for client-originated requests, mirroring events' own
-- (device_id, local_event_id) uniqueness: the client's local request id (e.g. 'REQ-SUP-001')
-- is only unique per-device, not globally, so it's paired with origin_device_id here.
create unique index if not exists idx_supply_requests_origin
on supply_requests(origin_device_id, origin_client_request_id)
where origin_device_id is not null and origin_client_request_id is not null;

create or replace function project_supply_request_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  req_id uuid;
  origin_client_id text;
begin
  if new.type not in (
    'SUPPLY_REQUEST_CREATED', 'RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE', 'RESUPPLY_REQUEST_ESCALATED_CC',
    'RESUPPLY_APPROVED_FROM_PC_TRUCK', 'PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED', 'RESUPPLY_ESCALATED_TO_CC',
    'SUPPLY_REQUEST_DISPATCHED', 'SUPPLY_REQUEST_IN_TRANSIT', 'SUPPLY_REQUEST_RECEIVED'
  ) then
    return new;
  end if;

  -- Creation events carry the client's full local request object (payload_json.id); the one
  -- status-update event that doesn't (RESUPPLY_APPROVED_FROM_PC_TRUCK) carries payload_json.request_id
  -- instead - see submitMedicResupplyRequest()/updateResupplyStatus() in index.html.
  origin_client_id := coalesce(new.payload_json->>'id', new.payload_json->>'request_id');
  if origin_client_id is null or new.incident_id is null then
    return new; -- malformed/incomplete payload - nothing to project
  end if;

  if new.type in ('SUPPLY_REQUEST_CREATED', 'RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE', 'RESUPPLY_REQUEST_ESCALATED_CC') then
    insert into supply_requests (
      incident_id, requester_id, status, request_level,
      delivery_location_json, items_json, notes,
      origin_device_id, origin_client_request_id, requested_at
    )
    values (
      new.incident_id, new.actor_id, 'requested', 'medic_to_pc',
      coalesce(new.payload_json->'targetLocation', '{}'::jsonb),
      coalesce(new.payload_json->'items', '[]'::jsonb),
      new.payload_json->>'freeText',
      new.device_id, origin_client_id, new.local_timestamp
    )
    on conflict (origin_device_id, origin_client_request_id) do nothing;
    return new;
  end if;

  select id into req_id from supply_requests
  where origin_device_id = new.device_id and origin_client_request_id = origin_client_id;

  if req_id is null then
    return new; -- creation event not seen yet (arrived out of order) or never projected; nothing to update
  end if;

  if new.type = 'RESUPPLY_APPROVED_FROM_PC_TRUCK' then
    update supply_requests
    set status = 'approved', approved_by_pc = new.actor_id, updated_at = now(), version = version + 1
    where id = req_id and status = 'requested';

  elsif new.type in ('PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED', 'RESUPPLY_ESCALATED_TO_CC') then
    update supply_requests
    set request_level = 'pc_to_logo', updated_at = now(), version = version + 1
    where id = req_id and request_level = 'medic_to_pc';

  elsif new.type = 'SUPPLY_REQUEST_DISPATCHED' then
    update supply_requests
    set status = 'dispatched',
        logistics_officer_id = new.actor_id,
        assigned_runner_name = coalesce(new.payload_json->>'runner_name', assigned_runner_name),
        eta_minutes = coalesce((new.payload_json->>'eta_minutes')::int, eta_minutes),
        dispatched_at = new.local_timestamp,
        updated_at = now(), version = version + 1
    where id = req_id and status in ('requested', 'approved');

  elsif new.type = 'SUPPLY_REQUEST_IN_TRANSIT' then
    update supply_requests
    set status = 'in_transit', in_transit_at = new.local_timestamp, updated_at = now(), version = version + 1
    where id = req_id and status in ('requested', 'approved', 'dispatched');

  elsif new.type = 'SUPPLY_REQUEST_RECEIVED' then
    update supply_requests
    set status = 'delivered', delivered_at = new.local_timestamp, updated_at = now(), version = version + 1
    where id = req_id and status <> 'cancelled';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_project_supply_request_event on events;
create trigger trg_project_supply_request_event
after insert on events
for each row execute function project_supply_request_event();

-- Read side: same access-check/grant pattern as get_incident_command_state() (014). Plural
-- result (a queue, not one snapshot row), so plpgsql + RETURN QUERY rather than 014's plain SQL
-- function, so the access check can raise before any row is considered.
create or replace function get_supply_request_queue(p_incident_id uuid)
returns setof supply_requests
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not app.can_access_incident(p_incident_id) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  return query
    select * from supply_requests
    where incident_id = p_incident_id
    order by requested_at desc;
end;
$$;

revoke execute on function get_supply_request_queue(uuid) from public;
revoke execute on function get_supply_request_queue(uuid) from anon;
grant execute on function get_supply_request_queue(uuid) to authenticated;
