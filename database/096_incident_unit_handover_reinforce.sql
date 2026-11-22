-- CC moves a site to another company, or brings another company in to reinforce it (WP-27,
-- docs/GAP_CLOSURE_PLAN.md). Needs database/095 (event types) applied first.
--
-- Owner decisions, 2026-11-21:
-- - Two CC actions on a site. Handover: company A goes out, company B takes the site (B's PC,
--   RCC and rescue chain), A becomes read-only. Reinforce: B comes to help, A stays; the site
--   stays A's and A's PC stays the lead; B's PC joins as a full member.
-- - The medical "platoon" (one PC and his medics) is a company in the data model (053), so a
--   handover changes incidents.company_id. The rescue platoon is cleared (platoon_id null) and
--   B's PC or RCC chooses it with set_incident_platoon (064), as for a new site.
-- - Whole site only: no splitting a site into two incidents.
-- - Old company A after a handover, and B after its reinforcement is released: read-only (they see
--   the board and the patients, they cannot write) until the CC ends their access.
-- - Owner 2026-11-22: relief. On a handover or a release the leaving company's medical staff (pc,
--   medic, paramedic) keep writing until each one confirms he was relieved ("הוחלפתי - מסרתי",
--   confirm_incident_relief()); his own PC or the CC may confirm for him (a lost phone). Its
--   rescue chain (rcc, rpc) is read-only at once. The leaving company's PC is made a member so he
--   keeps writing although the site's company changed. "סיום גישה" relieves whoever is still
--   waiting. A paramedic reaches every incident by role (045), so he is never read-only.
-- - Every PC on a site has the same rights (owner 2026-11-22); only set_incident_platoon stays
--   with the site's own company.
-- - Who: cc, chamal, admin. The PC / RCC keep set_incident_platoon only.
-- - B's medics: B's PC assigns them with the existing assign flow (pc_may_manage_membership).
--   Nobody else of B is added; on reinforce only B's PC is.
-- - A record from a read-only phone that was offline over the change is accepted when its phone
--   time is not later than the moment that person became read-only (his relief, for medical staff) (same spirit as 068's late records after a close); a later
--   one is refused by RLS and shows on the phone as a sync rejection.
--
-- How read-only works. app.can_access_incident() now means full access: a read-only membership no
-- longer counts. Every write path (insert/update policies and the SECURITY DEFINER write RPCs)
-- already checks app.can_access_incident(), so read-only people lose writes everywhere without
-- each RPC being edited, and any later write RPC is closed to them by default. Reads go through
-- the new app.can_view_incident() = full access or read-only access:
-- - app.can_read_incident_patients() (068) and so every patient / clinical read policy,
-- - the SELECT policies that used app.can_access_incident() directly (incidents, memberships,
--   site authority, incident types, device presence, stored reports, extraction-medic requests),
-- - list_open_incidents(), get_incident_command_state(), get_incident_aar_reports().
-- events and patients inserts accept a read-only caller's record dated at or before the change
-- (app.can_write_incident_late()).
--
-- Not changed: device_presence writes stay full-access only, so a read-only phone is no longer
-- shown as working the site. The incident-opened banner (064) is not reused; B's people get their
-- own notice (list_incident_unit_notices()).

-- ---------------------------------------------------------------------------------------------
-- 1. Data
-- ---------------------------------------------------------------------------------------------
alter table incident_memberships add column if not exists read_only_since timestamptz;
alter table incident_memberships add column if not exists access_ended_at timestamptz;
alter table incident_memberships add column if not exists relief_pending_since timestamptz;
alter table incident_memberships add column if not exists relieved_by uuid references profiles(id) on delete set null;
comment on column incident_memberships.relief_pending_since is
  'Set for the leaving company''s medical staff on a handover or a release (database/096): full access until relieved (read_only_since).';
comment on column incident_memberships.relieved_by is
  'Who confirmed the relief: the member himself, his PC or the CC (database/096).';
comment on column incident_memberships.read_only_since is
  'Set when the member''s company handed the site over or its reinforcement was released (database/096): read-only from then on.';
comment on column incident_memberships.access_ended_at is
  'Set when the CC ended a read-only member''s access (database/096): no access at all.';

-- One row per company that was on the site without being its company: the old company after a
-- handover ('former'), or a company brought in to help ('reinforcing').
create table if not exists incident_unit_links (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  link_kind text not null check (link_kind in ('former','reinforcing')),
  company_id uuid not null references companies(id),
  platoon_id uuid references platoons(id),          -- former: the rescue platoon it had
  to_company_id uuid references companies(id),      -- former: the company it handed over to
  started_at timestamptz not null default now(),
  read_only_since timestamptz,                      -- former: = started_at; reinforcing: release time
  ended_at timestamptz,                             -- access ended by the CC, or the company is back on the site
  end_reason text check (end_reason in ('access_ended','returned','took_over')),
  reason text,
  created_by uuid references profiles(id) on delete set null,
  ended_by uuid references profiles(id) on delete set null,
  check (link_kind <> 'former' or (read_only_since is not null and to_company_id is not null))
);
create index if not exists idx_incident_unit_links_incident on incident_unit_links(incident_id);
create index if not exists idx_incident_unit_links_company on incident_unit_links(company_id) where ended_at is null;
create unique index if not exists uq_incident_unit_links_open
  on incident_unit_links(incident_id, company_id) where ended_at is null;
comment on table incident_unit_links is
  'Companies on a site other than its own company: former (after a handover, read-only) and reinforcing (full until released, then read-only). database/096.';

create table if not exists incident_unit_notice_acknowledgments (
  link_id uuid not null references incident_unit_links(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (link_id, profile_id)
);

alter table unit_audit drop constraint if exists unit_audit_action_check;
alter table unit_audit add constraint unit_audit_action_check check (action in (
  'company_created','company_updated','platoon_created','platoon_updated',
  'profile_unit_changed','incident_unit_changed',
  'incident_unit_handed_over','incident_unit_reinforced','incident_unit_released','incident_unit_access_ended'));

-- ---------------------------------------------------------------------------------------------
-- 2. Access helpers
-- ---------------------------------------------------------------------------------------------
-- Full access. Same as database/053 except that a read-only membership no longer counts.
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
          and im.read_only_since is null
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

-- A read-only member no longer manages memberships (pc_may_manage_membership) or counts as a member.
create or replace function app.is_incident_member(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (
    select 1 from incident_memberships im
    where im.incident_id = p_incident_id and im.profile_id = auth.uid() and im.read_only_since is null
  )
$function$;

-- Read-only access: a read-only membership not ended, or the caller's company (pc / rcc; for a
-- reinforcing company the pc only) or rescue platoon (rpc, former only) has an open read-only link.
create or replace function app.has_read_only_incident_access(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    app.current_user_role() is not null
    and (
      exists (
        select 1 from incident_memberships im
        where im.incident_id = p_incident_id and im.profile_id = auth.uid()
          and im.read_only_since is not null and im.access_ended_at is null
      )
      or (
        app.current_user_role() in ('pc','rcc') and app.my_company_id() is not null
        and exists (
          select 1 from incident_unit_links l
          where l.incident_id = p_incident_id and l.company_id = app.my_company_id()
            and l.read_only_since is not null and l.ended_at is null
            and (l.link_kind = 'former' or app.current_user_role() = 'pc')
        )
      )
      or (
        app.current_user_role() = 'rpc' and app.my_platoon_id() is not null
        and exists (
          select 1 from incident_unit_links l
          where l.incident_id = p_incident_id and l.link_kind = 'former' and l.platoon_id = app.my_platoon_id()
            and l.ended_at is null
        )
      )
    ),
    false
  )
$function$;

create or replace function app.can_view_incident(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select app.can_access_incident(p_incident_id) or app.has_read_only_incident_access(p_incident_id)
$function$;

-- A record written on a read-only caller's phone before the change reached it. Ended access still
-- counts: the record was made while the caller worked the site (068 accepts late records too).
create or replace function app.can_write_incident_late(p_incident_id uuid, p_at timestamptz)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    p_at is not null
    and app.current_user_role() is not null
    and (
      exists (
        select 1 from incident_memberships im
        where im.incident_id = p_incident_id and im.profile_id = auth.uid()
          and im.read_only_since is not null and p_at <= im.read_only_since
      )
      or (
        app.current_user_role() in ('pc','rcc') and app.my_company_id() is not null
        and exists (
          select 1 from incident_unit_links l
          where l.incident_id = p_incident_id and l.company_id = app.my_company_id()
            and l.read_only_since is not null and p_at <= l.read_only_since
            and (l.link_kind = 'former' or app.current_user_role() = 'pc')
        )
      )
      or (
        app.current_user_role() = 'rpc' and app.my_platoon_id() is not null
        and exists (
          select 1 from incident_unit_links l
          where l.incident_id = p_incident_id and l.link_kind = 'former' and l.platoon_id = app.my_platoon_id()
            and p_at <= l.read_only_since
        )
      )
    ),
    false
  )
$function$;

-- 068's rule, with read-only access counted as reading.
create or replace function app.can_read_incident_patients(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app.can_view_incident(p_incident_id)
     and (app.current_user_role() = 'admin'
          or not exists (select 1 from incidents i where i.id = p_incident_id and i.status = 'closed'))
$$;

revoke execute on function app.has_read_only_incident_access(uuid) from public, anon;
revoke execute on function app.can_view_incident(uuid) from public, anon;
revoke execute on function app.can_write_incident_late(uuid, timestamptz) from public, anon;
grant execute on function app.has_read_only_incident_access(uuid) to authenticated;
grant execute on function app.can_view_incident(uuid) to authenticated;
grant execute on function app.can_write_incident_late(uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Policies (expressions copied from the live project 2026-11-22, one call changed)
-- ---------------------------------------------------------------------------------------------
alter policy incidents_read_authenticated on incidents using (app.can_view_incident(id));
alter policy incident_site_authority_read on incident_site_authority using (app.can_view_incident(incident_id));
alter policy incident_type_reports_read on incident_type_reports using (app.can_view_incident(incident_id));
alter policy device_presence_read on device_presence using (app.can_view_incident(incident_id));
alter policy aar_read_command on aar_reports using (app.is_command_role() and app.can_view_incident(incident_id));
alter policy incident_memberships_read_scoped on incident_memberships using (
  (profile_id = (select auth.uid()))
  or (app.current_user_role() = any (array['cc','chamal','admin','physician']::user_role[]))
  or ((app.current_user_role() = 'pc'::user_role) and app.can_view_incident(incident_id))
);
alter policy medical_resource_requests_read_extraction_medic on medical_resource_requests using (
  (resource_type = 'extraction_medic')
  and (app.current_user_role() = any (array['medic','paramedic']::user_role[]))
  and app.can_view_incident(incident_id)
);

drop policy if exists events_insert_by_role on events;
create policy events_insert_by_role on events for insert to authenticated with check (
  actor_id = (select auth.uid())
  and actor_role = (select app.current_user_role())
  and (app.can_access_incident(incident_id) or app.can_write_incident_late(incident_id, local_timestamp))
  and (
    app.can_write_clinical_event(actor_role)
    or actor_role = any (array['logistics_officer','cc','chamal','admin','rpc','rcc','physician']::user_role[])
  )
  and (type <> 'PATIENT_DEATH_CONFIRMED' or actor_role in ('physician','admin'))
  and (
    type not in ('INTERVENTION_RECORDED','AIRWAY_MANAGED')
    or coalesce(payload_json->>'treatment_type','') not in ('cric','needle_decompression')
    or actor_role in ('paramedic','physician')
  )
);

-- sync-log creates the patients row with t_injury = the create event's phone time.
drop policy if exists patients_insert on patients;
create policy patients_insert on patients for insert to authenticated with check (
  (app.can_access_incident(incident_id) or app.can_write_incident_late(incident_id, t_injury))
  and app.current_user_role() = any (array['medic','pc','paramedic','rpc','rcc','admin']::user_role[])
);

alter table incident_unit_links enable row level security;
alter table incident_unit_notice_acknowledgments enable row level security;
drop policy if exists incident_unit_links_read on incident_unit_links;
create policy incident_unit_links_read on incident_unit_links for select to authenticated using (app.can_view_incident(incident_id));
drop policy if exists incident_unit_notice_ack_read on incident_unit_notice_acknowledgments;
create policy incident_unit_notice_ack_read on incident_unit_notice_acknowledgments for select to authenticated
  using (profile_id = (select auth.uid()));
-- No write policies: only the RPCs below write these tables.

-- ---------------------------------------------------------------------------------------------
-- 4. Read RPCs that checked app.can_access_incident() (bodies copied from the live project)
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_incident_command_state(p_incident_id uuid)
returns incident_command_state
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  result incident_command_state;
begin
  if not app.can_view_incident(p_incident_id)
     or coalesce(app.current_user_role()::text in ('logistics_officer','rpc','rcc'), true) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  select * into result from incident_command_state where incident_id = p_incident_id;
  return result;
end;
$function$;

create or replace function public.get_incident_aar_reports(p_incident_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_role text := app.current_user_role()::text;
  v_inc incidents;
begin
  if v_role is null then
    raise exception 'no active profile' using errcode = '42501';
  end if;
  select * into v_inc from incidents where id = p_incident_id;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if not (exists (select 1 from incident_memberships m where m.incident_id = p_incident_id and m.profile_id = auth.uid())
          or (v_role in ('pc','rcc','cc','chamal','physician','admin') and app.can_view_incident(p_incident_id))) then
    raise exception 'access denied to the reports of incident %', p_incident_id using errcode = '42501';
  end if;
  return jsonb_build_object(
    'incident_id', p_incident_id,
    'status', v_inc.status,
    'closed_at', v_inc.closed_at,
    'late_records_after_close', case when v_inc.status = 'closed' and v_inc.closed_at is not null
      then (select count(*) from events e where e.incident_id = p_incident_id and e.server_timestamp > v_inc.closed_at
              and e.type not in ('INCIDENT_CLOSED','INCIDENT_REOPENED')) else 0 end,
    'reports', coalesce((select jsonb_agg(jsonb_build_object('version', (r.report_json->>'version')::int, 'generated_at', r.generated_at, 'report', r.report_json)
                                          order by (r.report_json->>'version')::int desc, r.generated_at desc)
                         from aar_reports r where r.incident_id = p_incident_id), '[]'::jsonb));
end;
$function$;

-- Two new columns (read_only, company_id), so drop and create. is_member now means a full member.
drop function if exists public.list_open_incidents();
create function public.list_open_incidents()
returns table(id uuid, visual_id text, location_name text, address text, incident_type text, status incident_status,
              t_zero timestamptz, opened_at timestamptz, opened_by_name text, draft_acknowledged_at timestamptz,
              patient_count bigint, is_member boolean, incident_types text[], read_only boolean, company_id uuid)
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
                 where m.incident_id = i.id and m.profile_id = auth.uid() and m.read_only_since is null),
         i.incident_types,
         not app.can_access_incident(i.id),
         i.company_id
  from incidents i
  left join profiles op on op.id = i.opened_by
  left join profiles dc on dc.id = i.draft_created_by
  where i.status in ('draft','staging','active')
    -- database/045, 053: unit roles list only the sites they can reach; 096: read-only ones too.
    and (app.current_user_role() not in ('pc','rpc','rcc','medic','paramedic') or app.can_view_incident(i.id))
  order by (i.status = 'draft') desc, i.opened_at desc;
end;
$function$;
revoke execute on function public.list_open_incidents() from public, anon;
grant execute on function public.list_open_incidents() to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 5. The CC actions
-- ---------------------------------------------------------------------------------------------
create or replace function app.require_unit_change_caller()
returns void
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(app.current_user_role()::text, '') not in ('cc','chamal','admin') then
    raise exception 'only the medical company commander (cc), chamal or admin may move or reinforce a site' using errcode = '42501';
  end if;
end;
$function$;

-- Profiles of a company: placed in it directly, or (rpc) in one of its platoons.
create or replace function app.company_profile_ids(p_company_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  select p.id from profiles p left join platoons pl on pl.id = p.platoon_id
  where coalesce(p.company_id, pl.company_id) = p_company_id
$function$;

-- The leaving company's people on a site from p_at: medical staff (pc, medic, paramedic) wait for
-- relief and keep full access; rescue chain (rcc, rpc) is read-only at once. The company's active
-- PCs who are not members yet are added waiting for relief, since they lose the company scope.
create or replace function app.start_company_relief(p_incident_id uuid, p_company_id uuid, p_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_pending integer;
  v_ro integer;
  v_added integer;
begin
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by, relief_pending_since)
  select p_incident_id, p.id, 'pc', auth.uid(), p_at
  from profiles p
  where p.role = 'pc' and p.is_active and p.company_id = p_company_id
  on conflict (incident_id, profile_id) do nothing;
  get diagnostics v_added = row_count;
  update incident_memberships set relief_pending_since = p_at
  where incident_id = p_incident_id and read_only_since is null and relief_pending_since is null
    and role_at_incident in ('pc','medic','paramedic')
    and profile_id in (select app.company_profile_ids(p_company_id));
  select count(*) into v_pending from incident_memberships
  where incident_id = p_incident_id and read_only_since is null and relief_pending_since is not null
    and profile_id in (select app.company_profile_ids(p_company_id));
  update incident_memberships set read_only_since = p_at
  where incident_id = p_incident_id and read_only_since is null
    and role_at_incident in ('rcc','rpc')
    and profile_id in (select app.company_profile_ids(p_company_id));
  get diagnostics v_ro = row_count;
  return jsonb_build_object('relief_pending', v_pending, 'read_only', v_ro, 'pcs_kept', v_added);
end;
$function$;

-- A company back on a site (it takes it over, or returns): its memberships are full again.
create or replace function app.restore_company_memberships(p_incident_id uuid, p_company_id uuid)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_count integer;
begin
  update incident_memberships set read_only_since = null, access_ended_at = null, relief_pending_since = null, relieved_by = null
  where incident_id = p_incident_id and access_ended_at is null
    and (read_only_since is not null or relief_pending_since is not null)
    and profile_id in (select app.company_profile_ids(p_company_id));
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;

create or replace function app.lock_open_site(p_incident_id uuid)
returns incidents
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inc incidents;
begin
  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_inc.status not in ('active','staging') then
    raise exception 'incident % is not open', v_inc.visual_id using errcode = '22023';
  end if;
  return v_inc;
end;
$function$;

-- Handover: the site becomes company B's. A (and its rescue platoon) read-only.
create or replace function public.handover_incident_unit(p_incident_id uuid, p_company_id uuid, p_reason text,
                                                         p_device_id text default null, p_local_event_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inc incidents;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_now timestamptz := now();
  v_relief jsonb := '{}'::jsonb;
  v_back integer := 0;
  v_link uuid;
begin
  perform app.require_unit_change_caller();
  v_inc := app.lock_open_site(p_incident_id);
  if v_reason is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if p_company_id is null or not exists (select 1 from companies where id = p_company_id and is_active) then
    raise exception 'company % does not exist or is inactive', p_company_id using errcode = '22023';
  end if;
  if v_inc.company_id is not distinct from p_company_id then
    raise exception 'the site already belongs to that company' using errcode = '22023';
  end if;

  if v_inc.company_id is not null then
    insert into incident_unit_links (incident_id, link_kind, company_id, platoon_id, to_company_id, started_at,
                                     read_only_since, reason, created_by)
    values (p_incident_id, 'former', v_inc.company_id, v_inc.platoon_id, p_company_id, v_now, v_now, v_reason, auth.uid())
    returning id into v_link;
    v_relief := app.start_company_relief(p_incident_id, v_inc.company_id, v_now);
  end if;
  -- B was on the site already: as reinforcement (it takes over) or as an earlier company (it returns).
  update incident_unit_links
  set ended_at = v_now, ended_by = auth.uid(), end_reason = case when link_kind = 'reinforcing' then 'took_over' else 'returned' end
  where incident_id = p_incident_id and company_id = p_company_id and ended_at is null;
  v_back := app.restore_company_memberships(p_incident_id, p_company_id);

  -- The 053 guard checks the caller (cc/chamal/admin are unit managers) and writes unit_audit.
  update incidents set company_id = p_company_id, platoon_id = null, updated_at = v_now, version = version + 1
  where id = p_incident_id;

  perform app.write_unit_audit('incident_unit_handed_over', p_company_id, null, null, p_incident_id,
    v_inc.company_id, p_company_id, v_inc.platoon_id, null,
    jsonb_build_object('visual_id', v_inc.visual_id, 'reason', v_reason, 'relief', v_relief, 'memberships_restored', v_back));
  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_UNIT_HANDED_OVER',
    jsonb_build_object('from_company_id', v_inc.company_id, 'from_platoon_id', v_inc.platoon_id, 'to_company_id', p_company_id,
                       'reason', v_reason, 'changed_at', v_now, 'relief', v_relief, 'link_id', v_link),
    p_device_id, p_local_event_id);
  perform refresh_incident_command_state(p_incident_id);
  return jsonb_build_object('incident_id', p_incident_id, 'from_company_id', v_inc.company_id, 'to_company_id', p_company_id,
                            'changed_at', v_now, 'relief_pending', coalesce((v_relief->>'relief_pending')::int, 0),
                            'read_only', coalesce((v_relief->>'read_only')::int, 0), 'memberships_restored', v_back);
end;
$function$;

-- Reinforce: company B helps; the site stays A's. B's PC joins as a full member and assigns his medics.
create or replace function public.reinforce_incident_unit(p_incident_id uuid, p_company_id uuid, p_reason text,
                                                          p_device_id text default null, p_local_event_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inc incidents;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_now timestamptz := now();
  v_link uuid;
  v_pcs integer := 0;
  v_back integer := 0;
begin
  perform app.require_unit_change_caller();
  v_inc := app.lock_open_site(p_incident_id);
  if v_reason is null then
    raise exception 'a reason is required' using errcode = '22023';
  end if;
  if p_company_id is null or not exists (select 1 from companies where id = p_company_id and is_active) then
    raise exception 'company % does not exist or is inactive', p_company_id using errcode = '22023';
  end if;
  if v_inc.company_id is not distinct from p_company_id then
    raise exception 'the site already belongs to that company' using errcode = '22023';
  end if;
  if exists (select 1 from incident_unit_links where incident_id = p_incident_id and company_id = p_company_id
             and link_kind = 'reinforcing' and ended_at is null and read_only_since is null) then
    raise exception 'that company is already reinforcing the site' using errcode = '22023';
  end if;

  -- An earlier stay of B (former, or a released reinforcement) ends; its people are full again.
  update incident_unit_links set ended_at = v_now, ended_by = auth.uid(), end_reason = 'returned'
  where incident_id = p_incident_id and company_id = p_company_id and ended_at is null;
  v_back := app.restore_company_memberships(p_incident_id, p_company_id);

  insert into incident_unit_links (incident_id, link_kind, company_id, started_at, reason, created_by)
  values (p_incident_id, 'reinforcing', p_company_id, v_now, v_reason, auth.uid())
  returning id into v_link;

  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  select p_incident_id, p.id, 'pc', auth.uid()
  from profiles p
  where p.role = 'pc' and p.is_active and p.company_id = p_company_id
  on conflict (incident_id, profile_id) do update set read_only_since = null, access_ended_at = null, relief_pending_since = null, relieved_by = null;
  get diagnostics v_pcs = row_count;

  perform app.write_unit_audit('incident_unit_reinforced', p_company_id, null, null, p_incident_id,
    v_inc.company_id, v_inc.company_id, v_inc.platoon_id, v_inc.platoon_id,
    jsonb_build_object('visual_id', v_inc.visual_id, 'reason', v_reason, 'reinforcing_company_id', p_company_id, 'pcs_added', v_pcs));
  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_UNIT_REINFORCED',
    jsonb_build_object('company_id', p_company_id, 'site_company_id', v_inc.company_id, 'reason', v_reason,
                       'pcs_added', v_pcs, 'link_id', v_link),
    p_device_id, p_local_event_id);
  return jsonb_build_object('incident_id', p_incident_id, 'company_id', p_company_id, 'link_id', v_link,
                            'pcs_added', v_pcs, 'memberships_restored', v_back);
end;
$function$;

-- Release: the reinforcing company goes read-only.
create or replace function public.release_incident_unit(p_incident_id uuid, p_company_id uuid, p_reason text default null,
                                                        p_device_id text default null, p_local_event_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inc incidents;
  v_now timestamptz := now();
  v_link uuid;
  v_relief jsonb;
begin
  perform app.require_unit_change_caller();
  v_inc := app.lock_open_site(p_incident_id);
  update incident_unit_links set read_only_since = v_now
  where incident_id = p_incident_id and company_id = p_company_id and link_kind = 'reinforcing'
    and ended_at is null and read_only_since is null
  returning id into v_link;
  if v_link is null then
    raise exception 'that company is not reinforcing the site' using errcode = '22023';
  end if;
  v_relief := app.start_company_relief(p_incident_id, p_company_id, v_now);
  perform app.write_unit_audit('incident_unit_released', p_company_id, null, null, p_incident_id,
    v_inc.company_id, v_inc.company_id, v_inc.platoon_id, v_inc.platoon_id,
    jsonb_build_object('visual_id', v_inc.visual_id, 'reason', nullif(btrim(coalesce(p_reason,'')), ''), 'relief', v_relief));
  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_UNIT_RELEASED',
    jsonb_build_object('company_id', p_company_id, 'reason', nullif(btrim(coalesce(p_reason,'')), ''),
                       'changed_at', v_now, 'relief', v_relief, 'link_id', v_link),
    p_device_id, p_local_event_id);
  return jsonb_build_object('incident_id', p_incident_id, 'company_id', p_company_id, 'changed_at', v_now,
                            'relief_pending', (v_relief->>'relief_pending')::int, 'read_only', (v_relief->>'read_only')::int);
end;
$function$;

-- End a read-only company's access (former, or released reinforcement). Allowed on a closed site
-- too, so the CC can tidy up after the close.
create or replace function public.end_incident_unit_access(p_incident_id uuid, p_company_id uuid,
                                                           p_device_id text default null, p_local_event_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_now timestamptz := now();
  v_link uuid;
  v_members integer;
begin
  perform app.require_unit_change_caller();
  if not exists (select 1 from incidents where id = p_incident_id) then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  update incident_unit_links set ended_at = v_now, ended_by = auth.uid(), end_reason = 'access_ended'
  where incident_id = p_incident_id and company_id = p_company_id and ended_at is null and read_only_since is not null
  returning id into v_link;
  if v_link is null then
    raise exception 'that company has no read-only access to the site' using errcode = '22023';
  end if;
  -- Whoever still waits for relief is relieved now (by the CC) and ends with the rest.
  update incident_memberships set read_only_since = coalesce(read_only_since, v_now),
         relieved_by = case when read_only_since is null then auth.uid() else relieved_by end,
         access_ended_at = v_now
  where incident_id = p_incident_id and access_ended_at is null
    and (read_only_since is not null or relief_pending_since is not null)
    and profile_id in (select app.company_profile_ids(p_company_id));
  get diagnostics v_members = row_count;
  perform app.write_unit_audit('incident_unit_access_ended', p_company_id, null, null, p_incident_id,
    null, null, null, null, jsonb_build_object('members_ended', v_members, 'link_id', v_link));
  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_UNIT_ACCESS_ENDED',
    jsonb_build_object('company_id', p_company_id, 'members_ended', v_members, 'link_id', v_link),
    p_device_id, p_local_event_id);
  return jsonb_build_object('incident_id', p_incident_id, 'company_id', p_company_id, 'members_ended', v_members);
end;
$function$;

-- "הוחלפתי - מסרתי": a leaving medic (or PC, paramedic) confirms he was relieved and becomes
-- read-only. His company's PC or cc / chamal / admin may confirm for him. Records he made before
-- the confirmation are still accepted when they arrive (app.can_write_incident_late()).
create or replace function public.confirm_incident_relief(p_incident_id uuid, p_profile_id uuid default null,
                                                         p_device_id text default null, p_local_event_id text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_target uuid := coalesce(p_profile_id, auth.uid());
  v_role text := app.current_user_role()::text;
  v_target_company uuid;
  v_now timestamptz := now();
  v_done integer;
begin
  if v_role is null then
    raise exception 'no active profile' using errcode = '42501';
  end if;
  select coalesce(p.company_id, pl.company_id) into v_target_company
  from profiles p left join platoons pl on pl.id = p.platoon_id where p.id = v_target;
  if not (v_target = auth.uid()
          or v_role in ('cc','chamal','admin')
          or (v_role = 'pc' and v_target_company is not null and v_target_company = app.my_company_id())) then
    raise exception 'only the person himself, his PC or the CC may confirm his relief' using errcode = '42501';
  end if;
  update incident_memberships set read_only_since = v_now, relieved_by = auth.uid()
  where incident_id = p_incident_id and profile_id = v_target
    and relief_pending_since is not null and read_only_since is null;
  get diagnostics v_done = row_count;
  if v_done = 0 then
    raise exception 'no relief is waiting for this person on this site' using errcode = '22023';
  end if;
  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_UNIT_RELIEF_CONFIRMED',
    jsonb_build_object('profile_id', v_target, 'company_id', v_target_company, 'confirmed_by', auth.uid(),
                       'by_self', v_target = auth.uid(), 'read_only_since', v_now),
    p_device_id, p_local_event_id);
  return jsonb_build_object('incident_id', p_incident_id, 'profile_id', v_target, 'read_only_since', v_now);
end;
$function$;

-- A PC waiting for relief does not assign more medics to the site (they would never be relieved).
-- Otherwise the live definition (053/065).
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
      exists (select 1 from incident_memberships im where im.incident_id = p_incident_id and im.profile_id = auth.uid()
              and im.read_only_since is null and im.relief_pending_since is null)
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

-- ---------------------------------------------------------------------------------------------
-- 6. What the phones read
-- ---------------------------------------------------------------------------------------------
-- The site's company, every link, and the caller's own access ('full' / 'read_only').
create or replace function public.get_incident_unit_links(p_incident_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_inc incidents;
  v_full boolean := app.can_access_incident(p_incident_id);
  v_since timestamptz;
  v_role text := app.current_user_role()::text;
  v_pending timestamptz;
begin
  if not app.can_view_incident(p_incident_id) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  select * into v_inc from incidents where id = p_incident_id;
  select im.relief_pending_since into v_pending from incident_memberships im
  where im.incident_id = p_incident_id and im.profile_id = auth.uid()
    and im.relief_pending_since is not null and im.read_only_since is null;
  if not v_full then
    select min(x) into v_since from (
      select im.read_only_since as x from incident_memberships im
      where im.incident_id = p_incident_id and im.profile_id = auth.uid() and im.read_only_since is not null
      union all
      select l.read_only_since from incident_unit_links l
      where l.incident_id = p_incident_id and l.ended_at is null and l.read_only_since is not null
        and (l.company_id = app.my_company_id() or (l.link_kind = 'former' and l.platoon_id = app.my_platoon_id()))
    ) s;
  end if;
  return jsonb_build_object(
    'incident_id', p_incident_id,
    'company_id', v_inc.company_id,
    'company_name', (select name from companies where id = v_inc.company_id),
    'platoon_id', v_inc.platoon_id,
    'my_access', case when not v_full then 'read_only' when v_pending is not null then 'relief_pending' else 'full' end,
    'my_read_only_since', v_since,
    'my_relief_pending_since', v_pending,
    -- Who still waits for relief: all for cc / chamal / admin / physician, the caller's company for a pc.
    'relief_pending', coalesce((
      select jsonb_agg(jsonb_build_object('profile_id', im.profile_id, 'display_name', p.display_name,
               'role', im.role_at_incident, 'company_id', coalesce(p.company_id, pl.company_id),
               'since', im.relief_pending_since) order by im.relief_pending_since, p.display_name)
      from incident_memberships im join profiles p on p.id = im.profile_id left join platoons pl on pl.id = p.platoon_id
      where im.incident_id = p_incident_id and im.relief_pending_since is not null and im.read_only_since is null
        and (v_role in ('cc','chamal','admin','physician')
             or (v_role = 'pc' and coalesce(p.company_id, pl.company_id) = app.my_company_id())
             or im.profile_id = auth.uid())), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'kind', l.link_kind, 'company_id', l.company_id, 'company_name', c.name,
        'to_company_id', l.to_company_id, 'started_at', l.started_at, 'read_only_since', l.read_only_since,
        'ended_at', l.ended_at, 'end_reason', l.end_reason, 'reason', l.reason) order by l.started_at)
      from incident_unit_links l join companies c on c.id = l.company_id
      where l.incident_id = p_incident_id), '[]'::jsonb));
end;
$function$;

-- B's people are told once: a site handed to their company (pc, rcc, and the company's rpcs until
-- the platoon is chosen), or their company sent to reinforce one (pc). Last 12 hours, open sites.
drop function if exists public.list_incident_unit_notices();
create function public.list_incident_unit_notices()
returns table(link_id uuid, incident_id uuid, visual_id text, location_name text, kind text,
              from_company_name text, site_company_name text, at timestamptz, reason text, relief_pending integer)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_role text := app.current_user_role()::text;
  v_company uuid := app.my_company_id();
begin
  if v_role is null or v_role not in ('pc','rcc','rpc') or v_company is null then
    return;
  end if;
  return query
  select l.id, i.id, i.visual_id, i.location_name,
         case when l.link_kind = 'former' then 'handover' else 'reinforce' end,
         (select name from companies where id = l.company_id),
         (select name from companies where id = i.company_id),
         l.started_at, l.reason,
         (select count(*)::int from incident_memberships im
          where im.incident_id = i.id and im.relief_pending_since is not null and im.read_only_since is null
            and im.profile_id in (select app.company_profile_ids(l.company_id)))
  from incident_unit_links l
  join incidents i on i.id = l.incident_id
  where i.status in ('active','staging')
    and l.started_at > now() - interval '12 hours'
    and not exists (select 1 from incident_unit_notice_acknowledgments a where a.link_id = l.id and a.profile_id = auth.uid())
    and (
      (l.link_kind = 'former' and l.to_company_id = v_company and i.company_id = v_company
        and (v_role in ('pc','rcc') or (v_role = 'rpc' and (i.platoon_id is null or i.platoon_id = app.my_platoon_id()))))
      or (l.link_kind = 'reinforcing' and l.company_id = v_company and v_role = 'pc'
          and l.ended_at is null and l.read_only_since is null)
    )
  order by l.started_at desc;
end;
$function$;

create or replace function public.acknowledge_incident_unit_notice(p_link_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not exists (select 1 from public.list_incident_unit_notices() n where n.link_id = p_link_id) then
    raise exception 'no such notice for you' using errcode = '42501';
  end if;
  insert into incident_unit_notice_acknowledgments (link_id, profile_id) values (p_link_id, auth.uid())
  on conflict do nothing;
  return jsonb_build_object('link_id', p_link_id, 'acknowledged', true);
end;
$function$;

revoke all on function app.require_unit_change_caller() from public, anon, authenticated;
revoke all on function app.company_profile_ids(uuid) from public, anon, authenticated;
revoke all on function app.start_company_relief(uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function app.restore_company_memberships(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.confirm_incident_relief(uuid, uuid, text, text) from public, anon;
grant execute on function public.confirm_incident_relief(uuid, uuid, text, text) to authenticated;
revoke all on function app.lock_open_site(uuid) from public, anon, authenticated;
revoke execute on function public.handover_incident_unit(uuid, uuid, text, text, text) from public, anon;
revoke execute on function public.reinforce_incident_unit(uuid, uuid, text, text, text) from public, anon;
revoke execute on function public.release_incident_unit(uuid, uuid, text, text, text) from public, anon;
revoke execute on function public.end_incident_unit_access(uuid, uuid, text, text) from public, anon;
revoke execute on function public.get_incident_unit_links(uuid) from public, anon;
revoke execute on function public.list_incident_unit_notices() from public, anon;
revoke execute on function public.acknowledge_incident_unit_notice(uuid) from public, anon;
grant execute on function public.handover_incident_unit(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.reinforce_incident_unit(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.release_incident_unit(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.end_incident_unit_access(uuid, uuid, text, text) to authenticated;
grant execute on function public.get_incident_unit_links(uuid) to authenticated;
grant execute on function public.list_incident_unit_notices() to authenticated;
grant execute on function public.acknowledge_incident_unit_notice(uuid) to authenticated;
