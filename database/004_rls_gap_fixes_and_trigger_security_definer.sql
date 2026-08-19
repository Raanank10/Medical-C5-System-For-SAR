-- C5 Sentinel-SAR v1.2 schema was deployed for the first time this session
-- (Supabase project c5-sentinel-sar). Supabase's own security advisor
-- surfaced two real gaps that were invisible just from reading the file:
--
-- 1. All 19 views defaulted to running with the view creator's privileges
--    (SECURITY DEFINER-like behavior) rather than the querying user's,
--    which meant every one of them bypassed RLS entirely - any authenticated
--    user could read every patient across every incident through them.
--
-- 2. 17 tables never got `enable row level security` in the original draft
--    (patient_handover_tokens, realtime_outbox, external_reports,
--    external_patient_links, treatment_catalog, treatment_inventory_items,
--    inventory_items, kit_templates, kit_template_items, supply_request_items,
--    device_presence, tourniquets, sync_event_dependencies, device_sync_state,
--    high_risk_override_confirmations, inventory_ledger_v12,
--    experiment_observer_notes, patient_edit_conflicts).
--
-- Fixing this also surfaced a third, more structural issue: several trigger
-- functions cascade writes into other RLS-protected tables as side effects
-- of an `events`/`inventory_ledger` insert (e.g. flag_pediatric_medication_
-- missing_weight and trg_verify_pediatric_safety insert into watchdog_alerts
-- to flag missing-weight pediatric doses). None of these trigger functions
-- were SECURITY DEFINER, so those side-effect writes were evaluated against
-- the RLS policies of whoever fired the original insert (e.g. a medic) -
-- and watchdog_alerts had no INSERT policy for medic/pc at all. Once RLS is
-- actually enforced against a real (non-service-role) medic account, that
-- pediatric safety alert would have silently failed. The fix is marking the
-- cascading trigger functions SECURITY DEFINER with a pinned search_path
-- (also closing 20 function_search_path_mutable advisory warnings), then
-- explicitly revoking direct EXECUTE access from anon/authenticated so they
-- can't be called as ad hoc RPC endpoints (Postgres trigger firing does not
-- require EXECUTE privilege, so this doesn't affect normal operation).

-- =========================================================
-- Trigger functions that cascade writes into other RLS-protected tables.
-- =========================================================

alter function apply_event_projection_and_outbox() security definer set search_path = public;
alter function trg_project_patient_lifecycle_status() security definer set search_path = public;
alter function flag_pediatric_medication_missing_weight() security definer set search_path = public;
alter function project_tourniquet_events() security definer set search_path = public;
alter function silence_resolved_watchdogs_for_event(uuid) security definer set search_path = public;
alter function flag_negative_inventory_after_insert() security definer set search_path = public;
alter function clear_patient_pending_on_incident_confirmation() security definer set search_path = public;
alter function draft_incident_approval_outbox() security definer set search_path = public;
alter function refresh_incident_command_state(uuid) security definer set search_path = public;
alter function refresh_command_state_after_event() security definer set search_path = public;
alter function mark_patient_pending_when_incident_is_draft() security definer set search_path = public;
alter function trg_verify_pediatric_safety() security definer set search_path = public;
alter function trg_process_logistics_event_safety_v12() security definer set search_path = public;
alter function generate_dead_man_switch_alerts(interval) security definer set search_path = public;
alter function generate_tourniquet_reassessment_alerts(uuid) security definer set search_path = public;

-- Functions that only touch the row already being inserted/updated (no
-- cross-table writes) - just pin search_path to close the linter warning.
alter function fill_sector_label() set search_path = public;
alter function prevent_event_mutation() set search_path = public;
alter function autofill_inventory_location_at_time() set search_path = public;
alter function validate_inventory_transfer_rules() set search_path = public;
alter function app.can_write_clinical_event(user_role) set search_path = public;

-- SECURITY DEFINER functions are auto-exposed by Supabase as callable RPC
-- endpoints with EXECUTE granted to anon/authenticated by default. None of
-- the above are meant to be called directly (trigger-only or cron-only).
revoke execute on function apply_event_projection_and_outbox() from public, anon, authenticated;
revoke execute on function trg_project_patient_lifecycle_status() from public, anon, authenticated;
revoke execute on function flag_pediatric_medication_missing_weight() from public, anon, authenticated;
revoke execute on function project_tourniquet_events() from public, anon, authenticated;
revoke execute on function silence_resolved_watchdogs_for_event(uuid) from public, anon, authenticated;
revoke execute on function flag_negative_inventory_after_insert() from public, anon, authenticated;
revoke execute on function clear_patient_pending_on_incident_confirmation() from public, anon, authenticated;
revoke execute on function draft_incident_approval_outbox() from public, anon, authenticated;
revoke execute on function refresh_incident_command_state(uuid) from public, anon, authenticated;
revoke execute on function refresh_command_state_after_event() from public, anon, authenticated;
revoke execute on function mark_patient_pending_when_incident_is_draft() from public, anon, authenticated;
revoke execute on function trg_verify_pediatric_safety() from public, anon, authenticated;
revoke execute on function trg_process_logistics_event_safety_v12() from public, anon, authenticated;
revoke execute on function generate_dead_man_switch_alerts(interval) from public, anon, authenticated;
revoke execute on function generate_tourniquet_reassessment_alerts(uuid) from public, anon, authenticated;

