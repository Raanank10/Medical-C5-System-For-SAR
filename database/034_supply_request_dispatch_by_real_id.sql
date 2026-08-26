-- Real bug found while building PR3 (logistics dispatch/runner-assign actions), not caught by
-- 033's own live-verification: project_supply_request_event()'s update path resolves the target
-- row via (new.device_id, origin_client_request_id) - i.e. it assumes the status-update event
-- comes from the SAME device that created the request. That was true for every case 033 was
-- actually tested against (RESUPPLY_APPROVED_FROM_PC_TRUCK etc., still emitted from whichever
-- device holds the local reinforcementRequests copy today), and the live test in 033 happened to
-- push every step from one test device, which papered over exactly this gap.
--
-- It is NOT true for the case this whole feature exists to solve: a logistics officer, on their
-- own device, dispatching a request a medic created on theirs. new.device_id there is the
-- logistics device, never a match for origin_device_id (the medic's device) - the update would
-- silently no-op, dispatch/in-transit/delivered actions would never actually update the row.
--
-- Fix: once a client has pulled a row back via get_supply_request_queue(), it has the real
-- server-side supply_requests.id - SUPPLY_REQUEST_DISPATCHED/IN_TRANSIT/RECEIVED now carry that
-- in payload_json.supply_request_id and resolve by it directly, which works regardless of which
-- device sends the update. The device-scoped (device_id, client-local id) lookup remains as a
-- fallback for the update events that still only carry a client-local id (today's
-- RESUPPLY_APPROVED_FROM_PC_TRUCK/escalation flow, unchanged by this fix).

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

  if new.incident_id is null then
    return new;
  end if;

  if new.type in ('SUPPLY_REQUEST_CREATED', 'RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE', 'RESUPPLY_REQUEST_ESCALATED_CC') then
    origin_client_id := coalesce(new.payload_json->>'id', new.payload_json->>'request_id');
    if origin_client_id is null then
      return new; -- malformed/incomplete payload - nothing to project
    end if;
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
    return new;
  end if;

  -- Prefer the real server id (cross-device safe); fall back to the device-scoped client-local
  -- id lookup only when the event doesn't carry one (today's approve/escalate flow).
  if new.payload_json ? 'supply_request_id' then
    req_id := nullif(new.payload_json->>'supply_request_id', '')::uuid;
  end if;

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

revoke execute on function project_supply_request_event() from public, anon, authenticated;
