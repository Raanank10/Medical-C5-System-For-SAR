-- Closes a real gap found during live verification of 024/025 (physician-only
-- death confirmation): project_patient_state() is SECURITY DEFINER, so its own
-- insert into death_confirmations runs with the function owner's privileges
-- and bypasses that table's RLS entirely. death_confirmations_insert (025) only
-- ever gates a *direct* client insert into that table - it does nothing to stop
-- a non-physician role from forging a PATIENT_DEATH_CONFIRMED event by writing
-- straight to `events` (bypassing the sync-log Edge Function's
-- ROLE_ALLOWED_EVENT_TYPES, the layer that's supposed to be the real per-type
-- gate), since events_insert_by_role (022) never checks event `type` for any
-- event type today - a paramedic satisfies app.can_write_clinical_event() the
-- same as a physician does.
--
-- Verified live before this fix: a paramedic-impersonated INSERT of a
-- PATIENT_DEATH_CONFIRMED event directly into `events` succeeded under the
-- pre-fix policy (RLS had no opinion on event type), which would have let
-- project_patient_state() write a forged death_confirmations row on the
-- paramedic's behalf via its SECURITY DEFINER privileges.
--
-- Fix: add one narrow, type-specific carve-out to events_insert_by_role -
-- every other event type is completely unaffected (same predicate as before),
-- PATIENT_DEATH_CONFIRMED additionally requires actor_role = 'physician'.
-- This is the actual enforcement point now; death_confirmations_insert (025)
-- remains as a second, real check against direct-table-write attempts.

drop policy if exists events_insert_by_role on events;
create policy events_insert_by_role on events for insert to authenticated with check (
  actor_id = (select auth.uid())
  and app.can_access_incident(incident_id)
  and (
    app.can_write_clinical_event(actor_role)
    or actor_role = any (array['logistics_officer','cc','chamal','admin','rpc','rcc','physician']::user_role[])
  )
  and (type <> 'PATIENT_DEATH_CONFIRMED' or actor_role = 'physician')
);
