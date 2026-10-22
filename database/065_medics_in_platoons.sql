-- Medics attached to a rescue platoon (V2.99.48). Structure confirmed with the repo owner
-- 2026-10-22: every medic is attached to a מ״מ (rescue platoon commander) and takes medical
-- guidance from the חוג״ד of that rescue company; every חוג״ד is attached to a מ״פ חילוץ and takes
-- medical guidance from מ״פ רפואה; the ambulance team belongs to מ״פ רפואה.
--
-- database/053 placed a medic only in a company, so "attached to platoon A1" could not be
-- recorded. This file lets a medic or paramedic be placed in a platoon (its company is then the
-- platoon's, through app.my_company_id(), which already coalesces) or directly in a company (the
-- ambulance team, which has no platoons). Not both.
--
-- What does not change (owner, 2026-10-22):
-- - A medic still reaches only sites it opened or was assigned to. Being attached to A1 does not
--   show A1's sites by itself.
-- - The company's חוג״ד may assign any medic of its company, from any of its platoons, to any
--   site of the company or any site it belongs to. Only the medic's company lookup in
--   app.pc_may_manage_membership() changes, so that a platoon-placed medic still counts as the
--   company's.
-- - open_incident(): left as live (database/064, D10), which already gives a medic's site the
--   medic's platoon once the roster sets one.
--
-- Replaces three functions from database/053: app.guard_profile_unit(),
-- public.set_profile_unit(), app.pc_may_manage_membership(). Their live bodies were checked
-- unchanged since 053 before this file was written (2026-10-22).

-- ---------------------------------------------------------------------------------------------
-- Placement rules
-- ---------------------------------------------------------------------------------------------
-- rpc: a platoon only. medic / paramedic: a platoon or a company, not both. pc / rcc / physician:
-- a company only (rcc: a rescue company). Nobody else has a unit. A role change keeps what still
-- fits the new role: a medic in A1 who becomes a pc keeps company A; one who becomes an rpc keeps
-- platoon A1. Only unit managers (or the service role / SQL editor, auth.uid() null) place
-- people; a role change may clear or carry over a unit. Every change is audited.
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
  v_platoon_company uuid;
begin
  if v_role_changed then
    if new.role = 'rpc' then
      new.company_id := null;
    elsif new.role in ('medic','paramedic') then
      null; -- a medic / paramedic keeps either a platoon or a company
    elsif new.role in ('pc','rcc','physician') then
      if new.platoon_id is not null then
        select company_id into v_platoon_company from platoons where id = new.platoon_id;
        new.company_id := coalesce(new.company_id, v_platoon_company);
      end if;
      new.platoon_id := null;
      if new.role = 'rcc' and new.company_id is not null
         and not exists (select 1 from companies where id = new.company_id and kind = 'rescue') then
        new.company_id := null;
      end if;
    else
      new.company_id := null;
      new.platoon_id := null;
    end if;
  end if;
  if new.company_id is not distinct from v_old_company and new.platoon_id is not distinct from v_old_platoon then
    return new;
  end if;
  if auth.uid() is not null and not app.is_unit_manager() and not v_role_changed then
    raise exception 'only company-level command may change units' using errcode = '42501';
  end if;
  if new.platoon_id is not null and new.role not in ('rpc','medic','paramedic') then
    raise exception 'only a מ״מ (rpc), medic or paramedic is placed in a platoon' using errcode = '22023';
  end if;
  if new.company_id is not null and new.role not in ('pc','rcc','medic','paramedic','physician') then
    raise exception 'only a pc, rcc, medic, paramedic or physician is placed in a company' using errcode = '22023';
  end if;
  if new.company_id is not null and new.platoon_id is not null then
    raise exception 'a person is placed in a platoon or in a company, not both' using errcode = '22023';
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

-- Places a person: an rpc in a platoon; a medic or paramedic in a platoon or a company; everyone
-- else in a company. Passing nulls takes the person out of their unit.
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
  if p_company_id is not null and p_platoon_id is not null then
    raise exception 'a person is placed in a platoon or in a company, not both' using errcode = '22023';
  end if;
  if v_role = 'rpc' and p_company_id is not null then
    raise exception 'a מ״מ (rpc) is placed in a platoon, not directly in a company' using errcode = '22023';
  end if;
  if v_role not in ('rpc','medic','paramedic') and p_platoon_id is not null then
    raise exception 'only a מ״מ (rpc), medic or paramedic is placed in a platoon' using errcode = '22023';
  end if;
  update profiles
  set company_id = p_company_id, platoon_id = p_platoon_id, updated_at = now(), version = version + 1
  where id = p_profile_id
    and (company_id is distinct from p_company_id or platoon_id is distinct from p_platoon_id);
  return jsonb_build_object('profile_id', p_profile_id, 'company_id', p_company_id, 'platoon_id', p_platoon_id);
end;
$function$;

-- A pc's membership writes: only its own company's medics/paramedics (placed in the company or
-- in one of its platoons), only into its company's sites or sites it belongs to, never itself.
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
      left join platoons pl on pl.id = p.platoon_id
      where p.id = p_profile_id
        and p.role in ('medic','paramedic')
        and coalesce(p.company_id, pl.company_id) = app.my_company_id()
    ),
    false
  )
$function$;

-- Grants unchanged from database/053 (create or replace keeps them); restated for a fresh database.
revoke all on function app.guard_profile_unit() from public, anon, authenticated;
revoke execute on function public.set_profile_unit(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_profile_unit(uuid, uuid, uuid) to authenticated;
