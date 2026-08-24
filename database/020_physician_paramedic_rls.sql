-- RLS/permission scope for the two roles added in 019. Structured like
-- 007_rpc_rcc_site_authority_rls.sql: redefine the app.*() helpers first
-- (widens every policy/function that already calls them, e.g. is_command_role()
-- also covers conflict_log/patient_edit_conflicts/sync_ingestion_errors/
-- aar_reports/aar_context_notes/high_risk_override_confirmations/
-- sync_event_dependencies/tester_feedback_reports read access for free), then
-- re-issue every policy that spells its role list out literally instead of
-- calling a helper. Every predicate below is reproduced verbatim from the
-- live database (pulled via execute_sql immediately before writing this
-- file) with only the new role(s) added - no predicate shape is invented.
--
-- Role semantics (docs/CONFLICT_RESOLUTION_DECISION.md):
--   physician  - mirrors cc's scope, PLUS clinical/first-responder event
--                write access (cc itself has none today - see
--                supabase/functions/sync-log/index.ts's ROLE_ALLOWED_EVENT_TYPES
--                for the real per-event-type gate; RLS's events_insert_by_role
--                is intentionally coarse, per the existing 004/010 commentary).
--   paramedic  - an exact mirror of medic's scope (a clinical-seniority label
--                for the F3 tie-break, not a new capability tier) - added
--                everywhere 'medic' appears literally, including
--                patients_insert (a correction vs. an earlier draft of this
--                migration that excluded it by analogy with physician/cc;
--                paramedic mirrors medic's scope exactly, per the decided
--                requirement, so it belongs here).

-- ── Helper functions ─────────────────────────────────────────────────────

create or replace function app.is_command_role()
returns boolean
language sql
stable
security definer
set search_path = 'public'
as $function$
  select coalesce(app.current_user_role() in ('pc','cc','chamal','admin','physician'), false)
$function$;

create or replace function app.can_access_incident(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = 'public'
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
    ),
    false
  )
$function$;

create or replace function app.can_write_clinical_event(role_in user_role)
returns boolean
language sql
immutable
set search_path = 'public'
as $function$
  select role_in in ('medic','pc','paramedic')
$function$;

-- app.can_write_incident_event(uuid) is not referenced by any live policy
-- (confirmed by inspection of pg_policies before writing this migration) -
-- left unchanged deliberately; not touched just for symmetry with the above.

-- ── Literal 'cc' role lists → add 'physician' ────────────────────────────

drop policy if exists device_presence_delete on device_presence;
create policy device_presence_delete on device_presence for delete to authenticated using (
  app.can_access_incident(incident_id)
  and (actor_id = (select auth.uid()) or app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]))
);

drop policy if exists device_presence_insert on device_presence;
create policy device_presence_insert on device_presence for insert to authenticated with check (
  app.can_access_incident(incident_id)
  and (actor_id = (select auth.uid()) or app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]))
);

drop policy if exists device_presence_update on device_presence;
create policy device_presence_update on device_presence for update to authenticated
using (
  app.can_access_incident(incident_id)
  and (actor_id = (select auth.uid()) or app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]))
)
with check (
  app.can_access_incident(incident_id)
  and (actor_id = (select auth.uid()) or app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]))
);

drop policy if exists device_sync_state_delete on device_sync_state;
create policy device_sync_state_delete on device_sync_state for delete to authenticated using (
  (incident_id is null or app.can_access_incident(incident_id))
  and (actor_id = (select auth.uid()) or app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]))
);

drop policy if exists device_sync_state_insert on device_sync_state;
create policy device_sync_state_insert on device_sync_state for insert to authenticated with check (
  (incident_id is null or app.can_access_incident(incident_id))
  and (actor_id = (select auth.uid()) or app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]))
);

drop policy if exists device_sync_state_update on device_sync_state;
create policy device_sync_state_update on device_sync_state for update to authenticated
using (
  (incident_id is null or app.can_access_incident(incident_id))
  and (actor_id = (select auth.uid()) or app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]))
)
with check (
  (incident_id is null or app.can_access_incident(incident_id))
  and (actor_id = (select auth.uid()) or app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]))
);