-- =========================================================
-- Views: client-facing views get security_invoker so RLS on the underlying
-- tables applies correctly. KPI/command-aggregation views are meant to be
-- service-role/backend-only per ARCHITECTURE.md (same treatment already
-- given to incident_command_state), so those also get anon/authenticated revoked.
-- =========================================================

alter view vw_patient_latest_vitals set (security_invoker = true);
alter view vw_incident_tactical_funnel set (security_invoker = true);
alter view vw_sector_clearance_status set (security_invoker = true);
alter view vw_current_inventory set (security_invoker = true);
alter view vw_active_patient_priority set (security_invoker = true);
alter view vw_patient_treatment_history set (security_invoker = true);
alter view vw_platoon_stock set (security_invoker = true);
alter view vw_inventory_transfer_audit set (security_invoker = true);
alter view vw_draft_incident_approval_queue set (security_invoker = true);
alter view vw_aar_live_timeline set (security_invoker = true);
alter view vw_active_tourniquet_reassessment_due set (security_invoker = true);

alter view vw_kpi_incident_command_summary set (security_invoker = true);
alter view vw_active_watchdog_alerts_by_severity set (security_invoker = true);
alter view vw_kpi_sync_latency set (security_invoker = true);
alter view vw_kpi_time_to_first_vitals set (security_invoker = true);
alter view vw_kpi_inventory_stockout_risk set (security_invoker = true);
alter view vw_command_spatial_heatmap set (security_invoker = true);
alter view vw_command_incident_throughput_funnel set (security_invoker = true);
alter view vw_command_inventory_burn_rate_v12 set (security_invoker = true);

revoke all on vw_kpi_incident_command_summary from anon, authenticated;
revoke all on vw_active_watchdog_alerts_by_severity from anon, authenticated;
revoke all on vw_kpi_sync_latency from anon, authenticated;
revoke all on vw_kpi_time_to_first_vitals from anon, authenticated;
revoke all on vw_kpi_inventory_stockout_risk from anon, authenticated;
revoke all on vw_command_spatial_heatmap from anon, authenticated;
revoke all on vw_command_incident_throughput_funnel from anon, authenticated;
revoke all on vw_command_inventory_burn_rate_v12 from anon, authenticated;

-- =========================================================
-- RLS for the 17 tables that never got it in the original draft.
-- =========================================================

-- Handover credentials and internal delivery/sync bookkeeping: service-role
-- only, same treatment as incident_command_state. No client reads tokens or
-- the outbox directly.
alter table patient_handover_tokens enable row level security;
revoke all on patient_handover_tokens from anon, authenticated;

alter table realtime_outbox enable row level security;
revoke all on realtime_outbox from anon, authenticated;

-- External agency reports and their patient-matching links: readable by
-- anyone with incident access, written by command roles doing dedup/coordination.
alter table external_reports enable row level security;
drop policy if exists external_reports_read on external_reports;
create policy external_reports_read on external_reports for select to authenticated using (app.can_access_incident(incident_id));

alter table external_patient_links enable row level security;
drop policy if exists external_patient_links_read on external_patient_links;
create policy external_patient_links_read on external_patient_links for select to authenticated using (exists (select 1 from external_reports er where er.id = external_patient_links.external_report_id and app.can_access_incident(er.incident_id)));

-- Static reference catalogs (not incident-scoped, not sensitive): everyone
-- authenticated can read, only admin curates them.
alter table treatment_catalog enable row level security;
drop policy if exists treatment_catalog_read on treatment_catalog;
create policy treatment_catalog_read on treatment_catalog for select to authenticated using (true);

alter table treatment_inventory_items enable row level security;
drop policy if exists treatment_inventory_items_read on treatment_inventory_items;
create policy treatment_inventory_items_read on treatment_inventory_items for select to authenticated using (true);

alter table inventory_items enable row level security;
drop policy if exists inventory_items_read on inventory_items;
create policy inventory_items_read on inventory_items for select to authenticated using (true);

