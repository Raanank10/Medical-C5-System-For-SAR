-- Two changes to events_insert_by_role (owner, 2026-10-23).
--
-- 1. actor_role must be the caller's real role.
--    Measured live 2026-10-23 (read-only): the policy (last set in 027) checks actor_role, but the
--    caller fills that column in and nothing compares it with profiles.role (no BEFORE trigger, no
--    default, no check constraint), and authenticated has INSERT on events. So a signed-in user
--    could insert directly through the REST API, skipping sync-log, with any actor_role: as a
--    'physician' or 'admin', which the triage role-authority tie-break (project_patient_state,
--    database/041) trusts. sync-log itself always writes the caller's profiles.role, so the
--    real sync path is unchanged. app.current_user_role() (security definer) returns null for an
--    inactive profile, so an inactive user's direct insert is refused too, as sync-log already does.
--    app.append_incident_lifecycle_event is security definer, owned by postgres (the table owner),
--    and events does not force row level security, so its inserts are not affected.
--
-- 2. Cric and needle decompression (MARCH-PAWS, V2.99.62): only a paramedic or a physician
--    performs them on scene. They travel as AIRWAY_MANAGED (cric) and INTERVENTION_RECORDED
--    (needle decompression) with payload_json.treatment_type; any other role's event carrying one
--    of them is refused. sync-log refuses the same events first with FORBIDDEN_ACTOR_ROLE, so the
--    phone shows a sync rejection; this policy is what holds against a direct insert. No admin
--    exception: the owner named the two roles.
--
-- Everything else in the policy is the 027 text unchanged.
--
-- Applied live 2026-10-24 by the owner from the SQL editor; sync-log v14 deployed the same day.
-- Checked right after: pg_policies shows this exact text. Then 11 inserts as real accounts
-- (request.jwt.claims + role authenticated) in one transaction that was rolled back, with a
-- temporary incident membership for the medic and pc inside it; nothing was left behind:
--   allowed: medic NOTE_ADDED, medic NPA (AIRWAY_MANAGED), paramedic cric, physician needle
--            decompression, pc NOTE_ADDED;
--   refused (42501, row-level security): medic cric, medic needle decompression, pc needle
--            decompression, a medic claiming physician (NOTE_ADDED), a medic claiming paramedic
--            (cric), a paramedic claiming physician (PATIENT_DEATH_CONFIRMED).

drop policy if exists events_insert_by_role on events;
create policy events_insert_by_role on events for insert to authenticated with check (
  actor_id = (select auth.uid())
  and actor_role = (select app.current_user_role())
  and app.can_access_incident(incident_id)
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
