-- Command hierarchy as a security scope (V2.99.31), decided with the repo owner 2026-10-18:
-- מ״פ רפואה (cc, company) sees every site; חוג״ד (pc, platoon) only its own platoon's site.
-- A site is an incident, and one incident belongs to one platoon (no platoon split inside an
-- incident). docs/ROLE_COMMAND_MODEL_v2.8.md "Command scope follows the hierarchy".
--
-- Already true before this file: app.can_access_incident() gives cc/chamal/admin/physician/rpc/rcc
-- every incident and everyone else only incidents they are a member of. The PC was still not
-- confined, because membership was self-service. Gaps found live 2026-10-18:
-- 1. join_incident() let any role self-join any open incident (and so read all its patients).
-- 2. incident_memberships insert/update/delete/read: a pc could write any membership row in any
--    incident (including itself), delete any membership, and read every incident's roster.
-- 3. list_open_incidents() showed every open incident (address, patient count) to everyone.
-- 4. confirm_draft / reject_draft / acknowledge_draft only checked "is a command role", so any pc
--    could confirm or reject any draft, even one it could not see.
-- 5. profiles: a pc could read every account, so it could assign another platoon's medic.
-- 6. incidents update/delete USING checked the role only (the SELECT policy happened to scope it).
--
-- Rules after this file:
-- - A pc / medic / paramedic is in an incident only if it opened (or drafted) it, or was assigned
--   by someone allowed to assign. No self-join. logistics_officer keeps self-join (unchanged; its
--   supply work spans incidents - not part of this decision).
-- - Platoon roster: profiles.platoon_commander_id links a medic/paramedic to its PC. Only
--   cc/chamal/admin/physician set it (set_platoon_commander()); there is no UPDATE policy on
--   profiles, and a trigger refuses any other change.
-- - A medic's draft is visible to (and confirmable by) the PC of that medic's platoon, as well as
--   the company-level roles. Confirming makes that PC a member.
-- - A pc may assign only its own platoon's medics/paramedics, only into incidents it is a member
--   of, and never itself or another command role. cc/chamal/admin/physician assign anyone,
--   including a PC.

-- ---------------------------------------------------------------------------------------------
-- Platoon roster
-- ---------------------------------------------------------------------------------------------
alter table profiles add column if not exists platoon_commander_id uuid references profiles(id) on delete set null;
create index if not exists idx_profiles_platoon_commander on profiles(platoon_commander_id) where platoon_commander_id is not null;

comment on column profiles.platoon_commander_id is
  'The PC (חוג״ד) whose platoon this medic/paramedic belongs to. Set only by cc/chamal/admin/physician via set_platoon_commander() (database/045).';

create or replace function app.guard_platoon_commander_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.platoon_commander_id is distinct from (case when tg_op = 'UPDATE' then old.platoon_commander_id end) then
    -- auth.uid() is null for the service role / migrations / handle_new_user(); those may set it.
    if auth.uid() is not null
       and coalesce(app.current_user_role()::text, '') not in ('cc','chamal','admin','physician') then
      raise exception 'only company-level command may change a platoon roster' using errcode = '42501';
    end if;
    if new.platoon_commander_id is not null and not exists (
      select 1 from profiles p where p.id = new.platoon_commander_id and p.role = 'pc'
    ) then
      raise exception 'platoon commander must be a pc profile' using errcode = '22023';
    end if;
  end if;
  return new;
end;
$function$;

drop trigger if exists trg_guard_platoon_commander_change on profiles;
create trigger trg_guard_platoon_commander_change
before insert or update of platoon_commander_id on profiles
for each row execute function app.guard_platoon_commander_change();

