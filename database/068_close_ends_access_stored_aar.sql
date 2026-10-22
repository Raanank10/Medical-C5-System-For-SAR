-- Closing an incident ends patient access and stores an after-action report (decision D9;
-- docs/GAP_CLOSURE_PLAN.md WP-16 PR A, V2.99.51).
--
-- Owner, 2026-10-22: closing ends access to the incident's patients for everyone but admin; a
-- statistics-only report (no names, no identifying descriptions, patients by temporary number
-- only) is stored automatically on every close; command and everyone who worked the incident read
-- the report instead. Reopening restores access by status alone; the next close stores a new
-- report version and keeps the old one. Details decided the same day:
-- - records that reach the server after the close (an offline phone) are accepted and stored,
--   never refused; their author cannot read them back; the report readers are told how many
--   arrived after the close (a reopen and close makes a complete version);
-- - report readers: the incident's members, and the command roles that reach the incident
--   (pc / rcc of its company, cc, chamal, physician, admin);
-- - phones remove the incident's patients from local storage once everything they recorded has
--   synced (client side, index.html).
-- Names and identifying descriptions are still erased only by the manual finalize (command), as
-- before; finalize stays allowed on a closed incident.
--
-- 1. app.can_read_incident_patients(id): app.can_access_incident(id), and the incident is not
--    closed unless the caller is admin. Every SELECT policy on a table that holds patient or
--    clinical data now uses it instead of app.can_access_incident() (ALTER POLICY, nothing
--    dropped). Insert policies are unchanged, so late records are accepted. Tables about the
--    incident itself (incidents, memberships, site authority, device presence, open-incident
--    acknowledgments) keep their policies: a member still sees that the incident is closed.
--    The views are security_invoker, so they follow the tables.
-- 2. Two SECURITY DEFINER functions that read patient tables for a caller check it too:
--    get_supply_request_queue() and update_patient_identity() (no identity edits on a closed
--    incident except by admin). get_incident_command_state() returns counts only and is kept.
-- 3. app.build_incident_aar(id) builds the report from the incident's own tables; a trigger on the
--    change to 'closed' stores it in aar_reports (locked, with its version). Not for a duplicate
--    closed by merge_incident() (its data moved to the target). The trigger never raises: a
--    failed report must not block a close.
-- 4. get_incident_aar_reports(id): the stored versions, newest first, plus how many events
--    arrived after the latest close. Clients no longer write aar_reports directly.
--
-- Applied live 2026-10-22 in two parts: 068_close_ends_access_stored_aar (sections 1-2) and
-- 068b_stored_aar_report (sections 3-4); this file is the combined result.

