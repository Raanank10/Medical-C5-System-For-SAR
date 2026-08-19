-- Two performance-advisory categories, both real but invisible until there's
-- actual query volume:
--
-- 1. auth_rls_initplan: policies calling auth.uid() / app.current_user_role()
--    directly get re-evaluated once per row instead of once per query.
--    Wrapping as (select auth.uid()) lets Postgres cache the result.
--
-- 2. multiple_permissive_policies: several tables had both a dedicated SELECT
--    policy and a separate FOR ALL policy that also covers SELECT, so
--    Postgres evaluates both permissively on every read. Postgres doesn't
--    support a FOR clause that excludes SELECT, so each FOR ALL write policy
--    is split into INSERT/UPDATE/DELETE instead.
--
-- Tables newly given RLS in 004_rls_gap_fixes_and_trigger_security_definer.sql
-- only got their read policy there; their write policies are created directly
-- here as split insert/update/delete so they never go through a redundant
-- FOR ALL stage.

-- =========================================================
-- Pre-existing policies from 001/002 that only need their expressions
-- rewritten (no FOR-clause split required).
-- =========================================================

alter policy profiles_read_authenticated on profiles
using (id = (select auth.uid()) or (select app.current_user_role()) in ('pc','cc','chamal','admin'));

alter policy incident_memberships_read_scoped on incident_memberships
using (profile_id = (select auth.uid()) or (select app.current_user_role()) in ('pc','cc','chamal','admin'));

alter policy events_insert_by_role on events
with check (
  actor_id = (select auth.uid())
  and app.can_access_incident(incident_id)
  and (
    app.can_write_clinical_event(actor_role)
    or actor_role in ('logistics_officer','cc','chamal','admin')
  )
);

-- =========================================================
-- Pre-existing FOR ALL write policies (from 001) split into insert/update/
-- delete, with auth.uid()/current_user_role() wrapped in (select ...).
-- =========================================================

drop policy if exists aar_write_command on aar_reports;
create policy aar_write_insert on aar_reports for insert to authenticated with check (app.is_command_role() and app.can_access_incident(incident_id));
create policy aar_write_update on aar_reports for update to authenticated using (app.is_command_role() and app.can_access_incident(incident_id)) with check (app.is_command_role() and app.can_access_incident(incident_id));
create policy aar_write_delete on aar_reports for delete to authenticated using (app.is_command_role() and app.can_access_incident(incident_id));

drop policy if exists incident_memberships_write_command on incident_memberships;
create policy incident_memberships_insert on incident_memberships for insert to authenticated with check ((select app.current_user_role()) in ('pc','cc','chamal','admin'));
create policy incident_memberships_update on incident_memberships for update to authenticated using ((select app.current_user_role()) in ('pc','cc','chamal','admin')) with check ((select app.current_user_role()) in ('pc','cc','chamal','admin'));
create policy incident_memberships_delete on incident_memberships for delete to authenticated using ((select app.current_user_role()) in ('pc','cc','chamal','admin'));

-- incidents_command_write's with_check differs from its using clause (medics
-- may insert/update their own draft incidents) - preserved exactly below.
drop policy if exists incidents_command_write on incidents;
create policy incidents_insert on incidents for insert to authenticated with check ((select app.current_user_role()) in ('pc','cc','chamal','admin') or (status = 'draft' and draft_created_by = (select auth.uid()) and (select app.current_user_role()) = 'medic'));
create policy incidents_update on incidents for update to authenticated using ((select app.current_user_role()) in ('pc','cc','chamal','admin')) with check ((select app.current_user_role()) in ('pc','cc','chamal','admin') or (status = 'draft' and draft_created_by = (select auth.uid()) and (select app.current_user_role()) = 'medic'));
create policy incidents_delete on incidents for delete to authenticated using ((select app.current_user_role()) in ('pc','cc','chamal','admin'));

