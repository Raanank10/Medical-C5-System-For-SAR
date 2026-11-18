-- WP-25 (V2.99.82, docs/GAP_CLOSURE_PLAN.md): several incident types per incident, who may add
-- and remove each one enforced on the server, and a medic's disagreement reaching PC, CC and rescue.
--
-- Owner decisions 2026-11-18:
-- - An incident may have several types (a suicide bomber can open fire and then explode). No main
--   type: all equal, in the order added. incidents.incident_type keeps the first one, for the
--   stored report (068), analytics and phones not yet updated.
-- - Anyone on the ladder adds a type (new information from the field).
-- - Removing follows the ladder against whoever added that type: rescue (rpc/rcc, admin) >
--   command (pc/cc, chamal) > medical (medic/paramedic/physician). Command removes a type added
--   by command or medical, never by rescue. A medic removes only a type they added themselves.
-- - A medic who wants to remove a type they may not is a report on the PC/CC/rescue boards;
--   PC, CC, RPC, RCC or admin close it: "keep", or remove the type when their level allows.
--
-- Who added each type: incidents.metadata.incident_types_set_by {type: {role, profile_id, by_label,
-- at}}, written only by the server with the profile's own name (client values are ignored).
-- metadata.incident_type_set_by mirrors the first type's stamp for older readers.
-- metadata.incident_types_removed {type: {role, profile_id, by_label, at}} keeps the last removal of
-- each type, so a late offline re-add from before it does not undo it.
-- A type given when the incident was opened (open_incident, 064) is stamped with incidents.opened_by.
--
-- 1. incident_type_role_tier(role), incident_type_may_remove(incident, type, actor, role).
-- 2. guard_incident_types() (before insert or update on incidents): validates the list, keeps
--    incident_type = the first type, applies the ladder to direct client writes (rescue panel,
--    PC/CC type buttons) and owns the stamps. A client that still writes only incident_type (older
--    phone) adds that type. Internal writes (3, 5) set app.incident_type_internal and stamp themselves.
-- 3. project_incident_type_event() (after insert on events), medical roles only (role from
--    profiles): add -> added (unless removed after the event's time); remove -> removed when the
--    ladder allows, else a report. Never raises.
-- 4. reconcile_incident_type_reports() (after update on incidents): a removed type closes its
--    open reports as matched.
-- 5. resolve_incident_type_report(id, 'keep'|'accept'): accept removes the disputed type.
-- 6. change_incident_type(incident, type, 'add'|'remove'): what the rescue panel and the PC/CC type
--    buttons call. One change applied to the list as it is on the server, so a phone's stale copy
--    never drops a type someone else added meanwhile. Goes through guard_incident_types().

-- ---------------------------------------------------------------------------------------------
-- Columns and table
-- ---------------------------------------------------------------------------------------------
create or replace function public.incident_types_valid(p_types text[])
returns boolean
language sql
immutable
as $$
  select p_types is not null
     and p_types <@ array['missile_strike_structural_collapse','mass_shooting','vehicle_accident','explosion']::text[]
     and cardinality(p_types) = (select count(distinct t) from unnest(p_types) t)
$$;

alter table incidents add column if not exists incident_types text[] not null default '{}';
update incidents set incident_types = array[incident_type]
where incident_type is not null and incident_types = '{}'
  and incident_type in ('missile_strike_structural_collapse','mass_shooting','vehicle_accident','explosion');
alter table incidents drop constraint if exists incidents_incident_types_valid;
alter table incidents add constraint incidents_incident_types_valid check (incident_types_valid(incident_types));

create table if not exists incident_type_reports (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  source_event_id uuid,
  reported_by uuid references profiles(id),
  reported_by_role text,
  reported_by_name text,
  -- the type the medic says should not be on the incident
  reported_type text not null check (reported_type in ('missile_strike_structural_collapse','mass_shooting','vehicle_accident','explosion')),
  types_at_report text[] not null default '{}',
  reported_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by uuid references profiles(id),
  resolved_by_role text,
  resolved_by_name text,
  resolution text check (resolution in ('accepted','kept_current','matched','superseded')),
  created_at timestamptz not null default now(),
  check ((resolved_at is null) = (resolution is null))
);

create unique index if not exists uq_incident_type_reports_open
  on incident_type_reports (incident_id, reported_by, reported_type) where resolved_at is null;
create index if not exists idx_incident_type_reports_incident
  on incident_type_reports (incident_id, reported_at desc);

alter table incident_type_reports enable row level security;

drop policy if exists incident_type_reports_read on incident_type_reports;
create policy incident_type_reports_read on incident_type_reports for select to authenticated
using (app.can_access_incident(incident_id));
-- No insert/update/delete policy: only the security definer functions below write.

-- ---------------------------------------------------------------------------------------------
-- 1. The ladder
-- ---------------------------------------------------------------------------------------------
create or replace function public.incident_type_role_tier(p_role text)
returns int
language sql
immutable
as $$
  select case
    when p_role in ('rpc', 'rcc', 'admin') then 3
    when p_role in ('pc', 'cc', 'chamal') then 2
    when p_role in ('medic', 'paramedic', 'physician') then 1
    else 0 end
$$;

create or replace function public.incident_type_stamp(p_actor uuid, p_role text, p_label text, p_at timestamptz)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object('role', p_role, 'profile_id', p_actor, 'by_label', coalesce(nullif(btrim(p_label), ''), p_role), 'at', p_at)
$$;

-- Who added p_type to the incident: its stamp, or the opener when there is none.
create or replace function public.incident_type_adder(p_incident uuid, p_type text, out adder_role text, out adder_id uuid, out added_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(i.metadata->'incident_types_set_by'->p_type->>'role', op.role::text),
         coalesce(nullif(i.metadata->'incident_types_set_by'->p_type->>'profile_id', '')::uuid, i.opened_by),
         nullif(i.metadata->'incident_types_set_by'->p_type->>'at', '')::timestamptz
  from incidents i left join profiles op on op.id = i.opened_by
  where i.id = p_incident
$$;

create or replace function public.incident_type_may_remove(p_incident uuid, p_type text, p_actor uuid, p_role text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tier int := incident_type_role_tier(p_role);
  v_adder record;
begin
  if v_tier = 0 then return false; end if;
  if v_tier = 3 then return true; end if;
  select * into v_adder from incident_type_adder(p_incident, p_type);
  if v_tier = 2 then
    return incident_type_role_tier(v_adder.adder_role) <= 2;
  end if;
  return incident_type_role_tier(v_adder.adder_role) = 1 and v_adder.adder_id = p_actor;
end;
$$;

revoke execute on function public.incident_type_adder(uuid, text) from public, anon;
revoke execute on function public.incident_type_may_remove(uuid, text, uuid, text) from public, anon;
grant execute on function public.incident_type_adder(uuid, text) to authenticated;
grant execute on function public.incident_type_may_remove(uuid, text, uuid, text) to authenticated;

-- Stamps for p_types: keep existing stamps of kept types, add p_stamp for new ones, drop removed.
create or replace function public.incident_types_restamp(p_meta jsonb, p_old text[], p_new text[], p_stamp jsonb)
returns jsonb
language plpgsql
immutable
as $$
declare
  v_set jsonb := coalesce(p_meta->'incident_types_set_by', '{}'::jsonb);
  v_removed jsonb := coalesce(p_meta->'incident_types_removed', '{}'::jsonb);
  v_out jsonb := '{}'::jsonb;
  t text;
begin
  foreach t in array p_new loop
    if t = any(p_old) and v_set ? t then
      v_out := v_out || jsonb_build_object(t, v_set->t);
    elsif not (t = any(p_old)) then
      v_out := v_out || jsonb_build_object(t, p_stamp);
    end if;
  end loop;
  foreach t in array p_old loop
    if not (t = any(p_new)) then
      v_removed := v_removed || jsonb_build_object(t, p_stamp);
    end if;
  end loop;
  p_meta := coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('incident_types_set_by', v_out, 'incident_types_removed', v_removed);
  if cardinality(p_new) > 0 and v_out ? p_new[1] then
    p_meta := p_meta || jsonb_build_object('incident_type_set_by', v_out->p_new[1]);
  else
    p_meta := p_meta - 'incident_type_set_by';
  end if;
  return p_meta;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 2. Every insert and update of incidents
-- ---------------------------------------------------------------------------------------------
create or replace function guard_incident_types()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_name text;
  v_old_types text[];
  v_old_meta jsonb;
  t text;
begin
  new.incident_types := coalesce(new.incident_types, '{}');

  if tg_op = 'INSERT' then
    if cardinality(new.incident_types) = 0 and new.incident_type is not null then
      new.incident_types := array[new.incident_type];
    end if;
    select p.role::text, p.display_name into v_role, v_name from profiles p where p.id = coalesce(new.opened_by, v_uid);
    new.metadata := incident_types_restamp(coalesce(new.metadata, '{}'::jsonb) - 'incident_types_set_by' - 'incident_types_removed' - 'incident_type_set_by',
                                           '{}', new.incident_types,
                                           incident_type_stamp(coalesce(new.opened_by, v_uid), v_role, v_name, now()));
    new.incident_type := new.incident_types[1];
    return new;
  end if;

  if coalesce(current_setting('app.incident_type_internal', true), '') = 'on' then
    new.incident_type := new.incident_types[1];
    return new; -- 090's own writes stamp themselves
  end if;

  v_old_types := coalesce(old.incident_types, '{}');
  v_old_meta := coalesce(old.metadata, '{}'::jsonb);

  -- An older phone writes only incident_type: that adds the type, never removes the others.
  if new.incident_types is not distinct from old.incident_types and new.incident_type is distinct from old.incident_type then
    if new.incident_type is not null and not (new.incident_type = any(new.incident_types)) then
      new.incident_types := new.incident_types || new.incident_type;
    end if;
  end if;

  -- The stamps are the server's: whatever the client sent for them is replaced by the old ones.
  new.metadata := coalesce(new.metadata, '{}'::jsonb) - 'incident_types_set_by' - 'incident_types_removed' - 'incident_type_set_by';
  if v_old_meta ? 'incident_types_set_by' then new.metadata := new.metadata || jsonb_build_object('incident_types_set_by', v_old_meta->'incident_types_set_by'); end if;
  if v_old_meta ? 'incident_types_removed' then new.metadata := new.metadata || jsonb_build_object('incident_types_removed', v_old_meta->'incident_types_removed'); end if;
  if v_old_meta ? 'incident_type_set_by' then new.metadata := new.metadata || jsonb_build_object('incident_type_set_by', v_old_meta->'incident_type_set_by'); end if;

  if new.incident_types is not distinct from v_old_types then
    new.incident_type := new.incident_types[1];
    return new;
  end if;

  if v_uid is not null then
    select p.role::text, p.display_name into v_role, v_name from profiles p where p.id = v_uid;
    foreach t in array new.incident_types loop
      if not (t = any(v_old_types)) and incident_type_role_tier(v_role) = 0 then
        raise exception 'role % may not add an incident type', v_role using errcode = '42501';
      end if;
    end loop;
    foreach t in array v_old_types loop
      if not (t = any(new.incident_types)) and not incident_type_may_remove(old.id, t, v_uid, v_role) then
        raise exception 'role % may not remove incident type % (added at a higher level)', v_role, t using errcode = '42501';
      end if;
    end loop;
  end if;

  new.metadata := incident_types_restamp(new.metadata, v_old_types, new.incident_types,
                                         incident_type_stamp(v_uid, coalesce(v_role, 'system'), v_name, now()));
  new.incident_type := new.incident_types[1];
  return new;
end;
$$;

revoke execute on function guard_incident_types() from public, anon, authenticated;

drop trigger if exists trg_guard_incident_types on incidents;
create trigger trg_guard_incident_types
before insert or update on incidents
for each row execute function guard_incident_types();

-- ---------------------------------------------------------------------------------------------
-- 3. The medic's event
-- ---------------------------------------------------------------------------------------------
create or replace function project_incident_type_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_name text;
  v_type text;
  v_action text;
  v_inc incidents;
  v_new text[];
  v_removed_at timestamptz;
  v_adder record;
begin
  if new.type not in ('INCIDENT_TYPE_SET_BY_MEDIC', 'INCIDENT_TYPE_MISMATCH_REPORTED') or new.incident_id is null then
    return new;
  end if;

  begin
    select p.role::text, p.display_name into v_role, v_name from profiles p where p.id = new.actor_id;
    if incident_type_role_tier(v_role) <> 1 then
      return new; -- kept in events as the record; only medical roles act through this path
    end if;
    v_type := new.payload_json->>'reportedType';
    v_action := case when new.type = 'INCIDENT_TYPE_SET_BY_MEDIC' and new.payload_json->>'action' = 'remove' then 'remove' else 'add' end;
    if v_type is null or v_type not in ('missile_strike_structural_collapse','mass_shooting','vehicle_accident','explosion') then
      return new;
    end if;

    select * into v_inc from incidents where id = new.incident_id for update;
    if not found then return new; end if;

    if v_action = 'add' then
      -- Re-adding withdraws this person's own "remove" report for the type.
      update incident_type_reports
      set resolved_at = now(), resolution = 'superseded', resolved_by = new.actor_id, resolved_by_role = v_role, resolved_by_name = v_name
      where incident_id = new.incident_id and reported_by = new.actor_id and reported_type = v_type and resolved_at is null;
      if v_type = any(v_inc.incident_types) then return new; end if;
      -- A late offline add from before someone removed the type does not undo the removal.
      v_removed_at := nullif(v_inc.metadata->'incident_types_removed'->v_type->>'at', '')::timestamptz;
      if v_removed_at is not null and new.local_timestamp < v_removed_at then return new; end if;
      v_new := v_inc.incident_types || v_type;
    else
      if not (v_type = any(v_inc.incident_types)) then
        update incident_type_reports
        set resolved_at = now(), resolution = 'matched', resolved_by = new.actor_id, resolved_by_role = v_role, resolved_by_name = v_name
        where incident_id = new.incident_id and reported_by = new.actor_id and reported_type = v_type and resolved_at is null;
        return new;
      end if;
      -- A removal decided before the type was (re)added does not apply to the newer addition.
      select * into v_adder from incident_type_adder(new.incident_id, v_type);
      if v_adder.added_at is not null and new.local_timestamp < v_adder.added_at then return new; end if;
      if not incident_type_may_remove(new.incident_id, v_type, new.actor_id, v_role) then
        update incident_type_reports
        set resolved_at = now(), resolution = 'superseded', resolved_by = new.actor_id, resolved_by_role = v_role, resolved_by_name = v_name
        where incident_id = new.incident_id and reported_by = new.actor_id and reported_type = v_type and resolved_at is null;
        insert into incident_type_reports (incident_id, source_event_id, reported_by, reported_by_role, reported_by_name,
                                           reported_type, types_at_report, reported_at)
        values (new.incident_id, new.id, new.actor_id, v_role, v_name, v_type, v_inc.incident_types, new.local_timestamp);
        return new;
      end if;
      v_new := array_remove(v_inc.incident_types, v_type);
    end if;

    perform set_config('app.incident_type_internal', 'on', true);
    update incidents
    set incident_types = v_new,
        metadata = incident_types_restamp(metadata, v_inc.incident_types, v_new,
                                          incident_type_stamp(new.actor_id, v_role, v_name, new.local_timestamp))
    where id = new.incident_id;
    perform set_config('app.incident_type_internal', 'off', true);
  exception when others then
    perform set_config('app.incident_type_internal', 'off', true);
    -- never fail the event insert over the projection
  end;

  return new;
end;
$$;

revoke execute on function project_incident_type_event() from public, anon, authenticated;

drop trigger if exists trg_project_incident_type_event on events;
create trigger trg_project_incident_type_event
after insert on events
for each row execute function project_incident_type_event();

-- ---------------------------------------------------------------------------------------------
-- 4. A type was removed: its open reports are done
-- ---------------------------------------------------------------------------------------------
create or replace function reconcile_incident_type_reports()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
  v_by jsonb;
begin
  if new.incident_types is not distinct from old.incident_types then
    return new;
  end if;
  begin
    foreach t in array coalesce(old.incident_types, '{}') loop
      if not (t = any(new.incident_types)) then
        v_by := new.metadata->'incident_types_removed'->t;
        update incident_type_reports
        set resolved_at = now(), resolution = 'matched',
            resolved_by = nullif(v_by->>'profile_id', '')::uuid, resolved_by_role = v_by->>'role', resolved_by_name = v_by->>'by_label'
        where incident_id = new.id and resolved_at is null and reported_type = t;
      end if;
    end loop;
  exception when others then
    null; -- never block the incident update
  end;
  return new;
end;
$$;

revoke execute on function reconcile_incident_type_reports() from public, anon, authenticated;

drop trigger if exists trg_reconcile_incident_type_reports on incidents;
create trigger trg_reconcile_incident_type_reports
after update of incident_types on incidents
for each row execute function reconcile_incident_type_reports();

-- ---------------------------------------------------------------------------------------------
-- 5. Close a report by hand
-- ---------------------------------------------------------------------------------------------
create or replace function public.resolve_incident_type_report(p_id uuid, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text := app.current_user_role()::text;
  v_name text;
  v_row incident_type_reports;
  v_inc incidents;
  v_new text[];
begin
  if v_role is null or v_role not in ('pc', 'cc', 'rpc', 'rcc', 'admin') then
    raise exception 'only pc, cc, rpc, rcc or admin may close an incident type report' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('accept', 'keep') then
    raise exception 'unknown action %', p_action using errcode = '22023';
  end if;

  select * into v_row from incident_type_reports where id = p_id for update;
  if not found then
    raise exception 'incident type report % not found', p_id using errcode = 'P0002';
  end if;
  if not app.can_access_incident(v_row.incident_id) then
    raise exception 'no access to this incident' using errcode = '42501';
  end if;
  if v_row.resolved_at is not null then
    return jsonb_build_object('id', v_row.id, 'changed', false, 'resolution', v_row.resolution, 'resolved_at', v_row.resolved_at);
  end if;

  select display_name into v_name from profiles where id = v_uid;
  select * into v_inc from incidents where id = v_row.incident_id for update;

  if p_action = 'accept' and v_row.reported_type = any(v_inc.incident_types)
     and not incident_type_may_remove(v_row.incident_id, v_row.reported_type, v_uid, v_role) then
    raise exception 'role % may not remove incident type % (added at a higher level)', v_role, v_row.reported_type using errcode = '42501';
  end if;

  update incident_type_reports
  set resolved_at = now(), resolution = case when p_action = 'accept' then 'accepted' else 'kept_current' end,
      resolved_by = v_uid, resolved_by_role = v_role, resolved_by_name = v_name
  where id = v_row.id
  returning * into v_row;

  v_new := v_inc.incident_types;
  if p_action = 'accept' and v_row.reported_type = any(v_inc.incident_types) then
    v_new := array_remove(v_inc.incident_types, v_row.reported_type);
    perform set_config('app.incident_type_internal', 'on', true);
    update incidents
    set incident_types = v_new,
        metadata = incident_types_restamp(metadata, v_inc.incident_types, v_new, incident_type_stamp(v_uid, v_role, v_name, now()))
    where id = v_row.incident_id;
    perform set_config('app.incident_type_internal', 'off', true);
  end if;

  return jsonb_build_object('id', v_row.id, 'changed', true, 'resolution', v_row.resolution,
                            'resolved_at', v_row.resolved_at, 'incident_types', to_jsonb(v_new));
end;
$$;

revoke execute on function public.resolve_incident_type_report(uuid, text) from public, anon;
grant execute on function public.resolve_incident_type_report(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 6. One change from a board (rescue panel, PC/CC buttons)
-- ---------------------------------------------------------------------------------------------
create or replace function public.change_incident_type(p_incident_id uuid, p_type text, p_action text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := app.current_user_role()::text;
  v_types text[];
begin
  if incident_type_role_tier(v_role) = 0 then
    raise exception 'role % may not change the incident type', v_role using errcode = '42501';
  end if;
  if p_type is null or p_type not in ('missile_strike_structural_collapse','mass_shooting','vehicle_accident','explosion') then
    raise exception 'unknown incident type %', p_type using errcode = '22023';
  end if;
  if p_action is null or p_action not in ('add', 'remove') then
    raise exception 'unknown action %', p_action using errcode = '22023';
  end if;
  if not app.can_access_incident(p_incident_id) then
    raise exception 'no access to this incident' using errcode = '42501';
  end if;
  select incident_types into v_types from incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if p_action = 'add' and not (p_type = any(v_types)) then
    update incidents set incident_types = v_types || p_type where id = p_incident_id;   -- guard stamps it
  elsif p_action = 'remove' and p_type = any(v_types) then
    update incidents set incident_types = array_remove(v_types, p_type) where id = p_incident_id; -- guard checks the ladder
  end if;
  return (select jsonb_build_object('incident_types', to_jsonb(incident_types), 'metadata', metadata) from incidents where id = p_incident_id);
end;
$$;

revoke execute on function public.change_incident_type(uuid, text, text) from public, anon;
grant execute on function public.change_incident_type(uuid, text, text) to authenticated;
