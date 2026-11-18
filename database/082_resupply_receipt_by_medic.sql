-- A resupply delivered to a medic raises the bag (WP-38, docs/GAP_CLOSURE_PLAN.md, V2.99.74).
-- Apply after 059 and 068, together with sync-log v18 (medic / paramedic may send
-- SUPPLY_REQUEST_RECEIVED). Client only reads the new columns; nothing raises.
--
-- Owner, 2026-11-18: the bag goes up only when the medic confirms receipt on their own phone (the
-- items are in their hands only then), by what arrived, not by what was asked. Until then the
-- PC's or logistics' "delivered" means handed over, waiting for the medic. The bag itself is on the
-- phone; its increase reaches the server as INVENTORY_LEDGER_MOVEMENT resupply_received into the
-- medic's bag (database/062, unchanged, no patient). This file records the receipt on the request:
--
-- 1. supply_requests.received_at / received_by / received_items_json: the requester's own
--    confirmation and what arrived ([{item, quantity}], partial allowed).
-- 2. project_supply_request_event(): 059's body, except SUPPLY_REQUEST_RECEIVED:
--    - from the requester: status 'delivered' (first delivery time kept) and the receipt columns,
--      first receipt wins;
--    - from a medic / paramedic who is not the requester: row unchanged (the event stays in events);
--    - from anyone else (pc, cc, logistics_officer, physician, admin): status 'delivered' only, as
--      before. Role read from profiles by actor_id, never from events.actor_role.
-- 3. Rows already delivered before this file get received_at = delivered_at, so they are not
--    shown as waiting for a medic who used the old flow (received_by stays null: no confirmation
--    was ever asked). get_supply_request_queue() returns `select *` (068), so it carries the new
--    columns with no change.

alter table supply_requests add column if not exists received_at timestamptz;
alter table supply_requests add column if not exists received_by uuid references profiles(id);
alter table supply_requests add column if not exists received_items_json jsonb;

update supply_requests set received_at = delivered_at
where status = 'delivered' and received_at is null and delivered_at is not null;

create or replace function project_supply_request_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  req_id uuid;
  origin_client_id text;
  actor_role text;
  is_requester boolean;
begin
  if new.type not in (
    'SUPPLY_REQUEST_CREATED', 'RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE', 'RESUPPLY_REQUEST_ESCALATED_CC',
    'RESUPPLY_APPROVED_FROM_PC_TRUCK', 'PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED', 'RESUPPLY_ESCALATED_TO_CC',
    'SUPPLY_REQUEST_DISPATCHED', 'SUPPLY_REQUEST_IN_TRANSIT', 'SUPPLY_REQUEST_RECEIVED'
  ) then
    return new;
  end if;

  if new.incident_id is null then
    return new;
  end if;

  if new.type in ('SUPPLY_REQUEST_CREATED', 'RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE', 'RESUPPLY_REQUEST_ESCALATED_CC') then
    origin_client_id := coalesce(new.payload_json->>'id', new.payload_json->>'request_id');
    if origin_client_id is null then
      return new; -- malformed/incomplete payload - nothing to project
    end if;
    begin
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
      on conflict (origin_device_id, origin_client_request_id)
      where origin_device_id is not null and origin_client_request_id is not null
      do nothing;
    exception when others then
      null; -- never fail the event insert over the projection
    end;
    return new;
  end if;

  -- PC decisions: command roles only.
  if new.type in ('RESUPPLY_APPROVED_FROM_PC_TRUCK', 'PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED', 'RESUPPLY_ESCALATED_TO_CC') then
    select p.role::text into actor_role from profiles p where p.id = new.actor_id;
    if actor_role is null or actor_role not in ('pc', 'cc', 'admin') then
      return new; -- kept in events as the audit record, row unchanged
    end if;
  end if;

  -- Prefer the real server id (cross-device safe); fall back to the device-scoped client-local
  -- id lookup only when the event doesn't carry one.
  begin
    if new.payload_json ? 'supply_request_id' then
      req_id := nullif(new.payload_json->>'supply_request_id', '')::uuid;
    end if;
  exception when others then
    req_id := null; -- not a uuid: fall through to the client-id lookup
  end;

  if req_id is null then
    origin_client_id := coalesce(new.payload_json->>'id', new.payload_json->>'request_id');
    if origin_client_id is null then
      return new;
    end if;
    select id into req_id from supply_requests
    where origin_device_id = new.device_id and origin_client_request_id = origin_client_id;
  end if;

  if req_id is null then
    return new; -- no matching request found (out of order, or not yet projected); nothing to update
  end if;

  begin
    if new.type = 'RESUPPLY_APPROVED_FROM_PC_TRUCK' then
      update supply_requests
      set status = 'approved', approved_by_pc = new.actor_id, updated_at = now(), version = version + 1
      where id = req_id and incident_id = new.incident_id and status = 'requested';

    elsif new.type in ('PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED', 'RESUPPLY_ESCALATED_TO_CC') then
      update supply_requests
      set request_level = 'pc_to_logo', updated_at = now(), version = version + 1
      where id = req_id and incident_id = new.incident_id and request_level = 'medic_to_pc';

    elsif new.type = 'SUPPLY_REQUEST_DISPATCHED' then
      update supply_requests
      set status = 'dispatched',
          logistics_officer_id = new.actor_id,
          assigned_runner_name = coalesce(new.payload_json->>'runner_name', assigned_runner_name),
          eta_minutes = coalesce((new.payload_json->>'eta_minutes')::int, eta_minutes),
          dispatched_at = new.local_timestamp,
          updated_at = now(), version = version + 1
      where id = req_id and incident_id = new.incident_id and status in ('requested', 'approved');

    elsif new.type = 'SUPPLY_REQUEST_IN_TRANSIT' then
      update supply_requests
      set status = 'in_transit', in_transit_at = new.local_timestamp, updated_at = now(), version = version + 1
      where id = req_id and incident_id = new.incident_id and status in ('requested', 'approved', 'dispatched');

    elsif new.type = 'SUPPLY_REQUEST_RECEIVED' then
      -- WP-38: the requester's own receipt records what arrived (first one wins); a medic or
      -- paramedic marking someone else's request changes nothing; anyone else (PC, CC, logistics,
      -- admin) marks it handed over only. The first delivery time is kept.
      select p.role::text into actor_role from profiles p where p.id = new.actor_id;
      select (r.requester_id = new.actor_id) into is_requester from supply_requests r where r.id = req_id;
      if actor_role is null or (actor_role in ('medic', 'paramedic') and not coalesce(is_requester, false)) then
        return new; -- kept in events as the audit record, row unchanged
      end if;
      update supply_requests
      set status = 'delivered', delivered_at = coalesce(delivered_at, new.local_timestamp), updated_at = now(), version = version + 1
      where id = req_id and incident_id = new.incident_id and status <> 'cancelled';
      if coalesce(is_requester, false) then
        update supply_requests
        set received_at = new.local_timestamp,
            received_by = new.actor_id,
            received_items_json = case when jsonb_typeof(new.payload_json->'received_items') = 'array' then new.payload_json->'received_items' else null end
        where id = req_id and incident_id = new.incident_id and status = 'delivered' and received_at is null;
      end if;
    end if;
  exception when others then
    null; -- e.g. a non-numeric eta_minutes: row unchanged, event still stored
  end;

  return new;
end;
$$;

revoke execute on function project_supply_request_event() from public, anon, authenticated;