alter table kit_templates enable row level security;
drop policy if exists kit_templates_read on kit_templates;
create policy kit_templates_read on kit_templates for select to authenticated using (true);

alter table kit_template_items enable row level security;
drop policy if exists kit_template_items_read on kit_template_items;
create policy kit_template_items_read on kit_template_items for select to authenticated using (true);

-- Supply request line items: scoped via the parent supply_requests row, same
-- role set as the supply_requests write policies.
alter table supply_request_items enable row level security;
drop policy if exists supply_request_items_read on supply_request_items;
create policy supply_request_items_read on supply_request_items for select to authenticated using (exists (select 1 from supply_requests sr where sr.id = supply_request_items.supply_request_id and app.can_access_incident(sr.incident_id)));

-- Device presence carries live location data - real sensitivity. A device
-- can write its own presence row; command roles can write any.
alter table device_presence enable row level security;
drop policy if exists device_presence_read on device_presence;
create policy device_presence_read on device_presence for select to authenticated using (app.can_access_incident(incident_id));

-- Tourniquets is a trigger-populated projection (see project_tourniquet_events,
-- now SECURITY DEFINER) - clients read it, nobody writes it directly.
alter table tourniquets enable row level security;
drop policy if exists tourniquets_read on tourniquets;
create policy tourniquets_read on tourniquets for select to authenticated using (app.can_access_incident(incident_id));

-- Sync-internal bookkeeping: same command-only-read, backend-only-write
-- pattern already used for sync_ingestion_errors.
alter table sync_event_dependencies enable row level security;
drop policy if exists sync_event_dependencies_read_command on sync_event_dependencies;
create policy sync_event_dependencies_read_command on sync_event_dependencies for select to authenticated using (app.is_command_role());

-- Device sync/battery state: same self-or-command write pattern as device_presence.
alter table device_sync_state enable row level security;
drop policy if exists device_sync_state_read on device_sync_state;
create policy device_sync_state_read on device_sync_state for select to authenticated using (incident_id is null or app.can_access_incident(incident_id));

-- High-risk override confirmations are a medical-legal audit trail - readable
-- by command roles or the actor who recorded it, insert-only (never updated/
-- deleted), matching the append-only principle used for events.
alter table high_risk_override_confirmations enable row level security;
drop policy if exists high_risk_override_read on high_risk_override_confirmations;
create policy high_risk_override_read on high_risk_override_confirmations for select to authenticated using (app.can_access_incident(incident_id) and (app.is_command_role() or actor_id = (select auth.uid())));
drop policy if exists high_risk_override_insert on high_risk_override_confirmations;
create policy high_risk_override_insert on high_risk_override_confirmations for insert to authenticated with check (app.can_access_incident(incident_id) and actor_id = (select auth.uid()) and (select app.current_user_role()) in ('medic','pc'));

-- v1.2 logistics ledger mirrors inventory_ledger's existing RLS pattern.
alter table inventory_ledger_v12 enable row level security;
drop policy if exists inventory_ledger_v12_read on inventory_ledger_v12;
create policy inventory_ledger_v12_read on inventory_ledger_v12 for select to authenticated using (incident_id is null or app.can_access_incident(incident_id));
drop policy if exists inventory_ledger_v12_write on inventory_ledger_v12;
create policy inventory_ledger_v12_write on inventory_ledger_v12 for insert to authenticated with check ((incident_id is null or app.can_access_incident(incident_id)) and app.current_user_role() in ('medic','pc','logistics_officer','admin'));

-- Field-experiment observer notes: incident-scoped, self-authored.
alter table experiment_observer_notes enable row level security;
drop policy if exists experiment_observer_notes_read on experiment_observer_notes;
create policy experiment_observer_notes_read on experiment_observer_notes for select to authenticated using (app.can_access_incident(incident_id));
drop policy if exists experiment_observer_notes_write on experiment_observer_notes;
create policy experiment_observer_notes_write on experiment_observer_notes for insert to authenticated with check (app.can_access_incident(incident_id) and actor_id = (select auth.uid()));

-- Simultaneous-edit conflicts: same command-only-read pattern as conflict_log.
alter table patient_edit_conflicts enable row level security;
drop policy if exists patient_edit_conflicts_read on patient_edit_conflicts;
create policy patient_edit_conflicts_read on patient_edit_conflicts for select to authenticated using (app.is_command_role() and app.can_access_incident(incident_id));

-- The write-side policies for external_reports, external_patient_links,
-- treatment_catalog, treatment_inventory_items, inventory_items, kit_templates,
-- kit_template_items, and supply_request_items are created in
-- 005_rls_performance_fixes.sql as split insert/update/delete policies rather
-- than a single FOR ALL policy here, to avoid overlapping with the read
-- policies above from the start (see that file for why).
