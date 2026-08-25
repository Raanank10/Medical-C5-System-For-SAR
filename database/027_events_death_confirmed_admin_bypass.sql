-- Restores admin's universal bypass for PATIENT_DEATH_CONFIRMED, per explicit user
-- decision: "admin should have all permission. the admin role is to check from the
-- inside that the system works, and reads the logs." database/026's carve-out was
-- unconditional on actor_role = 'physician', which (found live, not by inspection)
-- also blocked admin - inconsistent with every other action in the schema, where
-- admin bypasses everything (isEventTypeAllowed() in sync-log/index.ts returns true
-- for admin before ever consulting ROLE_ALLOWED_EVENT_TYPES; every other RLS policy's
-- role branch includes admin unconditionally). The physician-only *intent* (a
-- non-admin, non-physician role cannot forge this event) is unchanged - only admin
-- is added back to the exception.

drop policy if exists events_insert_by_role on events;
create policy events_insert_by_role on events for insert to authenticated with check (
  actor_id = (select auth.uid())
  and app.can_access_incident(incident_id)
  and (
    app.can_write_clinical_event(actor_role)
    or actor_role = any (array['logistics_officer','cc','chamal','admin','rpc','rcc','physician']::user_role[])
  )
  and (type <> 'PATIENT_DEATH_CONFIRMED' or actor_role in ('physician','admin'))
);
