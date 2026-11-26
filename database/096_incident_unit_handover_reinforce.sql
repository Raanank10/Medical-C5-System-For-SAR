-- CC moves a site to another company, or brings another company in to reinforce it (WP-27,
-- docs/GAP_CLOSURE_PLAN.md). Needs database/095 (event types) applied first.
-- Apply with the Supabase connector (apply_migration, named 096_incident_unit_handover_reinforce)
-- after the owner's OK, never pasted into the SQL editor (.claude/skills/c5-db-change). It has no
-- statements that remove objects; it can be run twice.
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
-- longer counts. The write policies and the SECURITY DEFINER write RPCs that check
-- app.can_access_incident() close to read-only people without being edited. Live on 2026-11-25
-- four write RPCs did not check it: update_patient_identity and resolve_sync_ingestion_error checked
-- only reading, cancel_incident_false_alarm only the opener, merge_incident copied every membership
-- as full; section 7 fixes each. A new write RPC must check app.can_access_incident() itself. Reads go through
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

-- unit_audit's action check is not widened (that would mean removing the constraint first): the RPCs below write the existing
-- 'incident_unit_changed' action with detail.kind = handed_over / reinforced / released / access_ended.

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

-- sync-log reads every inserted event back (insert ... returning) and checks a record's parents
-- with the caller's own access, so a late record that events_insert_by_role accepts must also be
-- readable by its author, or it is quarantined although it was accepted (found by review
-- 2026-11-25: after "סיום גישה" a medic's records from before his relief were all refused). The
-- author may read back his own records that he was still allowed to send, nothing else.
-- Live expression of 2026-11-22 plus that one branch.
alter policy events_read_authenticated on events using (
  (
    app.can_read_incident_patients(incident_id)
    and (
      ((select app.current_user_role()) <> all (array['rpc','rcc','logistics_officer']::user_role[]))
      or (actor_id = (select auth.uid()))
      or (((select app.current_user_role()) = any (array['rpc','rcc']::user_role[]))
          and (type = any (array['INCIDENT_DRAFT_CREATED','INCIDENT_OPENED','INCIDENT_CONFIRMED','INCIDENT_DRAFT_MERGED',
            'INCIDENT_DRAFT_REJECTED','INCIDENT_CLOSED','INCIDENT_REOPENED','INCIDENT_CLOSE_TOGGLED',
            'OFFICIAL_INCIDENT_OPENED_BY_RESCUE','BUILDING_STATUS_UPDATED','SITE_CLEAR_CONFIRMED',
            'MEDIC_SITE_CLOSE_REQUESTED','PATIENT_IDENTIFIED','PATIENT_LOCATION_UPDATED','PATIENT_ACCESS_UPDATED',
            'SUPPLY_REQUEST_CREATED','SUPPLY_REQUEST_DISPATCHED','SUPPLY_REQUEST_IN_TRANSIT','SUPPLY_REQUEST_RECEIVED']::event_type[])))
      or (((select app.current_user_role()) = 'logistics_officer'::user_role)
          and (type = any (array['INCIDENT_DRAFT_CREATED','INCIDENT_OPENED','INCIDENT_CONFIRMED','INCIDENT_DRAFT_MERGED',
            'INCIDENT_DRAFT_REJECTED','INCIDENT_CLOSED','INCIDENT_REOPENED','INCIDENT_CLOSE_TOGGLED',
            'SUPPLY_REQUEST_CREATED','SUPPLY_REQUEST_DISPATCHED','SUPPLY_REQUEST_IN_TRANSIT','SUPPLY_REQUEST_RECEIVED',
            'INVENTORY_INITIALIZED','INVENTORY_TRANSFER_OUT','INVENTORY_TRANSFER_IN','PLATOON_STOCK_INITIALIZED',
            'PLATOON_STOCK_REFILLED','DIRECT_LOGO_TO_MEDIC_REFILL']::event_type[])))
    )
  )
  or (actor_id = (select auth.uid()) and app.can_write_incident_late(incident_id, local_timestamp)
      -- not in a closed incident: there 068 hides patient data from everyone but admin, and
      -- sync-log's closed path inserts without reading back (re-review 2026-11-25)
      and not exists (select 1 from incidents i where i.id = events.incident_id and i.status = 'closed'))
);

alter policy events_insert_by_role on events with check (
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
alter policy patients_insert on patients with check (
  (app.can_access_incident(incident_id) or app.can_write_incident_late(incident_id, t_injury))
  and app.current_user_role() = any (array['medic','pc','paramedic','rpc','rcc','admin']::user_role[])
);

alter table incident_unit_links enable row level security;
alter table incident_unit_notice_acknowledgments enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'incident_unit_links' and policyname = 'incident_unit_links_read') then
    create policy incident_unit_links_read on incident_unit_links for select to authenticated using (app.can_view_incident(incident_id));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'incident_unit_notice_acknowledgments' and policyname = 'incident_unit_notice_ack_read') then
    create policy incident_unit_notice_ack_read on incident_unit_notice_acknowledgments for select to authenticated
      using (profile_id = (select auth.uid()));
  end if;
