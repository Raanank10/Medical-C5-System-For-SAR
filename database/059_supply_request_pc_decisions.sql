-- PC resupply decisions shared across devices (WP-6, docs/GAP_CLOSURE_PLAN.md, V2.99.43).
--
-- Until now the PC's decision on a medic's resupply request (approve from the PC truck, or
-- escalate because the truck does not have it) stayed on the PC's phone: the client never sent
-- RESUPPLY_APPROVED_FROM_PC_TRUCK / PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED /
-- RESUPPLY_ESCALATED_TO_CC, because 033 matched them by the creating device's id and from the
-- PC's device they could never find the medic's request. 034 already resolves an update by the
-- real payload_json.supply_request_id first, and V2.99.43 sends that id from the PC's board, so
-- the lookup itself needs no change. Two things do, before these events start reaching the
-- server:
--
-- 1. Who may decide. sync-log lets every role with SUPPLY_LOGISTICS_EVENTS send these types
--    (pc, cc, physician, logistics_officer, admin), and the client's own request list lets the
--    requester press the same status buttons. The decision belongs to command: only pc, cc and
--    admin (read from profiles by actor_id, never from events.actor_role) change the row. Any
--    other sender's event is still stored in events as the audit record; it just changes nothing.
--    SUPPLY_REQUEST_DISPATCHED / IN_TRANSIT / RECEIVED keep 034's behavior (no role check) - the
--    PC marks a truck delivery received with the same event, and logistics dispatches.
--
-- 2. Never raise. A trigger that raises rolls back the event insert. 034 cast
--    payload_json->>'supply_request_id' to uuid and payload_json->>'eta_minutes' to int with no
--    guard, so one malformed payload failed the whole event. Both lookups and every update are
--    now wrapped in exception handlers that leave the row unchanged.
--
-- Everything else is 034 unchanged: creation by (device, client id), approve only from
-- 'requested', escalate only from request_level 'medic_to_pc', dispatch / in transit / received.

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
      update supply_requests
      set status = 'delivered', delivered_at = new.local_timestamp, updated_at = now(), version = version + 1
      where id = req_id and incident_id = new.incident_id and status <> 'cancelled';
    end if;
  exception when others then
    null; -- e.g. a non-numeric eta_minutes: row unchanged, event still stored
  end;

  return new;
end;
$$;

revoke execute on function project_supply_request_event() from public, anon, authenticated;
