-- Platoons as real units, one company (V2.99.39). Decided with the repo owner 2026-10-20:
-- 1. A platoon (מחלקה) is one shared site team: its חוג״ד (pc), its מ״מ (rpc) and its medics /
--    paramedics. There is one company, so there is no companies table: company-level roles
--    (cc, chamal, admin, physician, and rcc on the rescue side) span every platoon.
-- 2. An incident (site) belongs to at most one platoon (incidents.platoon_id).
-- 3. A מ״מ (rpc) sees only its own platoon's incidents (plus ones it opened or was assigned to),
--    like a חוג״ד. מ״פ חילוץ (rcc) keeps every incident.
-- 4. The rescue chain (rpc, rcc) can no longer read clinical events (vitals, medication,
--    treatment, injuries, the MIST handover summary) at the database level. Before this file the
--    rule "no vitals / treatment / mechanism" in docs/ROLE_COMMAND_MODEL_v2.8.md was enforced on
--    the screen only.
--
-- Measured live before this file (2026-10-20, read-only, rpc impersonation): the rpc account,
-- with no incident membership, read all 5 incidents, all 5 patients, all 29 events including
-- VITALS_RECORDED / MEDICATION_ADMINISTERED / INTERVENTION_RECORDED, and the
-- vw_patient_latest_vitals / vw_patient_treatment_history views (security_invoker, so they
-- follow events RLS and are covered by the events policy below).
--
-- Replaces database/045's roster link (profiles.platoon_commander_id, set_platoon_commander()).
-- The column stays (no data dropped; it held 0 rows when this was written) but nothing reads it
-- any more. set_platoon_commander() stays as a compatibility wrapper for clients older than
-- V2.99.39: it places the medic in the PC's platoon.
--
-- Not covered here (documented in docs/RLS_AUDIT_v1.md): the projected patients columns
-- pulse_present / breathing_present / injury_zones stay readable to rpc/rcc on patients rows
-- they can access (row-level security cannot hide single columns per role).

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table if not exists platoons (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  is_active boolean not null default true,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_platoons_name on platoons (lower(btrim(name)));

alter table profiles add column if not exists platoon_id uuid references platoons(id) on delete set null;
create index if not exists idx_profiles_platoon on profiles(platoon_id) where platoon_id is not null;
comment on column profiles.platoon_id is
  'The platoon (shared site team) this pc / rpc / medic / paramedic belongs to. Set only by cc/chamal/admin/physician via set_profile_platoon() (database/053).';
comment on column profiles.platoon_commander_id is
  'Deprecated by database/053 (profiles.platoon_id). Kept for history; not read by any policy.';

alter table incidents add column if not exists platoon_id uuid references platoons(id) on delete set null;
create index if not exists idx_incidents_platoon on incidents(platoon_id) where platoon_id is not null;
comment on column incidents.platoon_id is
  'The platoon working this site. Set at open from the opener''s platoon, or by company-level command via set_incident_platoon() (database/053).';

-- Append-only record of every platoon change, for after-action review.
create table if not exists platoon_audit (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_role user_role,
  action text not null check (action in ('platoon_created','platoon_updated','profile_platoon_changed','incident_platoon_changed')),
  platoon_id uuid,
  target_profile_id uuid,
  target_incident_id uuid,
  old_platoon_id uuid,
  new_platoon_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_platoon_audit_created on platoon_audit(created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
create or replace function app.is_company_command()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(app.current_user_role() in ('cc','chamal','admin','physician'), false)
$function$;

create or replace function app.my_platoon_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p.platoon_id from profiles p where p.id = auth.uid() and p.is_active
$function$;

create or replace function app.write_platoon_audit(p_action text, p_platoon_id uuid, p_profile_id uuid,
                                                   p_incident_id uuid, p_old uuid, p_new uuid, p_detail jsonb)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into platoon_audit (actor_id, actor_role, action, platoon_id, target_profile_id, target_incident_id,
                             old_platoon_id, new_platoon_id, detail)
  values (auth.uid(), app.current_user_role(), p_action, p_platoon_id, p_profile_id, p_incident_id,
          p_old, p_new, coalesce(p_detail, '{}'::jsonb))
$function$;

-- ---------------------------------------------------------------------------------------------
-- Guards (also catch direct table writes that bypass the RPCs)
-- ---------------------------------------------------------------------------------------------
create or replace function app.reject_platoon_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  raise exception 'platoon_audit is append-only' using errcode = '42501';
end;
$function$;

drop trigger if exists trg_platoon_audit_append_only on platoon_audit;
create trigger trg_platoon_audit_append_only
before update or delete on platoon_audit
for each row execute function app.reject_platoon_audit_mutation();

-- profiles.platoon_id: only company-level command (or the service role / SQL editor, where
-- auth.uid() is null) changes it, and only pc/rpc/medic/paramedic can be in a platoon. A role
-- change out of those roles takes the person out of the platoon. Every change is audited.
create or replace function app.guard_profile_platoon()
returns trigger
language plpgsql
security definer
set search_path to 'public'
declare
  v_old uuid := case when tg_op = 'UPDATE' then old.platoon_id end;
begin
  if tg_op = 'UPDATE' and new.role is distinct from old.role
     and new.role not in ('pc','rpc','medic','paramedic') then
    new.platoon_id := null;
  end if;
  if new.platoon_id is distinct from v_old then
    if auth.uid() is not null and not app.is_company_command()
       and not (tg_op = 'UPDATE' and new.role is distinct from old.role and new.platoon_id is null) then
      raise exception 'only company-level command may change a platoon roster' using errcode = '42501';
    end if;
    if new.platoon_id is not null and new.role not in ('pc','rpc','medic','paramedic') then
      raise exception 'only a pc, rpc, medic or paramedic can be in a platoon' using errcode = '22023';
    end if;
    perform app.write_platoon_audit('profile_platoon_changed', coalesce(new.platoon_id, v_old), new.id, null,
      v_old, new.platoon_id,
      jsonb_build_object('role', new.role));
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_guard_profile_platoon on profiles;
create trigger trg_guard_profile_platoon
before insert or update of platoon_id, role on profiles
for each row execute function app.guard_profile_platoon();

-- incidents.platoon_id: set at insert only to the opener's own platoon (or by company-level /
-- rescue-company command); changed later only by company-level command or rcc, or by
-- confirm_draft() filling an empty value (transaction-local flag, same pattern as database/040).
create or replace function app.guard_incident_platoon()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old uuid := case when tg_op = 'UPDATE' then old.platoon_id end;
begin
  if new.platoon_id is not distinct from v_old then
    return new;
  end if;
  if auth.uid() is not null
     and not app.is_company_command()
     and coalesce(app.current_user_role()::text, '') <> 'rcc'
     and coalesce(current_setting('app.incident_platoon_via_rpc', true), '') <> 'on'
     and not (tg_op = 'INSERT' and new.platoon_id = app.my_platoon_id()) then
    raise exception 'only company-level command may change which platoon works a site' using errcode = '42501';
  end if;
  if new.platoon_id is not null and not exists (select 1 from platoons where id = new.platoon_id and is_active) then
    raise exception 'platoon % does not exist or is inactive', new.platoon_id using errcode = '22023';
  end if;
  perform app.write_platoon_audit('incident_platoon_changed', coalesce(new.platoon_id, v_old), null, new.id,
    v_old, new.platoon_id, jsonb_build_object('visual_id', new.visual_id));
  return new;
end;
$function$;

drop trigger if exists trg_guard_incident_platoon on incidents;
create trigger trg_guard_incident_platoon
before insert or update of platoon_id on incidents
for each row execute function app.guard_incident_platoon();

-- ---------------------------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------------------------
-- database/045 plus: pc and rpc reach every incident of their own platoon; rpc is no longer
-- company-wide. A pc still sees a platoon-less draft drafted by a medic of its platoon (drafts
-- from before 053, or by a medic placed in the platoon after drafting). Found in the live
-- rolled-back test: without "platoon_id is null" a draft that company command had moved to
-- another platoon stayed visible to the drafter's pc.
create or replace function app.can_access_incident(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    app.current_user_role() is not null
    and (
      app.current_user_role() in ('cc','chamal','admin','rcc','physician')
      or exists (
        select 1
        from incident_memberships im
        where im.incident_id = p_incident_id
          and im.profile_id = auth.uid()
      )
      or (
        app.current_user_role() in ('pc','rpc')
        and app.my_platoon_id() is not null
        and exists (
          select 1 from incidents i
          where i.id = p_incident_id and i.platoon_id = app.my_platoon_id()
        )
      )
      or (
        app.current_user_role() = 'pc'
        and app.my_platoon_id() is not null
        and exists (
          select 1
          from incidents i
          join profiles d on d.id = i.draft_created_by
          where i.id = p_incident_id
            and i.status = 'draft'
            and i.platoon_id is null -- once a site has a platoon, only that platoon's pc sees it
            and d.platoon_id = app.my_platoon_id()
        )
      )
    ),
    false
  )
$function$;

-- A pc's membership writes: only in incidents of its own platoon or that it belongs to, only for
-- its own platoon's medics/paramedics, never itself.
create or replace function app.pc_may_manage_membership(p_incident_id uuid, p_profile_id uuid, p_role_at_incident user_role)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    app.current_user_role() = 'pc'
    and app.my_platoon_id() is not null
    and p_profile_id <> auth.uid()
    and p_role_at_incident in ('medic','paramedic')
    and (
      app.is_incident_member(p_incident_id)
      or exists (select 1 from incidents i where i.id = p_incident_id and i.platoon_id = app.my_platoon_id())
    )
    and exists (
      select 1 from profiles p
      where p.id = p_profile_id
        and p.role in ('medic','paramedic')
        and p.platoon_id = app.my_platoon_id()
    ),
    false
  )
$function$;

-- ---------------------------------------------------------------------------------------------
-- Platoon management RPCs (company-level command)
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_platoon(p_name text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if not app.is_company_command() then
    raise exception 'only company-level command may create a platoon' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'platoon name is required' using errcode = '22023';
  end if;
  insert into platoons (name, created_by) values (btrim(p_name), auth.uid()) returning id into v_id;
  perform app.write_platoon_audit('platoon_created', v_id, null, null, null, null,
    jsonb_build_object('name', btrim(p_name)));
  return jsonb_build_object('id', v_id, 'name', btrim(p_name));
end;
$function$;

create or replace function public.update_platoon(p_platoon_id uuid, p_name text default null, p_is_active boolean default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old platoons;
begin
  if not app.is_company_command() then
    raise exception 'only company-level command may change a platoon' using errcode = '42501';
  end if;
  select * into v_old from platoons where id = p_platoon_id for update;
  if not found then
    raise exception 'platoon % not found', p_platoon_id using errcode = 'P0002';
  end if;
  if p_name is not null and btrim(p_name) = '' then
    raise exception 'platoon name is required' using errcode = '22023';
  end if;
  update platoons
  set name = coalesce(btrim(p_name), name),
      is_active = coalesce(p_is_active, is_active),
      updated_at = now()
  where id = p_platoon_id;
  perform app.write_platoon_audit('platoon_updated', p_platoon_id, null, null, null, null,
    jsonb_build_object('old_name', v_old.name, 'new_name', coalesce(btrim(p_name), v_old.name),
                       'old_is_active', v_old.is_active, 'new_is_active', coalesce(p_is_active, v_old.is_active)));
  return jsonb_build_object('id', p_platoon_id);
end;
$function$;

create or replace function public.set_profile_platoon(p_profile_id uuid, p_platoon_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not app.is_company_command() then
    raise exception 'only company-level command may change a platoon roster' using errcode = '42501';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id and role in ('pc','rpc','medic','paramedic')) then
    raise exception 'only a pc, rpc, medic or paramedic can be in a platoon' using errcode = '22023';
  end if;
  if p_platoon_id is not null and not exists (select 1 from platoons where id = p_platoon_id and is_active) then
    raise exception 'platoon % does not exist or is inactive', p_platoon_id using errcode = '22023';
  end if;
  update profiles set platoon_id = p_platoon_id, updated_at = now(), version = version + 1
  where id = p_profile_id and platoon_id is distinct from p_platoon_id;
  return jsonb_build_object('profile_id', p_profile_id, 'platoon_id', p_platoon_id);
end;
$function$;

create or replace function public.set_incident_platoon(p_incident_id uuid, p_platoon_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not app.is_company_command() and coalesce(app.current_user_role()::text, '') <> 'rcc' then
    raise exception 'only company-level command may change which platoon works a site' using errcode = '42501';
  end if;
  if not exists (select 1 from incidents where id = p_incident_id) then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  update incidents set platoon_id = p_platoon_id, updated_at = now(), version = version + 1
  where id = p_incident_id and platoon_id is distinct from p_platoon_id;
  return jsonb_build_object('incident_id', p_incident_id, 'platoon_id', p_platoon_id);
end;
$function$;

-- Compatibility for clients older than V2.99.39 (database/045 roster panel).
create or replace function public.set_platoon_commander(p_profile_id uuid, p_pc_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_platoon uuid;
begin
  if not app.is_company_command() then
    raise exception 'only company-level command may change a platoon roster' using errcode = '42501';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id and role in ('medic','paramedic')) then
    raise exception 'only a medic or paramedic can be placed in a platoon' using errcode = '22023';
  end if;
  if p_pc_id is not null then
    select platoon_id into v_platoon from profiles where id = p_pc_id and role = 'pc';
    if v_platoon is null then
      raise exception 'that pc is not in a platoon yet' using errcode = '22023';
    end if;
  end if;
  return public.set_profile_platoon(p_profile_id, v_platoon);
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Incident lifecycle: same bodies as live (database/038, 045), plus the platoon.
-- ---------------------------------------------------------------------------------------------
create or replace function public.open_incident(p_incident_id uuid, p_location_name text, p_address text DEFAULT NULL::text, p_incident_type text DEFAULT NULL::text, p_t_zero timestamp with time zone DEFAULT NULL::timestamp with time zone, p_device_id text DEFAULT NULL::text, p_local_event_id text DEFAULT NULL::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role user_role := app.current_user_role();
  v_uid uuid := auth.uid();
  v_status incident_status;
  v_t_zero timestamptz := coalesce(p_t_zero, now());
  v_existing incidents;
  v_visual_id text;
  v_platoon uuid;
begin
  if v_role is null then
    raise exception 'no active profile' using errcode = '42501';
  end if;
  if v_role in ('medic','paramedic') then
    v_status := 'draft';
  elsif v_role in ('pc','cc','chamal','admin','physician','rpc','rcc') then
    v_status := 'active';
  else
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
  -- database/053: a site opened by a platoon member belongs to that platoon.
  if v_role in ('pc','rpc','medic','paramedic') then
    v_platoon := app.my_platoon_id();
  end if;

  insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, address,
                         incident_type, status, draft_created_by, opened_by, opened_at, platoon_id)
  values (p_incident_id, v_visual_id, v_t_zero, v_t_zero, btrim(p_location_name),
          nullif(btrim(p_address), ''), nullif(btrim(p_incident_type), ''), v_status,
          case when v_status = 'draft' then v_uid end,
          case when v_status = 'active' then v_uid end,
          now(), v_platoon);

  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  values (p_incident_id, v_uid, v_role, v_uid)
  on conflict (incident_id, profile_id) do nothing;

  perform app.append_incident_lifecycle_event(
    p_incident_id,
    case when v_status = 'draft' then 'INCIDENT_DRAFT_CREATED'::event_type else 'INCIDENT_OPENED'::event_type end,
    jsonb_build_object('visual_id', v_visual_id, 'location_name', btrim(p_location_name),
                       'incident_type', p_incident_type, 't_zero', v_t_zero, 'status', v_status,
                       'platoon_id', v_platoon),
    p_device_id, p_local_event_id);

  perform refresh_incident_command_state(p_incident_id);

  return jsonb_build_object('id', p_incident_id, 'visual_id', v_visual_id,
                            'status', v_status, 'created', true, 'platoon_id', v_platoon);
end;
$function$;

create or replace function public.join_incident(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role user_role := app.current_user_role();
  v_status incident_status;
begin
  if v_role is null then
    raise exception 'no active profile' using errcode = '42501';
  end if;
  select status into v_status from incidents where id = p_incident_id;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_status not in ('draft','staging','active') then
    raise exception 'incident % is %, not open for joining', p_incident_id, v_status using errcode = '42501';
  end if;
  -- database/045, 053: no self-join into someone else's site. A pc/rpc/medic/paramedic joins
  -- only what it can already access (its platoon's site, assigned, or opened/drafted).
  if v_role in ('pc','rpc','medic','paramedic') and not app.can_access_incident(p_incident_id) then
    raise exception 'assignment required to join incident %', p_incident_id using errcode = '42501';
  end if;
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  values (p_incident_id, auth.uid(), v_role, auth.uid())
  on conflict (incident_id, profile_id) do nothing;
  return jsonb_build_object('id', p_incident_id, 'status', v_status, 'role_at_incident', v_role);
end;
$function$;

create or replace function public.list_open_incidents()
returns table(id uuid, visual_id text, location_name text, address text, incident_type text, status incident_status, t_zero timestamptz, opened_at timestamptz, opened_by_name text, draft_acknowledged_at timestamptz, patient_count bigint, is_member boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if app.current_user_role() is null then
    raise exception 'no active profile' using errcode = '42501';
  end if;
  return query
  select i.id, i.visual_id, i.location_name, i.address, i.incident_type, i.status,
         i.t_zero, i.opened_at,
         coalesce(op.display_name, dc.display_name),
         i.draft_acknowledged_at,
         (select count(*) from patients p where p.incident_id = i.id),
         exists (select 1 from incident_memberships m
                 where m.incident_id = i.id and m.profile_id = auth.uid())
  from incidents i
  left join profiles op on op.id = i.opened_by
  left join profiles dc on dc.id = i.draft_created_by
  where i.status in ('draft','staging','active')
    -- database/045, 053: pc/rpc/medic/paramedic list only incidents they can access.
    and (app.current_user_role() not in ('pc','rpc','medic','paramedic') or app.can_access_incident(i.id))
  order by (i.status = 'draft') desc, i.opened_at desc;
end;
$function$;

-- Same body as database/045, plus: a pc confirming a platoon-less draft makes it its platoon's
-- site.
create or replace function public.confirm_draft(p_incident_id uuid, p_device_id text default null, p_local_event_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role user_role := app.current_user_role();
  v_inc incidents;
begin
  if not app.is_command_role() then
    raise exception 'only command roles can confirm a draft incident' using errcode = '42501';
  end if;
  if not app.can_access_incident(p_incident_id) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_inc.status = 'active' and v_inc.confirmed_by is not null then
    return jsonb_build_object('id', p_incident_id, 'status', v_inc.status, 'changed', false);
  end if;
  if v_inc.status <> 'draft' then
    raise exception 'incident % is %, not a draft', p_incident_id, v_inc.status using errcode = '42501';
  end if;

  perform set_config('app.incident_platoon_via_rpc', 'on', true);
  update incidents
  set status = 'active',
      confirmed_by = auth.uid(),
      confirmed_at = now(),
      draft_resolved_at = now(),
      opened_by = coalesce(opened_by, auth.uid()),
      platoon_id = coalesce(platoon_id, case when v_role = 'pc' then app.my_platoon_id() end),
      metadata = metadata || jsonb_build_object('draft_resolution', 'confirmed'),
      updated_at = now(),
      version = version + 1
  where id = p_incident_id;
  perform set_config('app.incident_platoon_via_rpc', '', true);

  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  values (p_incident_id, auth.uid(), v_role, auth.uid())
  on conflict (incident_id, profile_id) do nothing;

  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_CONFIRMED',
    jsonb_build_object('visual_id', v_inc.visual_id, 'draft_created_by', v_inc.draft_created_by),
    p_device_id, p_local_event_id);

  return jsonb_build_object('id', p_incident_id, 'status', 'active', 'changed', true);
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------------------------
alter table platoons enable row level security;
alter table platoon_audit enable row level security;

-- Names only; every active account may read them (the phone shows its own platoon's name).
-- Writes go through the RPCs above only.
drop policy if exists platoons_read on platoons;
create policy platoons_read on platoons for select to authenticated
using ((select app.current_user_role()) is not null);

drop policy if exists platoon_audit_read on platoon_audit;
create policy platoon_audit_read on platoon_audit for select to authenticated
using ((select app.is_company_command()));

revoke all on platoons, platoon_audit from public, anon, authenticated;
grant select on platoons, platoon_audit to authenticated;

-- A pc reads its own row and its own platoon's members; company-level roles read everyone.
drop policy if exists profiles_read_authenticated on profiles;
create policy profiles_read_authenticated on profiles for select to authenticated using (
  id = (select auth.uid())
  or app.current_user_role() = any (array['cc','chamal','admin','physician']::user_role[])
  or (app.current_user_role() = 'pc' and platoon_id is not null and platoon_id = app.my_platoon_id())
);

-- A pc reads memberships of every incident it can reach (now including its platoon's sites).
drop policy if exists incident_memberships_read_scoped on incident_memberships;
create policy incident_memberships_read_scoped on incident_memberships for select to authenticated using (
  profile_id = (select auth.uid())
  or app.current_user_role() = any (array['cc','chamal','admin','physician']::user_role[])
  or (app.current_user_role() = 'pc' and app.can_access_incident(incident_id))
);

-- Rescue chain (rpc, rcc): only the tactical event types (incident, site, location, access,
-- triage colour, status, evacuation, tourniquet on/off, first-responder and external reports,
-- supply requests), plus anything they wrote themselves. An allowlist on purpose: a new event
-- type is hidden from rescue until someone decides otherwise. Excluded on purpose:
-- PATIENT_HANDED_OVER (carries the MIST summary with vitals and treatments), PATIENT_CREATED /
-- QUICK_PATIENT_CREATED (intake payloads), every vitals / medication / treatment / injury type,
-- notes and watchdog types (free text).
drop policy if exists events_read_authenticated on events;
create policy events_read_authenticated on events for select to authenticated using (
  app.can_access_incident(incident_id)
  and (
    (select app.current_user_role()) not in ('rpc','rcc')
    or actor_id = (select auth.uid())
    or type = any (array[
      'INCIDENT_DRAFT_CREATED','INCIDENT_OPENED','INCIDENT_CONFIRMED','INCIDENT_DRAFT_MERGED',
      'INCIDENT_DRAFT_REJECTED','INCIDENT_CLOSED','INCIDENT_REOPENED','INCIDENT_CLOSE_TOGGLED',
      'OFFICIAL_INCIDENT_OPENED_BY_RESCUE','BUILDING_STATUS_UPDATED','SITE_CLEAR_CONFIRMED',
      'MEDIC_SITE_CLOSE_REQUESTED','SITE_PRE_EVACUATION_REPORTED','FIRST_RESPONDER_REPORT',
      'PATIENT_IDENTIFIED','PATIENT_LOCATION_UPDATED','PATIENT_ACCESS_UPDATED',
      'PATIENT_TRIAGE_UPDATED','PATIENT_TRIAGED_EXPECTANT','PATIENT_STATUS_UPDATED',
      'PATIENT_EVACUATION_UPDATED','TOURNIQUET_APPLIED','TOURNIQUET_RELEASED',
      'EXTERNAL_REPORT_CREATED','EXTERNAL_REPORT_LINKED',
      'SUPPLY_REQUEST_CREATED','SUPPLY_REQUEST_DISPATCHED','SUPPLY_REQUEST_IN_TRANSIT','SUPPLY_REQUEST_RECEIVED'
    ]::event_type[])
  )
);

-- ---------------------------------------------------------------------------------------------
-- Grants (database/046 convention)
-- ---------------------------------------------------------------------------------------------
revoke all on function app.is_company_command() from public, anon;
grant execute on function app.is_company_command() to authenticated;
revoke all on function app.my_platoon_id() from public, anon;
grant execute on function app.my_platoon_id() to authenticated;
revoke all on function app.write_platoon_audit(text, uuid, uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function app.reject_platoon_audit_mutation() from public, anon, authenticated;
revoke all on function app.guard_profile_platoon() from public, anon, authenticated;
revoke all on function app.guard_incident_platoon() from public, anon, authenticated;

revoke execute on function public.create_platoon(text) from public, anon;
grant execute on function public.create_platoon(text) to authenticated;
revoke execute on function public.update_platoon(uuid, text, boolean) from public, anon;
grant execute on function public.update_platoon(uuid, text, boolean) to authenticated;
revoke execute on function public.set_profile_platoon(uuid, uuid) from public, anon;
grant execute on function public.set_profile_platoon(uuid, uuid) to authenticated;
revoke execute on function public.set_incident_platoon(uuid, uuid) from public, anon;
grant execute on function public.set_incident_platoon(uuid, uuid) to authenticated;