drop policy if exists external_patient_links_delete on external_patient_links;
create policy external_patient_links_delete on external_patient_links for delete to authenticated using (
  exists (select 1 from external_reports er where er.id = external_patient_links.external_report_id and app.can_access_incident(er.incident_id))
  and app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
);

drop policy if exists external_patient_links_insert on external_patient_links;
create policy external_patient_links_insert on external_patient_links for insert to authenticated with check (
  exists (select 1 from external_reports er where er.id = external_patient_links.external_report_id and app.can_access_incident(er.incident_id))
  and app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
);

drop policy if exists external_patient_links_update on external_patient_links;
create policy external_patient_links_update on external_patient_links for update to authenticated
using (
  exists (select 1 from external_reports er where er.id = external_patient_links.external_report_id and app.can_access_incident(er.incident_id))
  and app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
)
with check (
  exists (select 1 from external_reports er where er.id = external_patient_links.external_report_id and app.can_access_incident(er.incident_id))
  and app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
);

drop policy if exists external_reports_delete on external_reports;
create policy external_reports_delete on external_reports for delete to authenticated using (
  app.can_access_incident(incident_id) and app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
);

drop policy if exists external_reports_insert on external_reports;
create policy external_reports_insert on external_reports for insert to authenticated with check (
  app.can_access_incident(incident_id) and app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
);

drop policy if exists external_reports_update on external_reports;
create policy external_reports_update on external_reports for update to authenticated
using (app.can_access_incident(incident_id) and app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]))
with check (app.can_access_incident(incident_id) and app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]));

drop policy if exists incident_memberships_delete on incident_memberships;
create policy incident_memberships_delete on incident_memberships for delete to authenticated using (
  app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
);

drop policy if exists incident_memberships_insert on incident_memberships;
create policy incident_memberships_insert on incident_memberships for insert to authenticated with check (
  app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
);

drop policy if exists incident_memberships_read_scoped on incident_memberships;
create policy incident_memberships_read_scoped on incident_memberships for select to authenticated using (
  profile_id = (select auth.uid()) or app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
);

drop policy if exists incident_memberships_update on incident_memberships;
create policy incident_memberships_update on incident_memberships for update to authenticated
using (app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]))
with check (app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]));

drop policy if exists incidents_delete on incidents;
create policy incidents_delete on incidents for delete to authenticated using (
  app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
);

drop policy if exists incidents_insert on incidents;
create policy incidents_insert on incidents for insert to authenticated with check (
  app.current_user_role() = any (array['pc','cc','chamal','admin','rpc','rcc','physician']::user_role[])
  or (status = 'draft'::incident_status and draft_created_by = (select auth.uid()) and app.current_user_role() = any (array['medic','paramedic']::user_role[]))
);

drop policy if exists incidents_update on incidents;
create policy incidents_update on incidents for update to authenticated
using (app.current_user_role() = any (array['pc','cc','chamal','admin','rpc','rcc','physician']::user_role[]))
with check (
  app.current_user_role() = any (array['pc','cc','chamal','admin','rpc','rcc','physician']::user_role[])
  or (status = 'draft'::incident_status and draft_created_by = (select auth.uid()) and app.current_user_role() = any (array['medic','paramedic']::user_role[]))
);

drop policy if exists profiles_read_authenticated on profiles;
create policy profiles_read_authenticated on profiles for select to authenticated using (
  id = (select auth.uid()) or app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[])
);

drop policy if exists watchdog_command_update on watchdog_alerts;
create policy watchdog_command_update on watchdog_alerts for update to authenticated
using (app.can_access_incident(incident_id) and app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]))
with check (app.can_access_incident(incident_id) and app.current_user_role() = any (array['pc','cc','chamal','admin','physician']::user_role[]));

-- ── Literal 'medic' role lists → add 'paramedic' (events_insert_by_role and
-- high_risk_override_insert both route through app.can_write_clinical_event,
-- already updated above - no separate re-issue needed for those two) ──────

