-- Fixes two real gaps in high_risk_override_insert (confirming a high-risk clinical override,
-- e.g. a pediatric medication dose outside the normal safe range - see docs/CLINICAL_GOVERNANCE_
-- REVIEW_FRAMEWORK.md's high-risk-dose guardrails):
--
-- 1. paramedic was missed in 020_physician_paramedic_rls.sql despite that migration's own header
--    comment listing high_risk_override_insert as one of the policies paramedic should get "to
--    match medic's existing scope exactly" - it never actually got re-issued. Found while
--    following up on the user's explicit statement that paramedic should have the same
--    drugs/procedures authority as physician on the field.
-- 2. physician was never added here at all. Given physician is meant to have at least the same
--    field/clinical authority as paramedic/medic (docs/CONFLICT_RESOLUTION_DECISION.md's
--    "Physician-role prerequisite" section), a senior clinical role being unable to confirm a
--    high-risk override that a medic can was a real inconsistency, not an intentional exclusion
--    (unlike patients_insert/inventory/supply-request policies, which correctly mirror cc's own
--    exclusion from those and are left untouched here).

drop policy if exists high_risk_override_insert on high_risk_override_confirmations;
create policy high_risk_override_insert on high_risk_override_confirmations for insert to authenticated with check (
  app.can_access_incident(incident_id)
  and actor_id = (select auth.uid())
  and app.current_user_role() = any (array['medic','pc','paramedic','physician']::user_role[])
);
