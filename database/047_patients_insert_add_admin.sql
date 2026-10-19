-- Admin could not create patients (found live 2026-10-19, docs/GAP_CLOSURE_PLAN.md WP-0b).
--
-- On 2026-10-17/18 two phones logged in as admin, members of an active incident, created 5 quick
-- patients. Every QUICK_PATIENT_CREATED was quarantined with PATIENT_CREATE_FAILED ("new row
-- violates row-level security policy for table patients"), and every later event for those
-- patients (TOURNIQUET_APPLIED, VITALS_RECORDED, PATIENT_HANDED_OVER) then failed
-- events_patient_id_fkey. The server ended up with 0 patients for the incident.
--
-- Cause: patients_insert (last defined in 020) allows medic/pc/paramedic/rpc/rcc only, while
-- sync-log's role gate (admin always allowed) and the client AUTH_MATRIX ("Register new patient":
-- admin yes) both allow admin. Every other write path admin uses already includes it (checked live:
-- patients_insert was the only INSERT/UPDATE policy with a role list that lacks admin, apart from
-- death_confirmations, physician-only by design, and high_risk_override_insert).
--
-- Decision (repo owner, 2026-10-19): allow admin, matching AUTH_MATRIX. Admin is the technical
-- test role and must be able to run the full field flow. Revisit before any real-world use.
--
-- Same shape as 020, only 'admin' added. app.can_access_incident() is unchanged; it already lets
-- admin (like cc/chamal/rpc/rcc/physician) access every incident without a membership row, so admin
-- can now create a patient in any incident, as rpc/rcc already could.

drop policy if exists patients_insert on patients;
create policy patients_insert on patients for insert to authenticated with check (
  app.can_access_incident(incident_id)
  and app.current_user_role() = any (array['medic','pc','paramedic','rpc','rcc','admin']::user_role[])
);