create or replace function app.can_read_incident_patients(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select app.can_access_incident(p_incident_id)
     and (app.current_user_role() = 'admin'
          or not exists (select 1 from incidents i where i.id = p_incident_id and i.status = 'closed'))
$$;
revoke execute on function app.can_read_incident_patients(uuid) from public, anon;
grant execute on function app.can_read_incident_patients(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- 1. Read policies on patient and clinical tables
-- ---------------------------------------------------------------------------------------------
alter policy patients_read_authenticated on patients using (app.can_read_incident_patients(incident_id));
alter policy tourniquets_read on tourniquets using (app.can_read_incident_patients(incident_id));
alter policy watchdog_read_authenticated on watchdog_alerts using (app.can_read_incident_patients(incident_id));
alter policy death_confirmations_read on death_confirmations
  using (app.can_read_incident_patients(incident_id) and (app.is_command_role() or actor_id = (select auth.uid())));
alter policy high_risk_override_read on high_risk_override_confirmations
  using (app.can_read_incident_patients(incident_id) and (app.is_command_role() or actor_id = (select auth.uid())));
alter policy medical_resource_requests_read on medical_resource_requests
  using (app.can_read_incident_patients(incident_id)
         and (app.current_user_role() = any (array['pc','cc','chamal','physician','admin']::user_role[]) or requested_by = auth.uid()));
alter policy supply_requests_read_authenticated on supply_requests using (app.can_read_incident_patients(incident_id));
alter policy supply_request_items_read on supply_request_items
  using (exists (select 1 from supply_requests sr where sr.id = supply_request_items.supply_request_id and app.can_read_incident_patients(sr.incident_id)));
alter policy external_reports_read on external_reports using (app.can_read_incident_patients(incident_id));
alter policy external_patient_links_read on external_patient_links
  using (exists (select 1 from external_reports er where er.id = external_patient_links.external_report_id and app.can_read_incident_patients(er.incident_id)));
alter policy inventory_ledger_v12_read on inventory_ledger_v12 using (incident_id is null or app.can_read_incident_patients(incident_id));
alter policy inventory_read_authenticated on inventory_ledger_v11_archived using (incident_id is null or app.can_read_incident_patients(incident_id));
alter policy pre_evacuations_read on incident_pre_evacuations using (app.can_read_incident_patients(incident_id));
alter policy conflict_read_command on conflict_log using (app.is_command_role() and app.can_read_incident_patients(incident_id));
alter policy patient_edit_conflicts_read on patient_edit_conflicts using (app.is_command_role() and app.can_read_incident_patients(incident_id));
alter policy aar_context_notes_read_command on aar_context_notes using (app.is_command_role() and app.can_read_incident_patients(incident_id));
alter policy sectors_read_authenticated on sectors using (app.can_read_incident_patients(incident_id));
alter policy sync_ingestion_errors_read_command on sync_ingestion_errors
  using (app.is_command_role() and (incident_id is null or app.can_read_incident_patients(incident_id)));
alter policy experiment_observer_notes_read on experiment_observer_notes using (app.can_read_incident_patients(incident_id));
alter policy events_read_authenticated on events using (
  app.can_read_incident_patients(incident_id)
  and (((select app.current_user_role()) <> all (array['rpc','rcc']::user_role[]))
       or actor_id = (select auth.uid())
       or type = any (array['INCIDENT_DRAFT_CREATED','INCIDENT_OPENED','INCIDENT_CONFIRMED','INCIDENT_DRAFT_MERGED',
         'INCIDENT_DRAFT_REJECTED','INCIDENT_CLOSED','INCIDENT_REOPENED','INCIDENT_CLOSE_TOGGLED',
         'OFFICIAL_INCIDENT_OPENED_BY_RESCUE','BUILDING_STATUS_UPDATED','SITE_CLEAR_CONFIRMED','MEDIC_SITE_CLOSE_REQUESTED',
         'SITE_PRE_EVACUATION_REPORTED','FIRST_RESPONDER_REPORT','PATIENT_IDENTIFIED','PATIENT_LOCATION_UPDATED',
         'PATIENT_ACCESS_UPDATED','PATIENT_TRIAGE_UPDATED','PATIENT_TRIAGED_EXPECTANT','PATIENT_STATUS_UPDATED',
         'PATIENT_EVACUATION_UPDATED','TOURNIQUET_APPLIED','TOURNIQUET_RELEASED','EXTERNAL_REPORT_CREATED',
         'EXTERNAL_REPORT_LINKED','SUPPLY_REQUEST_CREATED','SUPPLY_REQUEST_DISPATCHED','SUPPLY_REQUEST_IN_TRANSIT',
         'SUPPLY_REQUEST_RECEIVED']::event_type[])));

-- Stored reports are written only by the trigger below (SECURITY DEFINER), never by a client.
alter policy aar_write_insert on aar_reports with check (false);
alter policy aar_write_update on aar_reports using (false) with check (false);
alter policy aar_write_delete on aar_reports using (false);

-- ---------------------------------------------------------------------------------------------
-- 2. SECURITY DEFINER readers and writers of patient data
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_supply_request_queue(p_incident_id uuid)
returns setof supply_requests
language plpgsql
stable security definer
set search_path to 'public'
as $function$
begin
  if not app.can_read_incident_patients(p_incident_id) then
    raise exception 'access denied to incident % (closed incidents: report only)', p_incident_id using errcode = '42501';
  end if;
  return query
    select * from supply_requests
    where incident_id = p_incident_id
    order by requested_at desc;
end;
$function$;

create or replace function public.update_patient_identity(p_patient_id uuid, p_name text, p_identifying_description text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_incident_id uuid;
begin
  select incident_id into v_incident_id from patients where id = p_patient_id;
  if v_incident_id is null then
    raise exception 'patient % not found' , p_patient_id using errcode = 'P0002';
  end if;

  if not app.can_read_incident_patients(v_incident_id) then
    raise exception 'access denied to incident % (closed incidents: report only)', v_incident_id using errcode = '42501';
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
$function$;

-- ---------------------------------------------------------------------------------------------
-- 3. The report
-- ---------------------------------------------------------------------------------------------
-- Statistics only. Patients appear by temporary number (visual_id); never optional_name or
-- identifying_description. Minutes are counted from the incident's opening.
create or replace function app.build_incident_aar(p_incident_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_inc incidents;
  v_t0 timestamptz;
  v_end timestamptz;
begin
  select * into v_inc from incidents where id = p_incident_id;
  if not found then
    return null;
  end if;
  v_t0 := coalesce(v_inc.opened_at, v_inc.t_zero);
  v_end := coalesce(v_inc.closed_at, now());

  return jsonb_build_object(
    'kind', 'incident_aar_statistics',
    'generated_at', now(),
    'incident', jsonb_build_object(
      'visual_id', v_inc.visual_id,
      'location_name', v_inc.location_name,
      'incident_type', v_inc.incident_type,
      'opened_at', v_t0,
      'closed_at', v_inc.closed_at,
      'duration_minutes', round(extract(epoch from (v_end - v_t0)) / 60),
      'company', (select c.name from companies c where c.id = v_inc.company_id),
      'platoon', (select pl.name from platoons pl where pl.id = v_inc.platoon_id),
      'false_alarm', app.is_false_alarm_close(v_inc),
      'closed_with_override', coalesce(v_inc.metadata ? 'close_override', false)),
    'patients', jsonb_build_object(
      'total', (select count(*) from patients p where p.incident_id = p_incident_id),
      'by_triage', coalesce((select jsonb_object_agg(t, n) from (select coalesce(current_triage::text, 'unknown') t, count(*) n from patients where incident_id = p_incident_id group by 1) x), '{}'::jsonb),
      'by_status', coalesce((select jsonb_object_agg(s, n) from (select coalesce(current_status::text, 'unknown') s, count(*) n from patients where incident_id = p_incident_id group by 1) x), '{}'::jsonb),
      'pediatric', (select count(*) from patients where incident_id = p_incident_id and is_pediatric),
      'still_needing_full_assessment', (select count(*) from patients where incident_id = p_incident_id and needs_full_assessment),
      'with_vitals', (select count(*) from patients where incident_id = p_incident_id and last_vitals_at is not null),
      'handed_over', (select count(*) from patients where incident_id = p_incident_id and handed_over_at is not null),
      'median_minutes_open_to_handover', (select round((percentile_cont(0.5) within group (order by extract(epoch from (handed_over_at - v_t0)) / 60))::numeric, 1)
                                           from patients where incident_id = p_incident_id and handed_over_at is not null)),
    'patient_rows', coalesce((select jsonb_agg(jsonb_build_object(
        'visual_id', p.visual_id,
        'triage', p.current_triage,
        'status', p.current_status,
        'pediatric', p.is_pediatric,
        'minutes_from_open', round(extract(epoch from (p.created_at - v_t0)) / 60),
        'minutes_to_handover', case when p.handed_over_at is not null then round(extract(epoch from (p.handed_over_at - v_t0)) / 60) end,
        'evacuation_destination', p.evacuation_destination,
        'mda_classification', p.mda_classification,
        'tourniquets', (select count(*) from tourniquets t where t.patient_id = p.id))
        order by p.created_at, p.visual_id)
      from patients p where p.incident_id = p_incident_id), '[]'::jsonb),
    'tourniquets', jsonb_build_object(
      'total', (select count(*) from tourniquets where incident_id = p_incident_id),
      'active_at_close', (select count(*) from tourniquets where incident_id = p_incident_id and is_active and released_at is null),
      'max_minutes', (select round(max(extract(epoch from (coalesce(released_at, v_end) - applied_at)) / 60)) from tourniquets where incident_id = p_incident_id and applied_at is not null),
      'over_120_minutes', (select count(*) from tourniquets where incident_id = p_incident_id and applied_at is not null
                            and coalesce(released_at, v_end) - applied_at > interval '120 minutes')),
    'evacuations_by_destination', coalesce((select jsonb_object_agg(d, n) from (select evacuation_destination d, count(*) n from patients where incident_id = p_incident_id and evacuation_destination is not null group by 1) x), '{}'::jsonb),
    'mda_vs_field', coalesce((select jsonb_agg(jsonb_build_object('field_triage', t, 'mda_classification', m, 'count', n))
                               from (select coalesce(current_triage::text, 'unknown') t, mda_classification m, count(*) n from patients
                                     where incident_id = p_incident_id and mda_classification is not null group by 1, 2) x), '[]'::jsonb),
    'pre_evacuation', (select jsonb_build_object('total', total_count, 'severe', severe_count, 'moderate', moderate_count, 'light', light_count)
                       from incident_pre_evacuations where incident_id = p_incident_id),
    'supply_consumed', coalesce((select jsonb_object_agg(item_type, used) from (select item_type, sum(-quantity_delta) used from inventory_ledger_v12
                                  where incident_id = p_incident_id and quantity_delta < 0 group by 1) x), '{}'::jsonb),
    'supply_requests_by_status', coalesce((select jsonb_object_agg(s, n) from (select status::text s, count(*) n from supply_requests where incident_id = p_incident_id group by 1) x), '{}'::jsonb),
    'medical_requests', coalesce((select jsonb_object_agg(k, n) from (select request_kind || ':' || status k, count(*) n from medical_resource_requests where incident_id = p_incident_id group by 1) x), '{}'::jsonb),
    'alerts_by_type', coalesce((select jsonb_object_agg(a, n) from (select alert_type a, count(*) n from watchdog_alerts where incident_id = p_incident_id group by 1) x), '{}'::jsonb),
    'sync_problems', coalesce((select jsonb_object_agg(c, n) from (select error_code c, count(*) n from sync_ingestion_errors where incident_id = p_incident_id group by 1) x), '{}'::jsonb),
    'patients_by_unit', coalesce((select jsonb_object_agg(u, n) from (
        select coalesce(pl.name, c.name, 'ללא שיוך') u, count(*) n
        from patients p left join profiles pr on pr.id = p.created_by
        left join platoons pl on pl.id = pr.platoon_id
        left join companies c on c.id = coalesce(pr.company_id, pl.company_id)
        where p.incident_id = p_incident_id group by 1) x), '{}'::jsonb),
    'events_total', (select count(*) from events where incident_id = p_incident_id)
  );
end;
$$;
revoke execute on function app.build_incident_aar(uuid) from public, anon, authenticated;

create or replace function app.store_incident_aar_on_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_version int;
  v_report jsonb;
begin
  if new.status <> 'closed' or old.status = 'closed' then
    return new;
  end if;
  -- A duplicate closed by merge_incident(): its records moved to the target.
  if new.metadata ? 'merged_into'
     and (new.metadata->'merged_into'->>'at')::timestamptz is not distinct from new.closed_at then
    return new;
  end if;
  begin
    v_report := app.build_incident_aar(new.id);
    select coalesce(max((report_json->>'version')::int), 0) + 1 into v_version from aar_reports where incident_id = new.id;
    insert into aar_reports (incident_id, generated_by, generated_at, report_json, locked)
    values (new.id, auth.uid(), now(), v_report || jsonb_build_object('version', v_version, 'closed_at', new.closed_at), true);
  exception when others then
    null; -- a failed report never blocks the close; command can still finalize and reopen/close
  end;
  return new;
end;
$$;
revoke execute on function app.store_incident_aar_on_close() from public, anon, authenticated;

drop trigger if exists trg_store_incident_aar_on_close on incidents;
create trigger trg_store_incident_aar_on_close
after update of status on incidents
for each row execute function app.store_incident_aar_on_close();

-- ---------------------------------------------------------------------------------------------
-- 4. Reading the report
-- ---------------------------------------------------------------------------------------------
create or replace function get_incident_aar_reports(p_incident_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
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
          or (v_role in ('pc','rcc','cc','chamal','physician','admin') and app.can_access_incident(p_incident_id))) then
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
$$;
revoke execute on function get_incident_aar_reports(uuid) from public, anon;
grant execute on function get_incident_aar_reports(uuid) to authenticated;