end $$;
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
  -- 096: a member whose access the CC ended no longer reads the stored reports.
  if not (exists (select 1 from incident_memberships m where m.incident_id = p_incident_id and m.profile_id = auth.uid()
                  and m.access_ended_at is null)
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

-- Two new columns (read_only, company_id) change the return type, so the old function is kept under
-- another name (archived, not removed; nothing live depends on it, checked 2026-11-25) and a new one is
-- created. is_member now means a full member. Re-running: the rename is skipped once done.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'list_open_incidents' and p.pronargs = 0
               and pg_get_function_result(p.oid) not like '%read_only%') then
    alter function public.list_open_incidents() rename to list_open_incidents_pre096;
    revoke all on function public.list_open_incidents_pre096() from public, anon, authenticated;
  end if;
end $$;
create or replace function public.list_open_incidents()
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
         -- read_only only for real read-only access: a logistics officer who is not a member yet
         -- still joins as before (review 2026-11-25).
         (app.has_read_only_incident_access(i.id) and not app.can_access_incident(i.id)),
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
grant execute on function public.list_open_incidents() to authenticated, service_role;

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
  perform set_config('app.membership_relief_via_rpc', 'on', true);
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by, relief_pending_since)
  select p_incident_id, p.id, 'pc', auth.uid(), p_at
  from profiles p
  where p.role = 'pc' and p.is_active and p.company_id = p_company_id
  on conflict (incident_id, profile_id) do nothing;
  get diagnostics v_added = row_count;
  -- Keyed on the person's own role, not the membership label (a relabelled membership must not
  -- escape relief; review 2026-11-26). A logistics officer is never relieved (owner 2026-11-26).
  update incident_memberships set relief_pending_since = p_at
  where incident_id = p_incident_id and read_only_since is null and relief_pending_since is null
    and profile_id in (select p.id from profiles p where p.role in ('pc','medic','paramedic'))
    and profile_id in (select app.company_profile_ids(p_company_id));
  select count(*) into v_pending from incident_memberships
  where incident_id = p_incident_id and read_only_since is null and relief_pending_since is not null
    and profile_id in (select app.company_profile_ids(p_company_id));
  update incident_memberships set read_only_since = p_at
  where incident_id = p_incident_id and read_only_since is null
    and profile_id in (select p.id from profiles p where p.role in ('rcc','rpc'))
    and profile_id in (select app.company_profile_ids(p_company_id));
  get diagnostics v_ro = row_count;
  perform set_config('app.membership_relief_via_rpc', '', true);
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
  perform set_config('app.membership_relief_via_rpc', 'on', true);
  update incident_memberships set read_only_since = null, access_ended_at = null, relief_pending_since = null, relieved_by = null
  where incident_id = p_incident_id and access_ended_at is null
    and (read_only_since is not null or relief_pending_since is not null)
    and profile_id in (select app.company_profile_ids(p_company_id));
  get diagnostics v_count = row_count;
  perform set_config('app.membership_relief_via_rpc', '', true);
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

  perform app.write_unit_audit('incident_unit_changed', p_company_id, null, null, p_incident_id,
    v_inc.company_id, p_company_id, v_inc.platoon_id, null,
    jsonb_build_object('kind', 'handed_over', 'visual_id', v_inc.visual_id, 'reason', v_reason, 'relief', v_relief, 'memberships_restored', v_back));
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

  perform set_config('app.membership_relief_via_rpc', 'on', true);
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  select p_incident_id, p.id, 'pc', auth.uid()
  from profiles p
  where p.role = 'pc' and p.is_active and p.company_id = p_company_id
  on conflict (incident_id, profile_id) do update set read_only_since = null, access_ended_at = null, relief_pending_since = null, relieved_by = null;
  get diagnostics v_pcs = row_count;
  perform set_config('app.membership_relief_via_rpc', '', true);

  perform app.write_unit_audit('incident_unit_changed', p_company_id, null, null, p_incident_id,
    v_inc.company_id, v_inc.company_id, v_inc.platoon_id, v_inc.platoon_id,
    jsonb_build_object('kind', 'reinforced', 'visual_id', v_inc.visual_id, 'reason', v_reason, 'reinforcing_company_id', p_company_id, 'pcs_added', v_pcs));
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
  perform app.write_unit_audit('incident_unit_changed', p_company_id, null, null, p_incident_id,
    v_inc.company_id, v_inc.company_id, v_inc.platoon_id, v_inc.platoon_id,
    jsonb_build_object('kind', 'released', 'visual_id', v_inc.visual_id, 'reason', nullif(btrim(coalesce(p_reason,'')), ''), 'relief', v_relief));
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
  perform set_config('app.membership_relief_via_rpc', 'on', true);
  update incident_memberships set read_only_since = coalesce(read_only_since, v_now),
         relieved_by = case when read_only_since is null then auth.uid() else relieved_by end,
         access_ended_at = v_now
  where incident_id = p_incident_id and access_ended_at is null
    and (read_only_since is not null or relief_pending_since is not null)
    and profile_id in (select app.company_profile_ids(p_company_id));
  get diagnostics v_members = row_count;
  perform set_config('app.membership_relief_via_rpc', '', true);
  perform app.write_unit_audit('incident_unit_changed', p_company_id, null, null, p_incident_id,
    null, null, null, null, jsonb_build_object('kind', 'access_ended', 'company_id', p_company_id, 'members_ended', v_members, 'link_id', v_link));
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
  perform set_config('app.membership_relief_via_rpc', 'on', true);
  update incident_memberships set read_only_since = v_now, relieved_by = auth.uid()
  where incident_id = p_incident_id and profile_id = v_target
    and relief_pending_since is not null and read_only_since is null;
  get diagnostics v_done = row_count;
  perform set_config('app.membership_relief_via_rpc', '', true);
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
create or replace function public.list_incident_unit_notices()
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

