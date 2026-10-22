-- Unused server tables move to an archive schema; the never-read realtime_outbox stops being
-- written (docs/GAP_CLOSURE_PLAN.md WP-15). Nothing is dropped (owner's rule: no data dropped
-- without the owner).
--
-- Re-checked live 2026-10-22 right before the change (row count; functions, views, triggers,
-- foreign keys and publications that name each table; client, edge function and script code):
-- - device_sync_state, experiment_observer_notes, high_risk_override_confirmations,
--   patient_edit_conflicts, sync_event_dependencies: 0 rows; named only by merge_incident()
--   (database/067), which moved their rows between incidents. The analytics export
--   (export_live_incident.py) also fetched device_sync_state; it now writes that SQLite table empty.
-- - supply_request_items, treatment_inventory_items: 0 rows; treatment_catalog: 1 seed row; named
--   by nothing.
-- - realtime_outbox: 19 rows; written by apply_event_projection_and_outbox() and
--   draft_incident_approval_outbox() on every matching event and by merge_incident(); read by
--   nothing (no reader, no realtime publication). An extra write per event and one more copy of
--   patient payloads.
-- - aar_reports stays in public: database/068 (D9) stores the after-action report there.
--
-- 1. Stop the realtime_outbox writes:
--    - apply_event_projection_and_outbox(): the conflict_log part is kept exactly; the outbox
--      insert is removed;
--    - trg_draft_incident_approval_outbox only ever wrote the outbox: disabled (not dropped; one
--      ALTER TABLE ... ENABLE TRIGGER brings it back).
-- 2. merge_incident() without its statements on the moved tables. Edited from the LIVE definition
--    (its body differs from 067's text in comments), each removed statement asserted present, so
--    nothing else in it changes.
-- 3. The nine tables move to schema archive with their rows, policies, indexes and foreign keys.
--    No usage on archive for anon or authenticated: the API cannot reach them.

-- ---------------------------------------------------------------------------------------------
-- 1. realtime_outbox writes
-- ---------------------------------------------------------------------------------------------
create or replace function public.apply_event_projection_and_outbox()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if new.type in ('MSTART_OVERRIDE','JUMPSTART_OVERRIDE','SYNC_CONFLICT','CONFLICT_LOG_ENTRY','TREATMENT_SAFETY_WARNING','COMMAND_CONTEXT_NOTE_ADDED','VOICE_MEMO_ADDED','HIGH_RISK_CLINICAL_VIOLATION') then
    insert into conflict_log (incident_id, event_id, patient_id, actor_id, conflict_type, severity, algorithm_value, human_value, reason, description, payload_json)
    values (
      new.incident_id,
      new.id,
      new.patient_id,
      new.actor_id,
      new.type::text,
      coalesce(new.payload_json->>'severity','medium'),
      new.payload_json->>'algorithm_value',
      new.payload_json->>'human_value',
      new.payload_json->>'reason',
      coalesce(new.payload_json->>'description', new.type::text),
      new.payload_json
    );
  end if;

  -- The realtime_outbox insert was removed by database/070 (WP-15): nothing ever read it.
  return new;
end;
$function$;

alter table public.events disable trigger trg_draft_incident_approval_outbox;

-- ---------------------------------------------------------------------------------------------
-- 2. merge_incident() without the moved tables
-- ---------------------------------------------------------------------------------------------
do $do$
declare
  v_def text;
  v_stmt text;
  v_removed text[] := array[
    E'  update high_risk_override_confirmations set incident_id = p_target_id where incident_id = p_source_id;\n',
    E'  update patient_edit_conflicts set incident_id = p_target_id where incident_id = p_source_id;\n',
    E'  update realtime_outbox set incident_id = p_target_id where incident_id = p_source_id;\n',
    E'  update sync_event_dependencies set incident_id = p_target_id where incident_id = p_source_id;\n',
    E'  update experiment_observer_notes set incident_id = p_target_id where incident_id = p_source_id;\n',
    E'  update device_sync_state s set incident_id = p_target_id\n  where s.incident_id = p_source_id\n    and not exists (select 1 from device_sync_state t where t.incident_id = p_target_id and t.device_id = s.device_id);\n'
  ];
begin
  select pg_get_functiondef('public.merge_incident(uuid,uuid,text,text,text)'::regprocedure) into v_def;
  foreach v_stmt in array v_removed loop
    if position(v_stmt in v_def) = 0 then
      raise exception 'merge_incident(): expected statement not found, nothing changed: %', v_stmt;
    end if;
    v_def := replace(v_def, v_stmt, '');
  end loop;
  if v_def ~ '\m(device_sync_state|experiment_observer_notes|high_risk_override_confirmations|patient_edit_conflicts|sync_event_dependencies|realtime_outbox|supply_request_items|treatment_catalog|treatment_inventory_items)\M' then
    raise exception 'merge_incident() still names a table being archived';
  end if;
  execute v_def;
end
$do$;

-- ---------------------------------------------------------------------------------------------
-- 3. Archive schema
-- ---------------------------------------------------------------------------------------------
create schema if not exists archive;
comment on schema archive is
  'Tables nothing reads or writes any more (database/070, WP-15). Kept with their rows; not reachable through the API.';
revoke all on schema archive from public, anon, authenticated;

alter table public.device_sync_state set schema archive;
alter table public.experiment_observer_notes set schema archive;
alter table public.high_risk_override_confirmations set schema archive;
alter table public.patient_edit_conflicts set schema archive;
alter table public.sync_event_dependencies set schema archive;
alter table public.supply_request_items set schema archive;
alter table public.treatment_inventory_items set schema archive;
alter table public.treatment_catalog set schema archive;
alter table public.realtime_outbox set schema archive;