drop policy if exists inventory_write_ops on inventory_ledger;
create policy inventory_write_ops on inventory_ledger for insert to authenticated with check (
  (incident_id is null or app.can_access_incident(incident_id))
  and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[])
);

drop policy if exists inventory_ledger_v12_write on inventory_ledger_v12;
create policy inventory_ledger_v12_write on inventory_ledger_v12 for insert to authenticated with check (
  (incident_id is null or app.can_access_incident(incident_id))
  and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[])
);

drop policy if exists patients_insert on patients;
create policy patients_insert on patients for insert to authenticated with check (
  app.can_access_incident(incident_id)
  and app.current_user_role() = any (array['medic','pc','paramedic','rpc','rcc']::user_role[])
);

drop policy if exists supply_request_items_delete on supply_request_items;
create policy supply_request_items_delete on supply_request_items for delete to authenticated using (
  exists (select 1 from supply_requests sr where sr.id = supply_request_items.supply_request_id and app.can_access_incident(sr.incident_id))
  and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[])
);

drop policy if exists supply_request_items_insert on supply_request_items;
create policy supply_request_items_insert on supply_request_items for insert to authenticated with check (
  exists (select 1 from supply_requests sr where sr.id = supply_request_items.supply_request_id and app.can_access_incident(sr.incident_id))
  and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[])
);

drop policy if exists supply_request_items_update on supply_request_items;
create policy supply_request_items_update on supply_request_items for update to authenticated
using (
  exists (select 1 from supply_requests sr where sr.id = supply_request_items.supply_request_id and app.can_access_incident(sr.incident_id))
  and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[])
)
with check (
  exists (select 1 from supply_requests sr where sr.id = supply_request_items.supply_request_id and app.can_access_incident(sr.incident_id))
  and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[])
);

drop policy if exists supply_requests_delete on supply_requests;
create policy supply_requests_delete on supply_requests for delete to authenticated using (
  app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[])
);

drop policy if exists supply_requests_insert on supply_requests;
create policy supply_requests_insert on supply_requests for insert to authenticated with check (
  app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[])
);

drop policy if exists supply_requests_update on supply_requests;
create policy supply_requests_update on supply_requests for update to authenticated
using (app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[]))
with check (app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[]));

-- ── Both 'cc' and 'medic' present → add both new roles ───────────────────

drop policy if exists patients_projection_update_scoped on patients;
create policy patients_projection_update_scoped on patients for update to authenticated
using (app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','paramedic','pc','cc','physician','chamal','admin']::user_role[]))
with check (app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','paramedic','pc','cc','physician','chamal','admin']::user_role[]));

drop policy if exists sectors_delete on sectors;
create policy sectors_delete on sectors for delete to authenticated using (
  app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','paramedic','pc','cc','physician','chamal','admin']::user_role[])
);

drop policy if exists sectors_insert on sectors;
create policy sectors_insert on sectors for insert to authenticated with check (
  app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','paramedic','pc','cc','physician','chamal','admin','rpc','rcc']::user_role[])
);

drop policy if exists sectors_update on sectors;
create policy sectors_update on sectors for update to authenticated
using (app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','paramedic','pc','cc','physician','chamal','admin','rpc','rcc']::user_role[]))
with check (app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','paramedic','pc','cc','physician','chamal','admin','rpc','rcc']::user_role[]));

-- ── database/018's inline identity-write check ────────────────────────────

create or replace function public.update_patient_identity(
  p_patient_id uuid, p_name text, p_identifying_description text
)
returns void
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_incident_id uuid;
begin
  select incident_id into v_incident_id from patients where id = p_patient_id;
  if v_incident_id is null then
    raise exception 'patient % not found' , p_patient_id using errcode = 'P0002';
  end if;

  if not app.can_access_incident(v_incident_id) then
    raise exception 'access denied to incident %', v_incident_id using errcode = '42501';
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

-- finalize_incident_aar() calls app.is_command_role() directly - already
-- widened to include physician by this migration's first edit above, no
-- separate re-issue needed.
