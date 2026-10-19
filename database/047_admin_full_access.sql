-- Admin may do everything (decision D7 in docs/GAP_CLOSURE_PLAN.md, repo owner 2026-10-19).
-- This matches AUTH_MATRIX in index.html, which already lists admin as 'yes' for every action,
-- and the sync-log Edge Function, which already lets admin send every event type.
--
-- Found live 2026-10-19 (WP-0 baseline): every patient entered on two phones logged in as admin
-- (2026-10-17 and 2026-10-18, incident INC-261016-668987) was rejected by patients_insert
-- ("new row violates row-level security policy"), and every later event for those patients then
-- failed events_patient_id_fkey. Audit of all policies and functions for checks that leave admin
-- out found exactly four places; everything else already includes admin:
--   1. patients_insert                (medic, pc, paramedic, rpc, rcc)
--   2. high_risk_override_insert      (medic, pc, paramedic, physician; database/023)
--   3. death_confirmations_insert     (physician only; database/025)
--   4. project_patient_state()        a physician-confirmed death keeps triage black for everyone
--                                     but a physician (database/041)
-- events_insert_by_role already allows PATIENT_DEATH_CONFIRMED from admin on the live project.
--
-- Not changed: app.role_authority_rank() keeps admin at 0 (database/021). That rank is used only
-- when two roles edit the same field within 5 minutes; it never blocks an admin action on its own.
-- Policy expressions below are copied from the live project, with admin added.

drop policy if exists patients_insert on patients;
create policy patients_insert on patients for insert to authenticated with check (
  app.can_access_incident(incident_id)
  and app.current_user_role() = any (array['medic','pc','paramedic','rpc','rcc','admin']::user_role[])
);

drop policy if exists high_risk_override_insert on high_risk_override_confirmations;
create policy high_risk_override_insert on high_risk_override_confirmations for insert to authenticated with check (
  app.can_access_incident(incident_id)
  and actor_id = (select auth.uid())
  and app.current_user_role() = any (array['medic','pc','paramedic','physician','admin']::user_role[])
);

drop policy if exists death_confirmations_insert on death_confirmations;
create policy death_confirmations_insert on death_confirmations for insert to authenticated with check (
  app.can_access_incident(incident_id)
  and actor_id = (select auth.uid())
  and (select app.current_user_role()) = any (array['physician','admin']::user_role[])
);

-- project_patient_state() is ~13k characters; rewrite only the one guard line in place rather than
-- copying the whole function here, and fail loudly if the live text no longer matches.
do $do$
declare
  v_def text := pg_get_functiondef('public.project_patient_state()'::regprocedure);
  v_old text := 'and new.actor_role is distinct from ''physician'' then';
  v_new text := 'and coalesce(new.actor_role::text, '''') not in (''physician'', ''admin'') then';
begin
  if (select count(*) from regexp_matches(v_def, 'new\.actor_role is distinct from ''physician'' then', 'g')) <> 1 then
    raise exception 'database/047: expected exactly one physician-death guard in project_patient_state()';
  end if;
  execute replace(v_def, v_old, v_new);
end
$do$;

-- create or replace keeps existing grants, but re-assert database/046's rule for trigger functions.
revoke execute on function public.project_patient_state() from public, anon, authenticated;
