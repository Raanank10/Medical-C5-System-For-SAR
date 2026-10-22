-- No draft incidents; command is informed when a medic opens one (decision D10, owner 2026-10-22,
-- docs/GAP_CLOSURE_PLAN.md WP-11 part 2 PR A, V2.99.48).
--
-- Until now a medic or paramedic opened a DRAFT (038) that command had to confirm, merge or
-- reject. D10 drops drafts: a medic opens an official incident directly, and their own PC, CC,
-- RPC and RCC are told about it with a banner each of them acknowledges. Duplicates are prevented
-- at opening (the phone lists open incidents of the medic's company first) and merged later if
-- they still happen (PR B). The opener may cancel their own incident as a false alarm while it
-- has no patients.
--
-- 1. open_incident(): medic/paramedic now open 'active'. The incident takes the opener's company
--    and, for rpc (and for medic/paramedic if the roster ever places them in a platoon, which 053
--    does not allow today), the opener's platoon. confirm_draft()/reject_draft()/acknowledge_draft() stay for history; with
--    no drafts they have nothing to act on (0 drafts existed live on 2026-10-22).
-- 2. join_incident(): a medic or paramedic may also join an open incident of their own company
--    (D10's "join this instead?"). Still no self-join into another company's incident.
-- 3. list_unit_open_incidents(): header fields of the open incidents of the caller's company
--    opened in the last 12 hours, for the warning before opening. No patient data.
-- 4. Who is informed (list_incident_open_alerts(), one row per incident a medic or paramedic
--    opened in the last 24 hours that the caller has not acknowledged):
--    - cc, chamal, admin: every one (they already see every incident; also the safety net for a
--      medic without a unit, flagged no_unit);
--    - pc, rcc: incidents of their own company;
--    - rpc: incidents of their own platoon.
--    A false-alarm cancellation stays listed (cancelled = true) until acknowledged.
--    acknowledge_incident_opened() stores the acknowledgment per person.
-- 5. set_incident_platoon(): the PC or RCC of the incident's company chooses its platoon. In 053
--    only an RPC is placed in a platoon (app.guard_profile_unit), so a medic's incident never
--    gets one at opening and the PC/RCC always chooses it; that platoon's RPC then sees it and is
--    informed. Found live 2026-10-22: it must set app.incident_unit_via_rpc, the guard's own
--    hook for server functions that check the caller themselves. Company-level
--    command keeps set_incident_unit() for everything else.
-- 6. cancel_incident_false_alarm(): only the opener, only while the incident is active and has no
--    patients. Closes it through the close guard (040) with the reason in metadata and an
--    INCIDENT_CLOSED event marked false_alarm. app.is_false_alarm_close() tells that close apart
--    from a later ordinary close after a reopen (reopen keeps the metadata as history): the
--    false-alarm close is the one whose closed_at equals false_alarm.at (applied live as
--    064c_false_alarm_close_marker, 2026-10-22).
--
-- Applied live 2026-10-22 as 064_no_drafts_incident_open_alerts, 064b_set_incident_platoon_rpc_flag
-- and 064c_false_alarm_close_marker; this file is the combined result.

create table if not exists incident_open_acknowledgments (
  incident_id uuid not null references incidents(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (incident_id, profile_id)
);
alter table incident_open_acknowledgments enable row level security;
drop policy if exists incident_open_acknowledgments_read_own on incident_open_acknowledgments;
create policy incident_open_acknowledgments_read_own on incident_open_acknowledgments for select to authenticated
using (profile_id = (select auth.uid()));
-- No insert/update/delete policy: acknowledge_incident_opened() (security definer) writes.

create or replace function open_incident(
  p_incident_id uuid,
  p_location_name text,
  p_address text default null,
  p_incident_type text default null,
  p_t_zero timestamptz default null,
  p_device_id text default null,
  p_local_event_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role := app.current_user_role();
  v_uid uuid := auth.uid();
  v_t_zero timestamptz := coalesce(p_t_zero, now());
  v_existing incidents;
  v_visual_id text;
  v_company uuid;
  v_platoon uuid;
begin
  if v_role is null then
    raise exception 'no active profile' using errcode = '42501';
  end if;
  if v_role not in ('medic','paramedic','pc','cc','chamal','admin','physician','rpc','rcc') then
    raise exception 'role % cannot open an incident', v_role using errcode = '42501';
  end if;
  if p_incident_id is null then
    raise exception 'p_incident_id is required (client-generated, for idempotent retry)' using errcode = '22023';
  end if;
  if coalesce(btrim(p_location_name), '') = '' then
    raise exception 'p_location_name is required' using errcode = '22023';
  end if;
  if v_t_zero > now() + interval '5 minutes' then
    raise exception 't_zero cannot be in the future' using errcode = '22023';
  end if;

  select * into v_existing from incidents where id = p_incident_id;
  if found then
    if v_uid in (v_existing.draft_created_by, v_existing.opened_by) then
      return jsonb_build_object('id', v_existing.id, 'visual_id', v_existing.visual_id,
                                'status', v_existing.status, 'created', false);
    end if;
    raise exception 'incident id % already exists', p_incident_id using errcode = '23505';
  end if;

  v_visual_id := 'INC-' || to_char(now() at time zone 'utc', 'YYMMDD') || '-' ||
                 upper(substr(replace(p_incident_id::text, '-', ''), 1, 6));
  -- database/053: a site opened by a unit member belongs to that member's unit. D10: a medic's
  -- incident also takes the medic's platoon when the roster sets one.
  if v_role in ('rpc','medic','paramedic') then
    v_platoon := app.my_platoon_id();
    v_company := app.my_company_id();
  elsif v_role in ('pc','rcc') then
    v_company := app.my_company_id();
  end if;

  insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, address,
                         incident_type, status, opened_by, opened_at, company_id, platoon_id)
  values (p_incident_id, v_visual_id, v_t_zero, v_t_zero, btrim(p_location_name),
          nullif(btrim(p_address), ''), nullif(btrim(p_incident_type), ''), 'active',
          v_uid, now(), v_company, v_platoon);

  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  values (p_incident_id, v_uid, v_role, v_uid)
  on conflict (incident_id, profile_id) do nothing;

  perform app.append_incident_lifecycle_event(
    p_incident_id, 'INCIDENT_OPENED'::event_type,
    jsonb_build_object('visual_id', v_visual_id, 'location_name', btrim(p_location_name),
                       'incident_type', p_incident_type, 't_zero', v_t_zero, 'status', 'active',
                       'opened_by_role', v_role, 'company_id', v_company, 'platoon_id', v_platoon),
    p_device_id, p_local_event_id);

  perform refresh_incident_command_state(p_incident_id);

  return jsonb_build_object('id', p_incident_id, 'visual_id', v_visual_id,
                            'status', 'active', 'created', true, 'company_id', v_company, 'platoon_id', v_platoon);
end;
$$;

create or replace function join_incident(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role := app.current_user_role();
  v_status incident_status;
  v_company uuid;
begin
  if v_role is null then
    raise exception 'no active profile' using errcode = '42501';
  end if;
  select status, company_id into v_status, v_company from incidents where id = p_incident_id;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_status not in ('draft','staging','active') then
    raise exception 'incident % is %, not open for joining', p_incident_id, v_status using errcode = '42501';
  end if;
  -- database/045, 053: no self-join into a site outside one's unit. D10: a medic or paramedic may
  -- join an open incident of their own company ("join this instead?" before opening a duplicate).
  if v_role in ('pc','rpc','rcc','medic','paramedic') and not app.can_access_incident(p_incident_id)
     and not (v_role in ('medic','paramedic') and v_company is not null and v_company = app.my_company_id()) then
    raise exception 'assignment required to join incident %', p_incident_id using errcode = '42501';
  end if;
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  values (p_incident_id, auth.uid(), v_role, auth.uid())
  on conflict (incident_id, profile_id) do nothing;
  return jsonb_build_object('id', p_incident_id, 'status', v_status, 'role_at_incident', v_role);
end;
$$;

create or replace function list_unit_open_incidents()
returns table (id uuid, visual_id text, location_name text, address text, incident_type text,
               opened_at timestamptz, opened_by_name text, patient_count bigint, is_member boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_company uuid := app.my_company_id();
begin
  if app.current_user_role() is null then
    raise exception 'no active profile' using errcode = '42501';
  end if;
  if v_company is null then
    return;
  end if;
  return query
  select i.id, i.visual_id, i.location_name, i.address, i.incident_type, i.opened_at,
         op.display_name,
         (select count(*) from patients p where p.incident_id = i.id),
         exists (select 1 from incident_memberships m where m.incident_id = i.id and m.profile_id = auth.uid())
  from incidents i
  left join profiles op on op.id = i.opened_by
  where i.status = 'active' and i.company_id = v_company
    and i.opened_at > now() - interval '12 hours'
  order by i.opened_at desc;
end;
$$;

-- A false-alarm cancel writes metadata.false_alarm.at = closed_at in the same statement. A reopen
-- (reopen_incident) keeps the metadata as history, so only a close at that same moment is the
-- false-alarm close; a later ordinary close is not.
create or replace function app.is_false_alarm_close(i incidents)
returns boolean
language sql
stable
set search_path = public
as $$
  select i.metadata ? 'false_alarm' and i.closed_at is not null
     and (i.metadata->'false_alarm'->>'at')::timestamptz = i.closed_at
$$;
revoke execute on function app.is_false_alarm_close(incidents) from public, anon, authenticated;

create or replace function list_incident_open_alerts()
returns table (id uuid, visual_id text, location_name text, address text, status incident_status,
               opened_at timestamptz, opened_by_name text, opened_by_role text, company_id uuid,
               platoon_id uuid, patient_count bigint, no_unit boolean, needs_platoon boolean,
               cancelled boolean, cancel_reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_role text := app.current_user_role()::text;
  v_company uuid := app.my_company_id();
  v_platoon uuid := app.my_platoon_id();
begin
  if v_role is null or v_role not in ('cc','chamal','admin','pc','rcc','rpc') then
    return;
  end if;
  return query
  select i.id, i.visual_id, i.location_name, i.address, i.status, i.opened_at,
         op.display_name, op.role::text, i.company_id, i.platoon_id,
         (select count(*) from patients p where p.incident_id = i.id),
         i.company_id is null,
         i.company_id is not null and i.platoon_id is null,
         i.status = 'closed' and app.is_false_alarm_close(i),
         i.metadata->'false_alarm'->>'reason'
  from incidents i
  join profiles op on op.id = i.opened_by
  where op.role in ('medic','paramedic')
    and i.opened_at > now() - interval '24 hours'
    and (i.status in ('active','staging') or (i.status = 'closed' and app.is_false_alarm_close(i)))
    and not exists (select 1 from incident_open_acknowledgments a where a.incident_id = i.id and a.profile_id = auth.uid())
    and (
      v_role in ('cc','chamal','admin')
      or (v_role in ('pc','rcc') and v_company is not null and i.company_id = v_company)
      or (v_role = 'rpc' and v_platoon is not null and i.platoon_id = v_platoon)
    )
  order by i.opened_at desc;
end;
$$;

create or replace function acknowledge_incident_opened(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := app.current_user_role()::text;
begin
  if v_role is null or v_role not in ('cc','chamal','admin','pc','rcc','rpc') then
    raise exception 'role % is not informed of opened incidents', v_role using errcode = '42501';
  end if;
  if not exists (select 1 from incidents where id = p_incident_id) then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if not (v_role in ('cc','chamal','admin') or app.can_access_incident(p_incident_id)) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  insert into incident_open_acknowledgments (incident_id, profile_id)
  values (p_incident_id, auth.uid())
  on conflict (incident_id, profile_id) do nothing;
  return jsonb_build_object('id', p_incident_id, 'acknowledged', true);
end;
$$;

create or replace function set_incident_platoon(p_incident_id uuid, p_platoon_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := app.current_user_role()::text;
  v_inc incidents;
begin
  select * into v_inc from incidents where id = p_incident_id;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if not (app.is_unit_manager()
          or (v_role in ('pc','rcc') and v_inc.company_id is not null and v_inc.company_id = app.my_company_id())) then
    raise exception 'only the PC or RCC of the incident''s company may choose its platoon' using errcode = '42501';
  end if;
  if p_platoon_id is not null and not exists (select 1 from platoons where id = p_platoon_id and company_id = v_inc.company_id and is_active) then
    raise exception 'platoon % is not an active platoon of the incident''s company', p_platoon_id using errcode = '22023';
  end if;
  -- The checks above replace app.guard_incident_unit()'s company-level rule for this one change;
  -- the guard still validates the platoon and writes the unit audit row.
  perform set_config('app.incident_unit_via_rpc', 'on', true);
  update incidents set platoon_id = p_platoon_id, updated_at = now(), version = version + 1
  where id = p_incident_id and platoon_id is distinct from p_platoon_id;
  perform set_config('app.incident_unit_via_rpc', '', true);
  return jsonb_build_object('incident_id', p_incident_id, 'platoon_id', p_platoon_id);
end;
$$;

create or replace function cancel_incident_false_alarm(
  p_incident_id uuid,
  p_reason text default null,
  p_device_id text default null,
  p_local_event_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inc incidents;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_inc.opened_by is distinct from auth.uid() then
    raise exception 'only the person who opened the incident can cancel it as a false alarm' using errcode = '42501';
  end if;
  if v_inc.status = 'closed' and app.is_false_alarm_close(v_inc) then
    return jsonb_build_object('id', p_incident_id, 'status', 'closed', 'changed', false);
  end if;
  if v_inc.status <> 'active' then
    raise exception 'incident % is %, not active', p_incident_id, v_inc.status using errcode = '42501';
  end if;
  if exists (select 1 from patients where incident_id = p_incident_id) then
    raise exception 'incident % has patients: it cannot be cancelled as a false alarm', p_incident_id using errcode = '42501';
  end if;

  perform set_config('app.incident_close_via_rpc', 'on', true);
  update incidents
  set status = 'closed', closed_by = auth.uid(), closed_at = now(),
      metadata = metadata || jsonb_build_object('false_alarm', jsonb_build_object('reason', v_reason, 'at', now(), 'by', auth.uid())),
      updated_at = now(), version = version + 1
  where id = p_incident_id;
  perform set_config('app.incident_close_via_rpc', '', true);

  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_CLOSED',
    jsonb_build_object('visual_id', v_inc.visual_id, 'false_alarm', true, 'reason', v_reason, 'open_patient_count', 0),
    p_device_id, p_local_event_id);
  return jsonb_build_object('id', p_incident_id, 'status', 'closed', 'changed', true);
end;
$$;

revoke execute on function list_unit_open_incidents() from public, anon;
revoke execute on function list_incident_open_alerts() from public, anon;
revoke execute on function acknowledge_incident_opened(uuid) from public, anon;
revoke execute on function set_incident_platoon(uuid, uuid) from public, anon;
revoke execute on function cancel_incident_false_alarm(uuid, text, text, text) from public, anon;
grant execute on function list_unit_open_incidents() to authenticated;
grant execute on function list_incident_open_alerts() to authenticated;
grant execute on function acknowledge_incident_opened(uuid) to authenticated;
grant execute on function set_incident_platoon(uuid, uuid) to authenticated;
grant execute on function cancel_incident_false_alarm(uuid, text, text, text) to authenticated;
