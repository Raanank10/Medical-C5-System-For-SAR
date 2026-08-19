-- RLS for the rpc/rcc roles added in 006_add_rpc_rcc_enum_values.sql.
-- Per docs/ROLE_COMMAND_MODEL_v2.8.md, these are first-responder rescue-chain
-- roles with final, PC/CC-independent authority over site-level state
-- (declare incident official + T0, open/close, building status, site clear),
-- plus first-responder patient intake (location/trapped/tourniquet only, no
-- clinical triage).
--
-- NOT covered here: the "tactical view scoped to my own platoon/company, no
-- vitals/identity" requirement from the auth matrix, and RCC's "limited"
-- resupply-request visibility. Both need a real platoon/company data model
-- (a platoons table, patients.assigned_platoon_id or equivalent) that does
-- not exist anywhere in this schema yet - grep confirms "platoon" only
-- appears as an inventory ownership tag string, never as an actual table or
-- relationship. Building fake scoping without that model would either expose
-- data it shouldn't or block reads it should allow, so it's flagged in
-- docs/ARCHITECTURE.md rather than faked here.
--
-- Verified against real Supabase Auth accounts (one per role, including
-- rpc/rcc), not just read: incident open/close, building status, and site
-- clear all confirmed to actually change the row (not just return 200);
-- rpc/rcc confirmed still blocked from patient triage/vitals writes (the
-- PATCH returns 204 either way - PostgREST returns 204 for zero rows
-- matched under RLS same as for a real update, so the row's actual value
-- was checked afterward, not just the status code).

-- Incident-level state (T0, status, building status, site clear) is not
-- platoon-partitioned in this schema - one incident covers every platoon/
-- company on site - so rpc/rcc get the same incident-wide read access as
-- cc/chamal/admin, consistent with their site-authority role rather than a
-- broader "command dashboard" grant (is_command_role is deliberately left
-- untouched, so rpc/rcc still can't reach AAR, conflict log, or sync
-- internals - the auth matrix says no to all of those for these roles).
create or replace function app.can_access_incident(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    app.current_user_role() in ('cc','chamal','admin','rpc','rcc')
    or exists (
      select 1
      from incident_memberships im
      where im.incident_id = p_incident_id
        and im.profile_id = auth.uid()
    ),
    false
  )
$$;

drop policy if exists incidents_insert on incidents;
create policy incidents_insert on incidents for insert to authenticated with check ((select app.current_user_role()) in ('pc','cc','chamal','admin','rpc','rcc') or (status = 'draft' and draft_created_by = (select auth.uid()) and (select app.current_user_role()) = 'medic'));

drop policy if exists incidents_update on incidents;
create policy incidents_update on incidents for update to authenticated using ((select app.current_user_role()) in ('pc','cc','chamal','admin','rpc','rcc')) with check ((select app.current_user_role()) in ('pc','cc','chamal','admin','rpc','rcc') or (status = 'draft' and draft_created_by = (select auth.uid()) and (select app.current_user_role()) = 'medic'));

drop policy if exists sectors_insert on sectors;
create policy sectors_insert on sectors for insert to authenticated with check (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','cc','chamal','admin','rpc','rcc'));

drop policy if exists sectors_update on sectors;
create policy sectors_update on sectors for update to authenticated using (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','cc','chamal','admin','rpc','rcc')) with check (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','cc','chamal','admin','rpc','rcc'));

-- First-responder patient intake: rpc/rcc create a minimal pending record
-- (location/trapped/tourniquet only). They do NOT get patients_projection_
-- update_scoped (vitals, triage override, handover all stay clinical-only,
-- matching "no" for those actions in the auth matrix) - verified with a
-- real rpc account that a PATCH attempting to set current_triage leaves
-- the row unchanged.
drop policy if exists patients_medic_pc_insert on patients;
create policy patients_insert on patients for insert to authenticated with check (app.can_access_incident(incident_id) and (select app.current_user_role()) in ('medic','pc','rpc','rcc'));
