-- events_insert_by_role was never updated when rpc/rcc were added in
-- 006/007, so those roles could not insert into events at all - discovered
-- via an actual end-to-end test against the deployed sync-log Edge Function
-- (rpc pushing FIRST_RESPONDER_REPORT was rejected at the RLS layer despite
-- the Edge Function's own role/event-type gate correctly permitting it).
--
-- Fine-grained event-type-vs-role restriction is handled in the sync-log
-- Edge Function itself (supabase/functions/sync-log/index.ts,
-- ROLE_ALLOWED_EVENT_TYPES), because this policy's role clause was already
-- effectively a no-op among the original 6 roles: can_write_clinical_event
-- covers medic/pc, and the OR clause adds logistics_officer/cc/chamal/admin -
-- together that's all 6 roles that existed before this session, regardless
-- of event type. Widening it to include rpc/rcc here doesn't loosen
-- anything beyond what the Edge Function already enforces precisely;
-- verified with a real logistics_officer account that a MEDICATION_ADMINISTERED
-- push still gets rejected (by the Edge Function's own check).
drop policy if exists events_insert_by_role on events;
create policy events_insert_by_role on events for insert to authenticated with check (
  actor_id = (select auth.uid())
  and app.can_access_incident(incident_id)
  and (
    app.can_write_clinical_event(actor_role)
    or actor_role in ('logistics_officer','cc','chamal','admin','rpc','rcc')
  )
);
