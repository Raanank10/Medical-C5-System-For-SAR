-- Command cancels a resupply request, shared across devices (WP-24, docs/GAP_CLOSURE_PLAN.md,
-- repo owner 2026-11-18). Needs 083 (the enum value) and 082 (WP-38, the receipt columns) applied first.
--
-- Why. The CC board's "אשר השלמה פלוגתית" and "סגור" only changed the CC's own phone. The owner
-- confirmed (2026-11-18) that the CC holds no stock of its own: stock is the PC truck and the
-- logistics officer. So a CC "fulfilled" status would be a second way to reach "delivered" with no
-- stock behind it; delivery stays with the PC (truck) and logistics (dispatch / received). What
-- command does need is to call off a request nobody should fill any more. That is this file.
--
-- 1. supply_requests gains cancelled_at, cancelled_by, cancel_reason (a code) and cancel_note.
--
-- 2. project_supply_request_event(): 082's body (WP-38, the live definition, checked equal on
--    2026-11-18; its medic receipt is unchanged) plus SUPPLY_REQUEST_CANCELLED, resolved by payload_json.supply_request_id only (a cancel is
--    always sent from a pulled row). Who may cancel, read from profiles by actor_id, never from
--    events.actor_role:
--    - cc, chamal, admin: any open request: 'requested', 'dispatched' or 'in_transit'.
--    - pc: only while the request is still at its level ('medic_to_pc') and 'requested'.
--    Never 'approved' (the PC truck has already issued the items; the PC marks it delivered),
--    never 'delivered' or 'cancelled'. A reason from the list is required, and a note with
--    'other'. Anything else leaves the row unchanged; the event stays in events as the audit
--    record. Like 059, it never raises: a failed projection must not roll back the event insert.
--    Once cancelled, nothing moves the row again: approve needs 'requested', dispatch
--    'requested'/'approved', in transit 'requested'/'approved'/'dispatched', and received already
--    skips 'cancelled'. Escalation now also needs an open status, so a cancelled request is not
--    sent up to logistics later by a late push.
--
-- 3. Direct client writes closed. supply_requests_insert / _update / _delete let a medic, pc,
--    paramedic, logistics officer or admin write any row of their incident straight through the
--    REST API, around every rule above and in 059. Nothing in the client, the Edge Functions or
--    the scripts writes the table directly (checked 2026-11-18): rows are written only by this
--    SECURITY DEFINER trigger. Same step WP-9 took for the inventory ledger. Read is unchanged.
--
-- Tested on a local PostgreSQL 16 with stand-in tables (docs/ARCHITECTURE.md).

alter table supply_requests add column if not exists cancelled_at timestamptz;
alter table supply_requests add column if not exists cancelled_by uuid references profiles(id);
alter table supply_requests add column if not exists cancel_reason text;
alter table supply_requests add column if not exists cancel_note text;

alter table supply_requests drop constraint if exists chk_supply_cancel_reason;
alter table supply_requests add constraint chk_supply_cancel_reason check (
  cancel_reason is null or cancel_reason in ('not_needed', 'duplicate', 'supplied_otherwise', 'other')
);

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
  v_reason text;
  v_note text;
begin
  if new.type not in (
    'SUPPLY_REQUEST_CREATED', 'RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE', 'RESUPPLY_REQUEST_ESCALATED_CC',
    'RESUPPLY_APPROVED_FROM_PC_TRUCK', 'PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED', 'RESUPPLY_ESCALATED_TO_CC',
    'SUPPLY_REQUEST_DISPATCHED', 'SUPPLY_REQUEST_IN_TRANSIT', 'SUPPLY_REQUEST_RECEIVED',
    'SUPPLY_REQUEST_CANCELLED'
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

  -- PC decisions and cancellation (WP-24): command roles only.
  if new.type in ('RESUPPLY_APPROVED_FROM_PC_TRUCK', 'PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED', 'RESUPPLY_ESCALATED_TO_CC', 'SUPPLY_REQUEST_CANCELLED') then
    select p.role::text into actor_role from profiles p where p.id = new.actor_id;
    if actor_role is null then
      return new;
    end if;
    if new.type = 'SUPPLY_REQUEST_CANCELLED' then
      if actor_role not in ('pc', 'cc', 'chamal', 'admin') then
        return new; -- kept in events as the audit record, row unchanged
      end if;
    elsif actor_role not in ('pc', 'cc', 'admin') then
      return new; -- kept in events as the audit record, row unchanged
    end if;
  end if;

  -- Prefer the real server id (cross-device safe); fall back to the device-scoped client-local
  -- id lookup only when the event doesn't carry one. A cancel has no fallback.
  begin
    if new.payload_json ? 'supply_request_id' then
      req_id := nullif(new.payload_json->>'supply_request_id', '')::uuid;
    end if;
  exception when others then
    req_id := null; -- not a uuid: fall through to the client-id lookup
  end;

  if req_id is null then
    if new.type = 'SUPPLY_REQUEST_CANCELLED' then
      return new;
    end if;
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
      where id = req_id and incident_id = new.incident_id and request_level = 'medic_to_pc'
        and status not in ('delivered', 'cancelled');

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

    elsif new.type = 'SUPPLY_REQUEST_CANCELLED' then
      -- WP-24: a reason from the list, a note with 'other'; cc / chamal / admin while open, pc only
      -- while it waits at its own level; never approved (the truck issued it), delivered or cancelled.
      v_reason := new.payload_json->>'reason';
      v_note := nullif(btrim(coalesce(new.payload_json->>'note', '')), '');
      if v_reason is null or v_reason not in ('not_needed', 'duplicate', 'supplied_otherwise', 'other')
         or (v_reason = 'other' and v_note is null) then
        return new; -- no valid reason: row unchanged, event kept
      end if;
      update supply_requests
      set status = 'cancelled',
          cancelled_at = new.local_timestamp,
          cancelled_by = new.actor_id,
          cancel_reason = v_reason,
          cancel_note = left(v_note, 500),
          updated_at = now(), version = version + 1
      where id = req_id and incident_id = new.incident_id
        and (
          (actor_role in ('cc', 'chamal', 'admin') and status in ('requested', 'dispatched', 'in_transit'))
          or (actor_role = 'pc' and status = 'requested' and request_level = 'medic_to_pc')
        );
    end if;
  exception when others then
    null; -- e.g. a non-numeric eta_minutes: row unchanged, event still stored
  end;

  return new;
end;
$$;

revoke execute on function project_supply_request_event() from public, anon, authenticated;

-- 3. Direct client writes closed (rows come only from the trigger above).
drop policy if exists supply_requests_insert on supply_requests;
drop policy if exists supply_requests_update on supply_requests;
drop policy if exists supply_requests_delete on supply_requests;
revoke insert, update, delete on supply_requests from anon, authenticated;
