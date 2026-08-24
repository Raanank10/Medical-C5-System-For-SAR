-- Fixes a real gap found during F3 live verification: 020_physician_paramedic_rls.sql widened
-- app.is_command_role()/app.can_access_incident()/app.can_write_clinical_event() but never
-- re-issued events_insert_by_role itself - physician was left out of its separate inline OR'd
-- role array (the one covering logistics_officer/cc/chamal/admin/rpc/rcc), so physician could
-- pass every other check and still be unable to insert ANY event at all. paramedic needed no
-- fix here: it already gets through via app.can_write_clinical_event(), which 020 correctly
-- updated. Caught by a live SQL impersonation test (a physician-role PATIENT_TRIAGE_UPDATED
-- insert failing RLS), not by migration-file review alone - exactly the kind of gap this
-- repo's "medical-logic/RLS changes always human-verified against real accounts" rule exists
-- to catch before merge.

drop policy if exists events_insert_by_role on events;
create policy events_insert_by_role on events for insert to authenticated with check (
  actor_id = (select auth.uid())
  and app.can_access_incident(incident_id)
  and (
    app.can_write_clinical_event(actor_role)
    or actor_role = any (array['logistics_officer','cc','chamal','admin','rpc','rcc','physician']::user_role[])
  )
);