-- Everyone still waiting for relief on open sites the caller commands: all for cc / chamal / admin,
-- the sites of his company for a pc (the PC who leads the site: B after a handover, A after a
-- release). The phone alerts once someone has waited 30 minutes (reliefOverdueMinutes in
-- src/domain/rules.js, owner 2026-11-23); the rows come back until he is relieved or his access ends.
create or replace function public.list_pending_reliefs()
returns table(incident_id uuid, visual_id text, location_name text, profile_id uuid, display_name text,
              role_at_incident user_role, company_name text, pending_since timestamptz, server_now timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_role text := app.current_user_role()::text;
  v_company uuid := app.my_company_id();
begin
  if v_role is null or v_role not in ('cc','chamal','admin','pc') or (v_role = 'pc' and v_company is null) then
    return;
  end if;
  return query
  select i.id, i.visual_id, i.location_name, im.profile_id, p.display_name, im.role_at_incident,
         (select c.name from companies c where c.id = coalesce(p.company_id, pl.company_id)),
         im.relief_pending_since, now()
  from incident_memberships im
  join incidents i on i.id = im.incident_id
  join profiles p on p.id = im.profile_id
  left join platoons pl on pl.id = p.platoon_id
  where im.relief_pending_since is not null and im.read_only_since is null
    and i.status in ('active','staging')
    and (v_role in ('cc','chamal','admin') or i.company_id = v_company)
  order by im.relief_pending_since, i.visual_id, p.display_name;
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


-- ---------------------------------------------------------------------------------------------
-- 7. Write RPCs that checked only reading (review 2026-11-25). Each body is the live one of
--    2026-11-25 (md5 checked against a local copy before the edit), with one change each.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_patient_identity(p_patient_id uuid, p_name text, p_identifying_description text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_incident_id uuid;
begin
  select incident_id into v_incident_id from patients where id = p_patient_id;
  if v_incident_id is null then
    raise exception 'patient % not found' , p_patient_id using errcode = 'P0002';
  end if;
  -- 096: reading is not enough to write; a read-only or relieved person may not change identity.
  if not (app.can_read_incident_patients(v_incident_id) and app.can_access_incident(v_incident_id)) then
    raise exception 'access denied to incident % (closed incidents: report only; read-only after a handover)', v_incident_id using errcode = '42501';
  end if;
  if app.current_user_role() not in ('medic','paramedic','pc','cc','physician','chamal','admin') then
    raise exception 'role % may not write patient identity', app.current_user_role() using errcode = '42501';
  end if;
  update patients
  set optional_name = p_name,
      identifying_description = p_identifying_description,
      updated_at = now(),
      version = version + 1
  where id = p_patient_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.resolve_sync_ingestion_error(p_id uuid, p_reason text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text := app.current_user_role()::text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_row sync_ingestion_errors;
begin
  if v_role is null or v_role not in ('pc', 'cc', 'chamal', 'physician', 'admin') then
    raise exception 'only command roles may close a sync rejection' using errcode = '42501';
  end if;
  if p_reason is null or p_reason not in ('resent', 'duplicate', 'test_data', 'not_recoverable', 'other') then
    raise exception 'unknown reason %', p_reason using errcode = '22023';
  end if;
  if p_reason in ('not_recoverable', 'other') and v_note is null then
    raise exception 'a note is required for reason %', p_reason using errcode = '22023';
  end if;

  select * into v_row from sync_ingestion_errors where id = p_id for update;
  if not found then
    raise exception 'sync rejection % not found', p_id using errcode = 'P0002';
  end if;
  if v_row.incident_id is null then
    if v_role <> 'admin' then
      raise exception 'a rejection with no incident is closed by admin only' using errcode = '42501';
    end if;
  -- 096: a read-only PC (his company handed the site over) does not close the new company's rejections.
  elsif not (app.can_read_incident_patients(v_row.incident_id) and app.can_access_incident(v_row.incident_id)) then
    raise exception 'no access to this incident' using errcode = '42501';
  end if;
  if v_row.resolved_at is not null then
    return jsonb_build_object('id', v_row.id, 'changed', false, 'resolved_at', v_row.resolved_at);
  end if;

  update sync_ingestion_errors
  set resolved_at = now(),
      resolved_by = auth.uid(),
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      resolution_notes = left(p_reason || coalesce(': ' || v_note, ''), 500)
  where id = p_id
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'changed', true, 'resolved_at', v_row.resolved_at, 'reason', p_reason);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.cancel_incident_false_alarm(p_incident_id uuid, p_reason text DEFAULT NULL::text, p_device_id text DEFAULT NULL::text, p_local_event_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- 096: an opener whose company handed the site over may no longer cancel it.
  if not app.can_access_incident(p_incident_id) then
    raise exception 'no write access to incident % (read-only after a handover)', p_incident_id using errcode = '42501';
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
$function$
;

CREATE OR REPLACE FUNCTION public.merge_incident(p_source_id uuid, p_target_id uuid, p_reason text, p_device_id text DEFAULT NULL::text, p_local_event_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text := app.current_user_role()::text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_src incidents;
  v_tgt incidents;
  v_suffix text;
  v_new text;
  v_n int;
  v_count int;
  v_renames jsonb := '[]'::jsonb;
  v_moved jsonb := '{}'::jsonb;
  v_pre_evac_kept boolean := false;
  r record;
begin
  if v_role is null or v_role not in ('cc', 'chamal', 'admin') then
    raise exception 'only company-level command (cc, chamal, admin) may merge incidents' using errcode = '42501';
  end if;
  if p_source_id is null or p_target_id is null or p_source_id = p_target_id then
    raise exception 'choose two different incidents' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'a reason is required to merge incidents' using errcode = '22023';
  end if;

  perform 1 from incidents where id in (p_source_id, p_target_id) order by id for update;
  select * into v_src from incidents where id = p_source_id;
  if not found then
    raise exception 'incident % not found', p_source_id using errcode = 'P0002';
  end if;
  select * into v_tgt from incidents where id = p_target_id;
  if not found then
    raise exception 'incident % not found', p_target_id using errcode = 'P0002';
  end if;
  if v_src.status = 'closed' and v_src.metadata->'merged_into'->>'target_id' = p_target_id::text then
    return jsonb_build_object('source_id', p_source_id, 'target_id', p_target_id, 'changed', false);
  end if;
  if v_src.status not in ('active', 'staging') then
    raise exception 'incident % is %: only an open incident can be merged', v_src.visual_id, v_src.status using errcode = '42501';
  end if;
  if v_tgt.status not in ('active', 'staging') then
    raise exception 'incident % is %: merge into an open incident', v_tgt.visual_id, v_tgt.status using errcode = '42501';
  end if;

  v_suffix := upper(right(regexp_replace(coalesce(v_src.visual_id, p_source_id::text), '[^A-Za-z0-9]', '', 'g'), 4));
  for r in
    select p.id, p.visual_id from patients p
    where p.incident_id = p_source_id
      and exists (select 1 from patients t where t.incident_id = p_target_id and t.visual_id = p.visual_id)
    order by p.created_at, p.id
  loop
    v_new := r.visual_id || '-' || v_suffix;
    v_n := 1;
    while exists (select 1 from patients where incident_id in (p_source_id, p_target_id) and visual_id = v_new) loop
      v_n := v_n + 1;
      v_new := r.visual_id || '-' || v_suffix || '-' || v_n;
    end loop;
    update patients set visual_id = v_new, updated_at = now(), version = version + 1 where id = r.id;
    v_renames := v_renames || jsonb_build_object('patient_id', r.id, 'from', r.visual_id, 'to', v_new);
  end loop;

  for r in
    select s.id as src_sector, t.id as tgt_sector from sectors s
    join sectors t on t.incident_id = p_target_id
      and t.building_no is not distinct from s.building_no and t.floor is not distinct from s.floor
      and t.apartment is not distinct from s.apartment and t.room is not distinct from s.room
    where s.incident_id = p_source_id
  loop
    update patients set sector_id = r.tgt_sector where sector_id = r.src_sector;
    update aar_context_notes set sector_id = r.tgt_sector where sector_id = r.src_sector;
  end loop;
  update sectors s set incident_id = p_target_id
  where s.incident_id = p_source_id
    and not exists (select 1 from sectors t where t.incident_id = p_target_id
      and t.building_no is not distinct from s.building_no and t.floor is not distinct from s.floor
      and t.apartment is not distinct from s.apartment and t.room is not distinct from s.room);
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('sectors', v_count);

  update patients set incident_id = p_target_id, updated_at = now(), version = version + 1 where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('patients', v_count);

  update tourniquets set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('tourniquets', v_count);
  update external_reports set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('external_reports', v_count);
  update supply_requests set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('supply_requests', v_count);
  update medical_resource_requests set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('medical_resource_requests', v_count);
  update inventory_ledger_v12 set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('inventory_ledger', v_count);
  update inventory_ledger_v11_archived set incident_id = p_target_id where incident_id = p_source_id;
  update death_confirmations set incident_id = p_target_id where incident_id = p_source_id;
  update conflict_log set incident_id = p_target_id where incident_id = p_source_id;
  update aar_context_notes set incident_id = p_target_id where incident_id = p_source_id;
  update patient_handover_tokens set incident_id = p_target_id where incident_id = p_source_id;
  update sync_ingestion_errors set incident_id = p_target_id where incident_id = p_source_id;

  update watchdog_alerts s set resolved_at = now(), updated_at = now(),
         payload_json = coalesce(s.payload_json, '{}'::jsonb) || jsonb_build_object('resolved_by_merge', p_target_id)
  where s.incident_id = p_source_id and s.resolved_at is null and s.dedupe_key is not null
    and exists (select 1 from watchdog_alerts t where t.incident_id = p_target_id and t.resolved_at is null
      and t.alert_type = s.alert_type and t.dedupe_key = s.dedupe_key
      and t.patient_id is not distinct from s.patient_id and t.actor_id is not distinct from s.actor_id);
  update watchdog_alerts set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('watchdog_alerts', v_count);

  -- 096: only full memberships move as full, and a wait for relief moves with them. A read-only or
  -- ended member of the duplicate must not get access to the target (review 2026-11-25): he is
  -- copied with his access ended, so he does not see the target but his records from before his
  -- relief, redirected here by sync-log (067), are still accepted (re-review 2026-11-25). The
  -- duplicate's read-only companies lose their view with it (owner 2026-11-22: links left as is).
  perform set_config('app.membership_relief_via_rpc', 'on', true);
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by, relief_pending_since)
  select p_target_id, m.profile_id, m.role_at_incident, coalesce(m.assigned_by, auth.uid()), m.relief_pending_since
  from incident_memberships m where m.incident_id = p_source_id
    and m.read_only_since is null and m.access_ended_at is null
  on conflict (incident_id, profile_id) do nothing;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('memberships_added', v_count);
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by, read_only_since, access_ended_at, relieved_by)
  select p_target_id, m.profile_id, m.role_at_incident, coalesce(m.assigned_by, auth.uid()), m.read_only_since,
         coalesce(m.access_ended_at, now()), m.relieved_by
  from incident_memberships m where m.incident_id = p_source_id
    and m.read_only_since is not null
  on conflict (incident_id, profile_id) do nothing;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('memberships_late_records_only', v_count);
  perform set_config('app.membership_relief_via_rpc', '', true);
  update device_presence s set incident_id = p_target_id
  where s.incident_id = p_source_id
    and not exists (select 1 from device_presence t where t.incident_id = p_target_id and t.actor_id = s.actor_id and t.device_id = s.device_id);

  if exists (select 1 from incident_site_authority where incident_id = p_source_id) then
    if not exists (select 1 from incident_site_authority where incident_id = p_target_id) then
      update incident_site_authority set incident_id = p_target_id, updated_at = now() where incident_id = p_source_id;
    else
      update incident_site_authority t set
        official_t0 = case when t.official_t0 is null or (s.official_t0 is not null and s.official_t0 < t.official_t0) then s.official_t0 else t.official_t0 end,
        official_by_role = case when t.official_t0 is null or (s.official_t0 is not null and s.official_t0 < t.official_t0) then s.official_by_role else t.official_by_role end,
        official_by_name = case when t.official_t0 is null or (s.official_t0 is not null and s.official_t0 < t.official_t0) then s.official_by_name else t.official_by_name end,
        official_at = case when t.official_t0 is null or (s.official_t0 is not null and s.official_t0 < t.official_t0) then s.official_at else t.official_at end,
        building_status = case when s.building_status_at is not null and (t.building_status_at is null or s.building_status_at > t.building_status_at) then s.building_status else t.building_status end,
        building_status_by_role = case when s.building_status_at is not null and (t.building_status_at is null or s.building_status_at > t.building_status_at) then s.building_status_by_role else t.building_status_by_role end,
        building_status_by_name = case when s.building_status_at is not null and (t.building_status_at is null or s.building_status_at > t.building_status_at) then s.building_status_by_name else t.building_status_by_name end,
        building_status_at = case when s.building_status_at is not null and (t.building_status_at is null or s.building_status_at > t.building_status_at) then s.building_status_at else t.building_status_at end,
        site_cleared_at = coalesce(t.site_cleared_at, s.site_cleared_at),
        site_cleared_by_role = case when t.site_cleared_at is null then s.site_cleared_by_role else t.site_cleared_by_role end,
        site_cleared_by_name = case when t.site_cleared_at is null then s.site_cleared_by_name else t.site_cleared_by_name end,
        updated_at = now()
      from incident_site_authority s
      where t.incident_id = p_target_id and s.incident_id = p_source_id;
    end if;
  end if;

  if exists (select 1 from incident_pre_evacuations where incident_id = p_source_id) then
    if not exists (select 1 from incident_pre_evacuations where incident_id = p_target_id) then
      update incident_pre_evacuations set incident_id = p_target_id, updated_at = now() where incident_id = p_source_id;
    else
      v_pre_evac_kept := true;
    end if;
  end if;

  perform set_config('app.incident_merge_via_rpc', 'on', true);
  update events set origin_incident_id = coalesce(origin_incident_id, incident_id), incident_id = p_target_id
  where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('events', v_count);
  perform set_config('app.incident_merge_via_rpc', '', true);

  perform set_config('app.incident_close_via_rpc', 'on', true);
  update incidents
  set status = 'closed', closed_by = auth.uid(), closed_at = now(),
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('merged_into', jsonb_build_object(
        'target_id', p_target_id, 'target_visual_id', v_tgt.visual_id, 'at', now(), 'by', auth.uid(), 'reason', v_reason)),
      updated_at = now(), version = version + 1
  where id = p_source_id;
  perform set_config('app.incident_close_via_rpc', '', true);

  perform app.append_incident_lifecycle_event(p_source_id, 'INCIDENT_CLOSED',
    jsonb_build_object('visual_id', v_src.visual_id, 'merged_into', p_target_id, 'merged_into_visual_id', v_tgt.visual_id,
                       'reason', v_reason, 'open_patient_count', 0),
    p_device_id, nullif(coalesce(p_local_event_id, '') || case when p_local_event_id is null then '' else '-source' end, ''));
  perform app.append_incident_lifecycle_event(p_target_id, 'INCIDENT_MERGED',
    jsonb_build_object('source_id', p_source_id, 'source_visual_id', v_src.visual_id, 'source_location_name', v_src.location_name,
                       'reason', v_reason, 'moved', v_moved, 'renamed_patients', v_renames,
                       'pre_evacuation_kept_on_source', v_pre_evac_kept),
    p_device_id, p_local_event_id);

  perform refresh_incident_command_state(p_source_id);
  perform refresh_incident_command_state(p_target_id);

  return jsonb_build_object('source_id', p_source_id, 'target_id', p_target_id, 'target_visual_id', v_tgt.visual_id,
                            'changed', true, 'moved', v_moved, 'renamed_patients', v_renames,
                            'pre_evacuation_kept_on_source', v_pre_evac_kept);
end;
$function$
;


-- ---------------------------------------------------------------------------------------------
-- 8. Who may change the relief fields directly (owner 2026-11-26; review 2026-11-26)
-- ---------------------------------------------------------------------------------------------
-- The 045 policies let cc, chamal, admin and physician (and a PC for his own medics) insert, update
-- and delete incident_memberships through the API. Owner 2026-11-26: only the CC or chamal edit the
-- relief fields (read_only_since, access_ended_at, relief_pending_since, relieved_by) directly;
-- everyone else changes them only through the 096 functions, which mark their writes with
-- app.membership_relief_via_rpc (transaction-local, the same pattern as 053's
-- app.incident_unit_via_rpc; the API cannot set it). Re-assigning a medic (the client's upsert,
-- which never sends the relief fields) gives him full access back when the PC of his company, the
-- CC or chamal does it; for anyone else it is refused instead of silently changing nothing. Deleting
-- a membership that carries relief fields is CC / chamal only: it would undo a relief, and the row
-- is what lets his records from before the relief in. Every such change is written to unit_audit.
create or replace function app.guard_membership_relief_fields()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := app.current_user_role()::text;
  v_row incident_memberships;
  v_locked boolean := false;
  v_kind text;
  v_before jsonb;
begin
  -- Only API writes are checked: the session role is `authenticated` for every PostgREST call, also
  -- inside a SECURITY DEFINER function, while migrations, the owner and service_role are not. The
  -- 096 functions mark their own writes.
  if coalesce(current_setting('role', true), '') not in ('authenticated', 'anon')
     or coalesce(current_setting('app.membership_relief_via_rpc', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    v_row := old;
  else
    v_row := new;
  end if;
  if tg_op <> 'INSERT' then
    v_locked := old.read_only_since is not null or old.access_ended_at is not null
                or old.relief_pending_since is not null or old.relieved_by is not null;
    v_before := jsonb_build_object('read_only_since', old.read_only_since, 'access_ended_at', old.access_ended_at,
                                   'relief_pending_since', old.relief_pending_since, 'relieved_by', old.relieved_by);
  end if;
  if tg_op = 'DELETE' then
    if v_locked then
      if coalesce(v_role, '') not in ('cc', 'chamal') then
        raise exception 'only the CC or chamal may remove a membership that carries relief fields' using errcode = '42501';
      end if;
      v_kind := 'membership_with_relief_removed';
    end if;
  elsif tg_op = 'INSERT' then
    if new.read_only_since is not null or new.access_ended_at is not null
       or new.relief_pending_since is not null or new.relieved_by is not null then
      if coalesce(v_role, '') not in ('cc', 'chamal') then
        raise exception 'only the CC or chamal may set relief fields on a site membership' using errcode = '42501';
      end if;
      v_kind := 'relief_fields_set';
    end if;
  elsif new.read_only_since is distinct from old.read_only_since
     or new.access_ended_at is distinct from old.access_ended_at
     or new.relief_pending_since is distinct from old.relief_pending_since
     or new.relieved_by is distinct from old.relieved_by then
    if coalesce(v_role, '') not in ('cc', 'chamal') then
      raise exception 'only the CC or chamal may change relief fields on a site membership' using errcode = '42501';
    end if;
    v_kind := 'relief_fields_edited';
  elsif v_locked and (new.assigned_by is distinct from old.assigned_by or new.created_at is distinct from old.created_at
                      or new.role_at_incident is distinct from old.role_at_incident) then
    -- A re-assignment (or a role change) of someone relieved: the PC of his company (the policy
    -- already limits a PC to that), the CC or chamal give him full access back.
    if coalesce(v_role, '') not in ('pc', 'cc', 'chamal') then
      raise exception 'only the CC, chamal or his own PC can give a relieved member access back' using errcode = '42501';
    end if;
    new.read_only_since := null;
    new.access_ended_at := null;
    new.relief_pending_since := null;
    new.relieved_by := null;
    v_kind := 'access_restored_by_assignment';
  end if;
  if v_kind is not null then
    perform app.write_unit_audit('incident_unit_changed',
      (select coalesce(p.company_id, pl.company_id) from profiles p left join platoons pl on pl.id = p.platoon_id where p.id = v_row.profile_id),
      null, v_row.profile_id, v_row.incident_id, null, null, null, null,
      jsonb_build_object('kind', v_kind, 'role_at_incident', v_row.role_at_incident,
        'by_role', v_role, 'before', v_before));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function app.guard_membership_relief_fields() from public, anon, authenticated;
do $$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.incident_memberships'::regclass
                 and tgname = 'trg_guard_membership_relief_fields') then
    create trigger trg_guard_membership_relief_fields
      before insert or update or delete on incident_memberships
      for each row execute function app.guard_membership_relief_fields();
  end if;
end $$;

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
revoke execute on function public.list_pending_reliefs() from public, anon;
grant execute on function public.list_pending_reliefs() to authenticated;
revoke execute on function public.acknowledge_incident_unit_notice(uuid) from public, anon;
grant execute on function public.handover_incident_unit(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.reinforce_incident_unit(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.release_incident_unit(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.end_incident_unit_access(uuid, uuid, text, text) to authenticated;
grant execute on function public.get_incident_unit_links(uuid) to authenticated;
grant execute on function public.list_incident_unit_notices() to authenticated;
grant execute on function public.acknowledge_incident_unit_notice(uuid) to authenticated;