drop policy if exists sectors_command_write on sectors;
create policy sectors_insert on sectors for insert to authenticated with check (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','cc','chamal','admin'));
create policy sectors_update on sectors for update to authenticated using (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','cc','chamal','admin')) with check (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','cc','chamal','admin'));
create policy sectors_delete on sectors for delete to authenticated using (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','cc','chamal','admin'));

drop policy if exists supply_requests_write_ops on supply_requests;
create policy supply_requests_insert on supply_requests for insert to authenticated with check (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','logistics_officer','admin'));
create policy supply_requests_update on supply_requests for update to authenticated using (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','logistics_officer','admin')) with check (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','logistics_officer','admin'));
create policy supply_requests_delete on supply_requests for delete to authenticated using (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','logistics_officer','admin'));

-- =========================================================
-- Write policies for tables newly RLS-enabled in 004 (read policy only
-- created there) - created directly as insert/update/delete.
-- =========================================================

create policy device_presence_insert on device_presence for insert to authenticated with check (app.can_access_incident(incident_id) and (actor_id = (select auth.uid()) or (select app.current_user_role()) in ('pc','cc','chamal','admin')));
create policy device_presence_update on device_presence for update to authenticated using (app.can_access_incident(incident_id) and (actor_id = (select auth.uid()) or (select app.current_user_role()) in ('pc','cc','chamal','admin'))) with check (app.can_access_incident(incident_id) and (actor_id = (select auth.uid()) or (select app.current_user_role()) in ('pc','cc','chamal','admin')));
create policy device_presence_delete on device_presence for delete to authenticated using (app.can_access_incident(incident_id) and (actor_id = (select auth.uid()) or (select app.current_user_role()) in ('pc','cc','chamal','admin')));

create policy device_sync_state_insert on device_sync_state for insert to authenticated with check ((incident_id is null or app.can_access_incident(incident_id)) and (actor_id = (select auth.uid()) or (select app.current_user_role()) in ('pc','cc','chamal','admin')));
create policy device_sync_state_update on device_sync_state for update to authenticated using ((incident_id is null or app.can_access_incident(incident_id)) and (actor_id = (select auth.uid()) or (select app.current_user_role()) in ('pc','cc','chamal','admin'))) with check ((incident_id is null or app.can_access_incident(incident_id)) and (actor_id = (select auth.uid()) or (select app.current_user_role()) in ('pc','cc','chamal','admin')));
create policy device_sync_state_delete on device_sync_state for delete to authenticated using ((incident_id is null or app.can_access_incident(incident_id)) and (actor_id = (select auth.uid()) or (select app.current_user_role()) in ('pc','cc','chamal','admin')));

create policy external_reports_insert on external_reports for insert to authenticated with check (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('pc','cc','chamal','admin'));
create policy external_reports_update on external_reports for update to authenticated using (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('pc','cc','chamal','admin')) with check (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('pc','cc','chamal','admin'));
create policy external_reports_delete on external_reports for delete to authenticated using (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('pc','cc','chamal','admin'));

create policy external_patient_links_insert on external_patient_links for insert to authenticated with check (exists (select 1 from external_reports er where er.id = external_patient_links.external_report_id and app.can_access_incident(er.incident_id)) and (select app.current_user_role()) in ('pc','cc','chamal','admin'));
create policy external_patient_links_update on external_patient_links for update to authenticated using (exists (select 1 from external_reports er where er.id = external_patient_links.external_report_id and app.can_access_incident(er.incident_id)) and (select app.current_user_role()) in ('pc','cc','chamal','admin')) with check (exists (select 1 from external_reports er where er.id = external_patient_links.external_report_id and app.can_access_incident(er.incident_id)) and (select app.current_user_role()) in ('pc','cc','chamal','admin'));
create policy external_patient_links_delete on external_patient_links for delete to authenticated using (exists (select 1 from external_reports er where er.id = external_patient_links.external_report_id and app.can_access_incident(er.incident_id)) and (select app.current_user_role()) in ('pc','cc','chamal','admin'));

create policy treatment_catalog_insert on treatment_catalog for insert to authenticated with check ((select app.current_user_role()) = 'admin');
create policy treatment_catalog_update on treatment_catalog for update to authenticated using ((select app.current_user_role()) = 'admin') with check ((select app.current_user_role()) = 'admin');
create policy treatment_catalog_delete on treatment_catalog for delete to authenticated using ((select app.current_user_role()) = 'admin');

create policy treatment_inventory_items_insert on treatment_inventory_items for insert to authenticated with check ((select app.current_user_role()) = 'admin');
create policy treatment_inventory_items_update on treatment_inventory_items for update to authenticated using ((select app.current_user_role()) = 'admin') with check ((select app.current_user_role()) = 'admin');
create policy treatment_inventory_items_delete on treatment_inventory_items for delete to authenticated using ((select app.current_user_role()) = 'admin');

create policy inventory_items_insert on inventory_items for insert to authenticated with check ((select app.current_user_role()) = 'admin');
create policy inventory_items_update on inventory_items for update to authenticated using ((select app.current_user_role()) = 'admin') with check ((select app.current_user_role()) = 'admin');
create policy inventory_items_delete on inventory_items for delete to authenticated using ((select app.current_user_role()) = 'admin');

create policy kit_templates_insert on kit_templates for insert to authenticated with check ((select app.current_user_role()) in ('pc','logistics_officer','admin'));
create policy kit_templates_update on kit_templates for update to authenticated using ((select app.current_user_role()) in ('pc','logistics_officer','admin')) with check ((select app.current_user_role()) in ('pc','logistics_officer','admin'));
create policy kit_templates_delete on kit_templates for delete to authenticated using ((select app.current_user_role()) in ('pc','logistics_officer','admin'));

create policy kit_template_items_insert on kit_template_items for insert to authenticated with check ((select app.current_user_role()) in ('pc','logistics_officer','admin'));
create policy kit_template_items_update on kit_template_items for update to authenticated using ((select app.current_user_role()) in ('pc','logistics_officer','admin')) with check ((select app.current_user_role()) in ('pc','logistics_officer','admin'));
create policy kit_template_items_delete on kit_template_items for delete to authenticated using ((select app.current_user_role()) in ('pc','logistics_officer','admin'));

create policy supply_request_items_insert on supply_request_items for insert to authenticated with check (exists (select 1 from supply_requests sr where sr.id = supply_request_items.supply_request_id and app.can_access_incident(sr.incident_id)) and (select app.current_user_role()) in ('medic','pc','logistics_officer','admin'));
create policy supply_request_items_update on supply_request_items for update to authenticated using (exists (select 1 from supply_requests sr where sr.id = supply_request_items.supply_request_id and app.can_access_incident(sr.incident_id)) and (select app.current_user_role()) in ('medic','pc','logistics_officer','admin')) with check (exists (select 1 from supply_requests sr where sr.id = supply_request_items.supply_request_id and app.can_access_incident(sr.incident_id)) and (select app.current_user_role()) in ('medic','pc','logistics_officer','admin'));
create policy supply_request_items_delete on supply_request_items for delete to authenticated using (exists (select 1 from supply_requests sr where sr.id = supply_request_items.supply_request_id and app.can_access_incident(sr.incident_id)) and (select app.current_user_role()) in ('medic','pc','logistics_officer','admin'));