create or replace function public.set_platoon_commander(p_profile_id uuid, p_pc_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role user_role := app.current_user_role();
begin
  if v_role is null or v_role not in ('cc','chamal','admin','physician') then
    raise exception 'only company-level command may change a platoon roster' using errcode = '42501';
  end if;
  if not exists (select 1 from profiles where id = p_profile_id and role in ('medic','paramedic')) then
    raise exception 'only a medic or paramedic can be placed in a platoon' using errcode = '22023';
  end if;
  update profiles set platoon_commander_id = p_pc_id, updated_at = now(), version = version + 1
  where id = p_profile_id;
  return jsonb_build_object('profile_id', p_profile_id, 'platoon_commander_id', p_pc_id);
end;
$function$;

revoke execute on function public.set_platoon_commander(uuid, uuid) from public, anon;
grant execute on function public.set_platoon_commander(uuid, uuid) to authenticated;
revoke all on function app.guard_platoon_commander_change() from public;

-- ---------------------------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------------------------
create or replace function app.is_incident_member(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from incident_memberships im
    where im.incident_id = p_incident_id and im.profile_id = auth.uid()
  )
$function$;

-- Same as database/020, plus: a pc sees a draft drafted by a medic of its own platoon.
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
      app.current_user_role() in ('cc','chamal','admin','rpc','rcc','physician')
      or exists (
        select 1
        from incident_memberships im
        where im.incident_id = p_incident_id
          and im.profile_id = auth.uid()
      )
      or (
        app.current_user_role() = 'pc'
        and exists (
          select 1
          from incidents i
          join profiles d on d.id = i.draft_created_by
          where i.id = p_incident_id
            and i.status = 'draft'
            and d.platoon_commander_id = auth.uid()
        )
      )
    ),
    false
  )
$function$;

-- ---------------------------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------------------------
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
  -- database/045: no self-join into someone else's site. A pc/medic/paramedic joins only what it
  -- can already access (assigned, opened/drafted, or - for a pc - its own platoon's draft).
  if v_role in ('pc','medic','paramedic') and not app.can_access_incident(p_incident_id) then
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
    -- database/045: pc/medic/paramedic list only incidents they can access.
    and (app.current_user_role() not in ('pc','medic','paramedic') or app.can_access_incident(i.id))
  order by (i.status = 'draft') desc, i.opened_at desc;
end;
$function$;

-- Draft resolution: same bodies as database/038 (live), plus an access check, so a pc only
-- resolves its own platoon's drafts.
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

  update incidents
  set status = 'active',
      confirmed_by = auth.uid(),
      confirmed_at = now(),
      draft_resolved_at = now(),
      opened_by = coalesce(opened_by, auth.uid()),
      metadata = metadata || jsonb_build_object('draft_resolution', 'confirmed'),
      updated_at = now(),
      version = version + 1
  where id = p_incident_id;

  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  values (p_incident_id, auth.uid(), v_role, auth.uid())
  on conflict (incident_id, profile_id) do nothing;

  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_CONFIRMED',
    jsonb_build_object('visual_id', v_inc.visual_id, 'draft_created_by', v_inc.draft_created_by),
    p_device_id, p_local_event_id);

  return jsonb_build_object('id', p_incident_id, 'status', 'active', 'changed', true);
end;
$function$;

create or replace function public.reject_draft(p_incident_id uuid, p_reason text default null, p_device_id text default null, p_local_event_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inc incidents;
begin
  if not app.is_command_role() then
    raise exception 'only command roles can reject a draft incident' using errcode = '42501';
  end if;
  if not app.can_access_incident(p_incident_id) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_inc.status = 'closed' and v_inc.metadata->>'draft_resolution' = 'rejected' then
    return jsonb_build_object('id', p_incident_id, 'status', v_inc.status, 'changed', false);
  end if;
  if v_inc.status <> 'draft' then
    raise exception 'incident % is %, not a draft', p_incident_id, v_inc.status using errcode = '42501';
  end if;
  perform set_config('app.incident_close_via_rpc', 'on', true);
  update incidents
  set status = 'closed',
      closed_by = auth.uid(),
      closed_at = now(),
      draft_resolved_at = now(),
      metadata = metadata || jsonb_build_object('draft_resolution', 'rejected',
                                                'rejection_reason', nullif(btrim(p_reason), '')),
      updated_at = now(),
      version = version + 1
  where id = p_incident_id;
  perform set_config('app.incident_close_via_rpc', '', true);
  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_DRAFT_REJECTED',
    jsonb_build_object('visual_id', v_inc.visual_id, 'reason', nullif(btrim(p_reason), ''),
                       'draft_created_by', v_inc.draft_created_by),
    p_device_id, p_local_event_id);
  return jsonb_build_object('id', p_incident_id, 'status', 'closed', 'changed', true);
end;
$function$;

