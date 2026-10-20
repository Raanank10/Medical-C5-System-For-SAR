-- Companies and platoons as real units (V2.99.42). Revised before it was ever applied: the first
-- version (V2.99.39) assumed one company. Structure confirmed with the repo owner 2026-10-20:
--
--   מ״פ רפואה (cc, one)            - sees every site
--   ├─ rescue company A..C (3)     - each: 1 מ״פ חילוץ (rcc), 1 חוג״ד (pc) with its medics,
--   │   └─ platoon A1..A3 (3 each) -   and 3 platoons, each led by 1 מ״מ (rpc)
--   └─ ambulance team               - 1 pc + 1 physician or paramedic + 3 medics; goes where it is
--                                      assigned (modelled as a company of kind 'ambulance')
--
-- Who sees which sites (app.can_access_incident):
-- - cc, chamal, admin, physician, paramedic: every site (owner: physician and paramedic see all).
-- - rcc and pc: their own company's sites. rpc: its own platoon's sites.
-- - Everyone also sees sites they opened, drafted or were assigned to (incident_memberships).
-- - medics: only sites they were assigned to or drafted (unchanged since database/045).
-- A site belongs to at most one company and one platoon of that company. A site opened by a
-- unit member belongs to the opener's unit. Company-level command can move any site; an rcc can
-- move a site between its own company's platoons.
--
-- The rescue chain (rpc, rcc) can no longer read clinical events (vitals, medication, treatment,
-- injuries, the MIST handover summary). Before this file that rule in
-- docs/ROLE_COMMAND_MODEL_v2.8.md was enforced on the screen only. Measured live 2026-10-20
-- (read-only, rpc impersonation): with no incident membership the rpc read all 5 incidents and
-- every event, including VITALS_RECORDED / MEDICATION_ADMINISTERED / INTERVENTION_RECORDED.
--
-- Replaces database/045's roster link (profiles.platoon_commander_id, set_platoon_commander()):
-- the column stays (no data dropped; 0 rows used it) but nothing reads it any more, and
-- set_platoon_commander() stays as a compatibility wrapper (puts the medic in the pc's company).
--
-- Not covered (docs/RLS_AUDIT_v1.md): the projected patients columns pulse_present /
-- breathing_present / injury_zones stay readable to rpc/rcc on patients they can reach (RLS
-- cannot hide single columns per role).

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null check (btrim(name) <> ''),
  kind text not null default 'rescue' check (kind in ('rescue','ambulance')),
  is_active boolean not null default true,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_companies_name on companies (lower(btrim(name)));

create table if not exists platoons (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id),
  name text not null check (btrim(name) <> ''),
  is_active boolean not null default true,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_platoons_company_name on platoons (company_id, lower(btrim(name)));

alter table profiles add column if not exists company_id uuid references companies(id) on delete set null;
alter table profiles add column if not exists platoon_id uuid references platoons(id) on delete set null;
create index if not exists idx_profiles_company on profiles(company_id) where company_id is not null;
create index if not exists idx_profiles_platoon on profiles(platoon_id) where platoon_id is not null;
comment on column profiles.company_id is
  'Company of a pc / rcc / medic / paramedic / physician (database/053). Set only by cc/chamal/admin/physician via set_profile_unit().';
comment on column profiles.platoon_id is
  'Platoon of an rpc (database/053); its company is the platoon''s. Set only by cc/chamal/admin/physician via set_profile_unit().';
comment on column profiles.platoon_commander_id is
  'Deprecated by database/053 (profiles.company_id). Kept for history; not read by any policy.';

alter table incidents add column if not exists company_id uuid references companies(id) on delete set null;
alter table incidents add column if not exists platoon_id uuid references platoons(id) on delete set null;
create index if not exists idx_incidents_company on incidents(company_id) where company_id is not null;
create index if not exists idx_incidents_platoon on incidents(platoon_id) where platoon_id is not null;
comment on column incidents.company_id is
  'The company working this site (database/053). Always the platoon''s company when platoon_id is set.';
comment on column incidents.platoon_id is
  'The rescue platoon working this site (database/053).';

-- Append-only record of every unit change, for after-action review.
create table if not exists unit_audit (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_role user_role,
  action text not null check (action in ('company_created','company_updated','platoon_created','platoon_updated',
                                         'profile_unit_changed','incident_unit_changed')),
  target_company_id uuid,
  target_platoon_id uuid,
  target_profile_id uuid,
  target_incident_id uuid,
  old_company_id uuid,
  new_company_id uuid,
  old_platoon_id uuid,
  new_platoon_id uuid,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_unit_audit_created on unit_audit(created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------------
-- Manages units (companies, platoons, who is where).
create or replace function app.is_unit_manager()
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

-- An rpc's company is its platoon's.
create or replace function app.my_company_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(p.company_id, pl.company_id)
  from profiles p
  left join platoons pl on pl.id = p.platoon_id
  where p.id = auth.uid() and p.is_active
$function$;

create or replace function app.write_unit_audit(p_action text, p_company uuid, p_platoon uuid, p_profile uuid,
                                                p_incident uuid, p_old_company uuid, p_new_company uuid,
                                                p_old_platoon uuid, p_new_platoon uuid, p_detail jsonb)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into unit_audit (actor_id, actor_role, action, target_company_id, target_platoon_id, target_profile_id,
                          target_incident_id, old_company_id, new_company_id, old_platoon_id, new_platoon_id, detail)
  values (auth.uid(), app.current_user_role(), p_action, p_company, p_platoon, p_profile, p_incident,
          p_old_company, p_new_company, p_old_platoon, p_new_platoon, coalesce(p_detail, '{}'::jsonb))
$function$;

-- ---------------------------------------------------------------------------------------------
-- Guards (also catch direct table writes that bypass the RPCs)
-- ---------------------------------------------------------------------------------------------
create or replace function app.reject_unit_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  raise exception 'unit_audit is append-only' using errcode = '42501';
end;
$function$;

drop trigger if exists trg_unit_audit_append_only on unit_audit;
create trigger trg_unit_audit_append_only
before update or delete on unit_audit
for each row execute function app.reject_unit_audit_mutation();

-- profiles: an rpc has a platoon; a pc / rcc / medic / paramedic / physician has a company; nobody
-- else has a unit. Only unit managers (or the service role / SQL editor, auth.uid() null) change
-- it. A role change keeps whatever still fits the new role and clears the rest. Audited.
create or replace function app.guard_profile_unit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old_company uuid := case when tg_op = 'UPDATE' then old.company_id end;
  v_old_platoon uuid := case when tg_op = 'UPDATE' then old.platoon_id end;
  v_role_changed boolean := tg_op = 'UPDATE' and new.role is distinct from old.role;
begin
  if v_role_changed then
    if new.role = 'rpc' then
      new.company_id := null;
    else
      new.platoon_id := null;
      if new.role not in ('pc','rcc','medic','paramedic','physician') then
        new.company_id := null;
      end if;
    end if;
  end if;
  if new.company_id is not distinct from v_old_company and new.platoon_id is not distinct from v_old_platoon then
    return new;
  end if;
  if auth.uid() is not null and not app.is_unit_manager()
     and not (v_role_changed
              and (new.company_id is null or new.company_id is not distinct from v_old_company)
              and (new.platoon_id is null or new.platoon_id is not distinct from v_old_platoon)) then
    raise exception 'only company-level command may change units' using errcode = '42501';
  end if;
  if new.platoon_id is not null and new.role <> 'rpc' then
    raise exception 'only a מ״מ (rpc) is placed in a platoon' using errcode = '22023';
  end if;
  if new.company_id is not null and new.role not in ('pc','rcc','medic','paramedic','physician') then
    raise exception 'only a pc, rcc, medic, paramedic or physician is placed in a company' using errcode = '22023';
  end if;
  if new.role = 'rcc' and new.company_id is not null
     and not exists (select 1 from companies where id = new.company_id and kind = 'rescue') then
    raise exception 'a מ״פ חילוץ (rcc) belongs to a rescue company' using errcode = '22023';
  end if;
  perform app.write_unit_audit('profile_unit_changed', coalesce(new.company_id, v_old_company),
    coalesce(new.platoon_id, v_old_platoon), new.id, null,
    v_old_company, new.company_id, v_old_platoon, new.platoon_id, jsonb_build_object('role', new.role));
  return new;
end;
$function$;

drop trigger if exists trg_guard_profile_unit on profiles;
create trigger trg_guard_profile_unit
before insert or update of company_id, platoon_id, role on profiles
for each row execute function app.guard_profile_unit();

-- incidents: company_id always follows platoon_id. Set at insert only to the opener's own unit
-- (or by unit managers / rcc); changed later by unit managers, by an rcc inside its own company,
-- or by confirm_draft() filling an empty value (transaction-local flag, same pattern as 040).
create or replace function app.guard_incident_unit()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old_company uuid := case when tg_op = 'UPDATE' then old.company_id end;
  v_old_platoon uuid := case when tg_op = 'UPDATE' then old.platoon_id end;
  v_mine uuid;
  v_platoon_company uuid;
begin
  if new.platoon_id is not null then
    select company_id into v_platoon_company from platoons where id = new.platoon_id;
    -- A company that contradicts the platoon is refused, not silently replaced (found by the
    -- local test: a pc's direct "move to company B" on a platoon site was a quiet no-op).
    if new.company_id is not null and new.company_id is distinct from v_platoon_company
       and (tg_op = 'INSERT' or new.company_id is distinct from old.company_id) then
      raise exception 'platoon % is not in company %', new.platoon_id, new.company_id using errcode = '22023';
    end if;
    new.company_id := v_platoon_company;
  end if;
  if new.company_id is not distinct from v_old_company and new.platoon_id is not distinct from v_old_platoon then
    return new;
  end if;
  if auth.uid() is not null
     and not app.is_unit_manager()
     and coalesce(current_setting('app.incident_unit_via_rpc', true), '') <> 'on' then
    v_mine := app.my_company_id();
    if not (
      (tg_op = 'INSERT'
        and (new.company_id is null or new.company_id = v_mine)
        and (new.platoon_id is null or new.platoon_id = app.my_platoon_id()))
      or (app.current_user_role() = 'rcc' and v_mine is not null
          and new.company_id = v_mine and (v_old_company is null or v_old_company = v_mine))
    ) then
      raise exception 'only company-level command may change which unit works a site' using errcode = '42501';
    end if;
  end if;
  if new.company_id is not null and not exists (select 1 from companies where id = new.company_id and is_active) then
    raise exception 'company % does not exist or is inactive', new.company_id using errcode = '22023';
  end if;
  if new.platoon_id is not null and not exists (select 1 from platoons where id = new.platoon_id and is_active) then
    raise exception 'platoon % does not exist or is inactive', new.platoon_id using errcode = '22023';
  end if;
  perform app.write_unit_audit('incident_unit_changed', coalesce(new.company_id, v_old_company),
    coalesce(new.platoon_id, v_old_platoon), null, new.id,
    v_old_company, new.company_id, v_old_platoon, new.platoon_id, jsonb_build_object('visual_id', new.visual_id));
  return new;
end;
$function$;

drop trigger if exists trg_guard_incident_unit on incidents;
create trigger trg_guard_incident_unit
before insert or update of company_id, platoon_id on incidents
for each row execute function app.guard_incident_unit();

-- ---------------------------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------------------------
-- Replaces database/045's version. rpc is no longer blanket; rcc is scoped to its company; pc to
-- its company (045's "a pc sees its platoon medics' drafts" is covered: a medic's draft now
-- carries the medic's company); paramedic joins the roles that see every site.
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
      app.current_user_role() in ('cc','chamal','admin','physician','paramedic')
      or exists (
        select 1
        from incident_memberships im
        where im.incident_id = p_incident_id
          and im.profile_id = auth.uid()
      )
      or (
        app.current_user_role() in ('pc','rcc')
        and app.my_company_id() is not null
        and exists (select 1 from incidents i where i.id = p_incident_id and i.company_id = app.my_company_id())
      )
      or (
        app.current_user_role() = 'rpc'
        and app.my_platoon_id() is not null
        and exists (select 1 from incidents i where i.id = p_incident_id and i.platoon_id = app.my_platoon_id())
      )
    ),
    false
  )
$function$;

-- A pc's membership writes: only its own company's medics/paramedics, only into its company's
-- sites or sites it belongs to, never itself.
create or replace function app.pc_may_manage_membership(p_incident_id uuid, p_profile_id uuid, p_role_at_incident user_role)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    app.current_user_role() = 'pc'
    and app.my_company_id() is not null
    and p_profile_id <> auth.uid()
    and p_role_at_incident in ('medic','paramedic')
    and (
      app.is_incident_member(p_incident_id)
      or exists (select 1 from incidents i where i.id = p_incident_id and i.company_id = app.my_company_id())
    )
    and exists (
      select 1 from profiles p
      where p.id = p_profile_id
        and p.role in ('medic','paramedic')
        and p.company_id = app.my_company_id()
    ),
    false
  )
$function$;

-- ---------------------------------------------------------------------------------------------
-- Unit management RPCs (company-level command)
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_company(p_name text, p_kind text default 'rescue')
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if not app.is_unit_manager() then
    raise exception 'only company-level command may create a company' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'company name is required' using errcode = '22023';
  end if;
  insert into companies (name, kind, created_by) values (btrim(p_name), coalesce(p_kind, 'rescue'), auth.uid())
  returning id into v_id;
  perform app.write_unit_audit('company_created', v_id, null, null, null, null, null, null, null,
    jsonb_build_object('name', btrim(p_name), 'kind', coalesce(p_kind, 'rescue')));
  return jsonb_build_object('id', v_id, 'name', btrim(p_name));
end;
$function$;

create or replace function public.update_company(p_company_id uuid, p_name text default null, p_is_active boolean default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_old companies;
begin
  if not app.is_unit_manager() then
    raise exception 'only company-level command may change a company' using errcode = '42501';
  end if;
  select * into v_old from companies where id = p_company_id for update;
  if not found then
    raise exception 'company % not found', p_company_id using errcode = 'P0002';
  end if;
  if p_name is not null and btrim(p_name) = '' then
    raise exception 'company name is required' using errcode = '22023';
  end if;
  update companies
  set name = coalesce(btrim(p_name), name), is_active = coalesce(p_is_active, is_active), updated_at = now()
  where id = p_company_id;
  perform app.write_unit_audit('company_updated', p_company_id, null, null, null, null, null, null, null,
    jsonb_build_object('old_name', v_old.name, 'new_name', coalesce(btrim(p_name), v_old.name),
                       'old_is_active', v_old.is_active, 'new_is_active', coalesce(p_is_active, v_old.is_active)));
  return jsonb_build_object('id', p_company_id);
end;
$function$;

create or replace function public.create_platoon(p_company_id uuid, p_name text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid;
begin
  if not app.is_unit_manager() then
    raise exception 'only company-level command may create a platoon' using errcode = '42501';
  end if;
  if not exists (select 1 from companies where id = p_company_id and is_active and kind = 'rescue') then
    raise exception 'platoons belong to an active rescue company' using errcode = '22023';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'platoon name is required' using errcode = '22023';
  end if;
  insert into platoons (company_id, name, created_by) values (p_company_id, btrim(p_name), auth.uid())
  returning id into v_id;
  perform app.write_unit_audit('platoon_created', p_company_id, v_id, null, null, null, null, null, null,
    jsonb_build_object('name', btrim(p_name)));
  return jsonb_build_object('id', v_id, 'company_id', p_company_id, 'name', btrim(p_name));
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
  if not app.is_unit_manager() then
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
  set name = coalesce(btrim(p_name), name), is_active = coalesce(p_is_active, is_active), updated_at = now()
  where id = p_platoon_id;
  perform app.write_unit_audit('platoon_updated', v_old.company_id, p_platoon_id, null, null, null, null, null, null,
    jsonb_build_object('old_name', v_old.name, 'new_name', coalesce(btrim(p_name), v_old.name),
                       'old_is_active', v_old.is_active, 'new_is_active', coalesce(p_is_active, v_old.is_active)));
  return jsonb_build_object('id', p_platoon_id);
end;
$function$;

-- Places a person: an rpc in a platoon (p_platoon_id), everyone else in a company (p_company_id).
-- Passing nulls takes the person out of their unit.
create or replace function public.set_profile_unit(p_profile_id uuid, p_company_id uuid, p_platoon_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role user_role;
begin
  if not app.is_unit_manager() then
    raise exception 'only company-level command may change units' using errcode = '42501';
  end if;
  select role into v_role from profiles where id = p_profile_id;
  if not found then
    raise exception 'profile % not found', p_profile_id using errcode = 'P0002';
  end if;
  if v_role = 'rpc' then
    if p_company_id is not null then
      raise exception 'a מ״מ (rpc) is placed in a platoon, not directly in a company' using errcode = '22023';
    end if;
  elsif p_platoon_id is not null then
    raise exception 'only a מ״מ (rpc) is placed in a platoon' using errcode = '22023';
  end if;
  update profiles
  set company_id = p_company_id, platoon_id = p_platoon_id, updated_at = now(), version = version + 1
  where id = p_profile_id
    and (company_id is distinct from p_company_id or platoon_id is distinct from p_platoon_id);
  return jsonb_build_object('profile_id', p_profile_id, 'company_id', p_company_id, 'platoon_id', p_platoon_id);
end;
$function$;

-- Which unit works a site. Unit managers: any; rcc: within its own company (the guard enforces it).
create or replace function public.set_incident_unit(p_incident_id uuid, p_company_id uuid, p_platoon_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not app.is_unit_manager() and coalesce(app.current_user_role()::text, '') <> 'rcc' then
    raise exception 'only company-level command may change which unit works a site' using errcode = '42501';
  end if;
  if not exists (select 1 from incidents where id = p_incident_id) then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if p_platoon_id is not null and p_company_id is not null
     and not exists (select 1 from platoons where id = p_platoon_id and company_id = p_company_id) then
    raise exception 'platoon % is not in company %', p_platoon_id, p_company_id using errcode = '22023';
  end if;
  update incidents set company_id = p_company_id, platoon_id = p_platoon_id, updated_at = now(), version = version + 1
  where id = p_incident_id
    and (company_id is distinct from p_company_id or platoon_id is distinct from p_platoon_id);
  return jsonb_build_object('incident_id', p_incident_id, 'company_id', p_company_id, 'platoon_id', p_platoon_id);
end;
$function$;

-- Compatibility for clients older than V2.99.39 (database/045 roster panel): puts the medic in
-- that pc's company.
create or replace function public.set_platoon_commander(p_profile_id uuid, p_pc_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_company uuid;
begin
  if not app.is_unit_manager() then
    raise exception 'only company-level command may change a platoon roster' using errcode = '42501';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id and role in ('medic','paramedic')) then
    raise exception 'only a medic or paramedic can be placed in a platoon' using errcode = '22023';
  end if;
  if p_pc_id is not null then
    select company_id into v_company from profiles where id = p_pc_id and role = 'pc';
    if v_company is null then
      raise exception 'that pc is not in a company yet' using errcode = '22023';
    end if;
  end if;
  return public.set_profile_unit(p_profile_id, v_company, null);
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Incident lifecycle: same bodies as live (database/038, 045), plus the unit.
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
  v_company uuid;
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
  -- database/053: a site opened by a unit member belongs to that member's unit.
  if v_role = 'rpc' then
    v_platoon := app.my_platoon_id();
    v_company := app.my_company_id();
  elsif v_role in ('pc','rcc','medic','paramedic') then
    v_company := app.my_company_id();
  end if;

  insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, address,
                         incident_type, status, draft_created_by, opened_by, opened_at, company_id, platoon_id)
  values (p_incident_id, v_visual_id, v_t_zero, v_t_zero, btrim(p_location_name),
          nullif(btrim(p_address), ''), nullif(btrim(p_incident_type), ''), v_status,
          case when v_status = 'draft' then v_uid end,
          case when v_status = 'active' then v_uid end,
          now(), v_company, v_platoon);

  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  values (p_incident_id, v_uid, v_role, v_uid)
  on conflict (incident_id, profile_id) do nothing;

  perform app.append_incident_lifecycle_event(
    p_incident_id,
    case when v_status = 'draft' then 'INCIDENT_DRAFT_CREATED'::event_type else 'INCIDENT_OPENED'::event_type end,
    jsonb_build_object('visual_id', v_visual_id, 'location_name', btrim(p_location_name),
                       'incident_type', p_incident_type, 't_zero', v_t_zero, 'status', v_status,
                       'company_id', v_company, 'platoon_id', v_platoon),
    p_device_id, p_local_event_id);

  perform refresh_incident_command_state(p_incident_id);

  return jsonb_build_object('id', p_incident_id, 'visual_id', v_visual_id,
                            'status', v_status, 'created', true, 'company_id', v_company, 'platoon_id', v_platoon);
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
  -- database/045, 053: no self-join into a site outside one's unit.
  if v_role in ('pc','rpc','rcc','medic','paramedic') and not app.can_access_incident(p_incident_id) then
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
    -- database/045, 053: unit roles list only the sites they can reach.
    and (app.current_user_role() not in ('pc','rpc','rcc','medic','paramedic') or app.can_access_incident(i.id))
  order by (i.status = 'draft') desc, i.opened_at desc;
end;
$function$;

-- Same body as database/045, plus: a pc confirming a draft with no company makes it its
-- company's site.
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

  perform set_config('app.incident_unit_via_rpc', 'on', true);
  update incidents
  set status = 'active',
      confirmed_by = auth.uid(),
      confirmed_at = now(),
      draft_resolved_at = now(),
      opened_by = coalesce(opened_by, auth.uid()),
      company_id = coalesce(company_id, case when v_role = 'pc' then app.my_company_id() end),
      metadata = metadata || jsonb_build_object('draft_resolution', 'confirmed'),
      updated_at = now(),
      version = version + 1
  where id = p_incident_id;
  perform set_config('app.incident_unit_via_rpc', '', true);

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
alter table companies enable row level security;
alter table platoons enable row level security;
alter table unit_audit enable row level security;

-- Names only; every active account may read them (phones show their own unit's name). Writes go
-- through the RPCs above only.
drop policy if exists companies_read on companies;
create policy companies_read on companies for select to authenticated
using ((select app.current_user_role()) is not null);

drop policy if exists platoons_read on platoons;
create policy platoons_read on platoons for select to authenticated
using ((select app.current_user_role()) is not null);

drop policy if exists unit_audit_read on unit_audit;
create policy unit_audit_read on unit_audit for select to authenticated
using ((select app.is_unit_manager()));

revoke all on companies, platoons, unit_audit from public, anon, authenticated;
grant select on companies, platoons, unit_audit to authenticated;

-- A pc reads its own row and its own company's people (medics, paramedics, its rcc, and the
-- company's platoons' rpc); company-level roles read everyone.
drop policy if exists profiles_read_authenticated on profiles;
create policy profiles_read_authenticated on profiles for select to authenticated using (
  id = (select auth.uid())
  or app.current_user_role() = any (array['cc','chamal','admin','physician']::user_role[])
  or (
    app.current_user_role() = 'pc'
    and app.my_company_id() is not null
    and (
      company_id = app.my_company_id()
      or exists (select 1 from platoons pl where pl.id = profiles.platoon_id and pl.company_id = app.my_company_id())
    )
  )
);

-- A pc reads memberships of every site it can reach (now including its company's sites).
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
revoke all on function app.is_unit_manager() from public, anon;
grant execute on function app.is_unit_manager() to authenticated;
revoke all on function app.my_platoon_id() from public, anon;
grant execute on function app.my_platoon_id() to authenticated;
revoke all on function app.my_company_id() from public, anon;
grant execute on function app.my_company_id() to authenticated;
revoke all on function app.write_unit_audit(text, uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function app.reject_unit_audit_mutation() from public, anon, authenticated;
revoke all on function app.guard_profile_unit() from public, anon, authenticated;
revoke all on function app.guard_incident_unit() from public, anon, authenticated;

revoke execute on function public.create_company(text, text) from public, anon;
grant execute on function public.create_company(text, text) to authenticated;
revoke execute on function public.update_company(uuid, text, boolean) from public, anon;
grant execute on function public.update_company(uuid, text, boolean) to authenticated;
revoke execute on function public.create_platoon(uuid, text) from public, anon;
grant execute on function public.create_platoon(uuid, text) to authenticated;
revoke execute on function public.update_platoon(uuid, text, boolean) from public, anon;
grant execute on function public.update_platoon(uuid, text, boolean) to authenticated;
revoke execute on function public.set_profile_unit(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_profile_unit(uuid, uuid, uuid) to authenticated;
revoke execute on function public.set_incident_unit(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_incident_unit(uuid, uuid, uuid) to authenticated;