create or replace function public.acknowledge_draft(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inc incidents;
begin
  if not app.is_command_role() then
    raise exception 'only command roles can acknowledge a draft incident' using errcode = '42501';
  end if;
  if not app.can_access_incident(p_incident_id) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_inc.status <> 'draft' then
    raise exception 'incident % is %, not a draft', p_incident_id, v_inc.status using errcode = '42501';
  end if;
  if v_inc.draft_acknowledged_at is null then
    update incidents
    set draft_acknowledged_by = auth.uid(),
        draft_acknowledged_at = now(),
        updated_at = now(),
        version = version + 1
    where id = p_incident_id;
  end if;
  return jsonb_build_object('id', p_incident_id, 'acknowledged', true);
end;
$function$;

-- ---------------------------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------------------------
-- A pc's membership writes: only in incidents it belongs to, only for its own platoon's
-- medics/paramedics, never itself.
create or replace function app.pc_may_manage_membership(p_incident_id uuid, p_profile_id uuid, p_role_at_incident user_role)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    app.current_user_role() = 'pc'
    and p_profile_id <> auth.uid()
    and p_role_at_incident in ('medic','paramedic')
    and app.is_incident_member(p_incident_id)
    and exists (
      select 1 from profiles p
      where p.id = p_profile_id
        and p.role in ('medic','paramedic')
        and p.platoon_commander_id = auth.uid()
    ),
    false
  )
$function$;

drop policy if exists incident_memberships_insert on incident_memberships;
create policy incident_memberships_insert on incident_memberships for insert to authenticated with check (
  app.current_user_role() = any (array['cc','chamal','admin','physician']::user_role[])
  or app.pc_may_manage_membership(incident_id, profile_id, role_at_incident)
);

drop policy if exists incident_memberships_update on incident_memberships;
create policy incident_memberships_update on incident_memberships for update to authenticated
using (
  app.current_user_role() = any (array['cc','chamal','admin','physician']::user_role[])
  or app.pc_may_manage_membership(incident_id, profile_id, role_at_incident)
)
with check (
  app.current_user_role() = any (array['cc','chamal','admin','physician']::user_role[])
  or app.pc_may_manage_membership(incident_id, profile_id, role_at_incident)
);

drop policy if exists incident_memberships_delete on incident_memberships;
create policy incident_memberships_delete on incident_memberships for delete to authenticated using (
  app.current_user_role() = any (array['cc','chamal','admin','physician']::user_role[])
  or app.pc_may_manage_membership(incident_id, profile_id, role_at_incident)
);

drop policy if exists incident_memberships_read_scoped on incident_memberships;
create policy incident_memberships_read_scoped on incident_memberships for select to authenticated using (
  profile_id = (select auth.uid())
  or app.current_user_role() = any (array['cc','chamal','admin','physician']::user_role[])
  or (app.current_user_role() = 'pc' and app.is_incident_member(incident_id))
);

-- A pc reads its own row and its own platoon's members; company-level roles read everyone.
drop policy if exists profiles_read_authenticated on profiles;
create policy profiles_read_authenticated on profiles for select to authenticated using (
  id = (select auth.uid())
  or app.current_user_role() = any (array['cc','chamal','admin','physician']::user_role[])
  or (app.current_user_role() = 'pc' and platoon_commander_id = (select auth.uid()))
);

-- Defense in depth: update/delete also require access to that incident (previously role only).
drop policy if exists incidents_update on incidents;
create policy incidents_update on incidents for update to authenticated
using (
  app.current_user_role() = any (array['pc','cc','chamal','admin','rpc','rcc','physician']::user_role[])
  and app.can_access_incident(id)
)
with check (
  app.current_user_role() = any (array['pc','cc','chamal','admin','rpc','rcc','physician']::user_role[])
  or (status = 'draft' and draft_created_by = (select auth.uid()) and app.current_user_role() = any (array['medic','paramedic']::user_role[]))
);

drop policy if exists incidents_delete on incidents;
create policy incidents_delete on incidents for delete to authenticated using (
  app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
  and app.can_access_incident(id)
);

revoke all on function app.is_incident_member(uuid) from public, anon;
grant execute on function app.is_incident_member(uuid) to authenticated;
revoke all on function app.pc_may_manage_membership(uuid, uuid, user_role) from public, anon;
grant execute on function app.pc_may_manage_membership(uuid, uuid, user_role) to authenticated;
