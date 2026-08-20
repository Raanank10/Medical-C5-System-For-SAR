-- Fixes two related bugs found while extending the "left site to collection point" handover
-- work (index.html PR #19-20 equivalent, client-side): patient status projection for events
-- was split across two independent triggers on `events` (audit_project_lifecycle_status ->
-- trg_project_patient_lifecycle_status(), and trg_events_projection_outbox ->
-- apply_event_projection_and_outbox()), both of which wrote to `patients.current_status` for
-- overlapping event types (PATIENT_TRIAGED_EXPECTANT, PATIENT_HANDED_OVER) with different,
-- undocumented guards. Postgres fires same-timing AFTER INSERT triggers on a table in
-- alphabetical order by trigger name, so audit_project_lifecycle_status always ran first; its
-- guard (`current_status <> 'deceased'`) was then silently overwritten by
-- trg_events_projection_outbox running second with no guard at all.
--
-- 1. PATIENT_HANDED_OVER wrote current_status = 'evacuating' in both triggers - disagreeing
--    with the client (index.html's handoverPatient()) and C5_SENTINEL_SAR_MVP_SPEC_v1.2.md,
--    which both use 'handed_over'. This became a real conflict once the client grew a distinct
--    'evacuating' status for "left the incident site for the company collection point, still
--    under the platoon commander's supervision, not yet formally handed to MDA" - if an actual
--    completed handover also produced 'evacuating' server-side, that intermediate state and the
--    final one would be indistinguishable in projected data. Confirmed live: patient TMP-001
--    has a real PATIENT_HANDED_OVER event and handed_over_at set, but was stuck at
--    current_status='evacuating' because of exactly this bug. 'handed_over' is correct and is
--    what this migration standardizes on; API_SURFACE_v1.2.md is updated to match in the same
--    change (see docs).
--
-- 2. Neither trigger's guard covered the full set of terminal statuses - only 'deceased' was
--    protected (in one of the two), not 'handed_over'/'closed'/'self_evacuated', and
--    PATIENT_STATUS_UPDATED's projection (used by the collection-point button) had no
--    terminal-status guard whatsoever, only a last-write-wins timestamp check. This mirrors the
--    client-side canChangePatientStatus() guard added in src/domain/rules.js - applied here
--    consistently to every projection branch that writes current_status, not just
--    PATIENT_HANDED_OVER. Note 'evacuated' (present in the client's FINAL_PATIENT_STATUSES) has
--    no corresponding patient_status enum value here - only 'evacuating' exists - so the
--    server-side guard list is the four enum values that are actually terminal:
--    deceased/handed_over/closed/self_evacuated.
--
-- Fix: consolidate all patient-column projection into ONE function (project_patient_state()),
-- so there is exactly one place this happens and no ordering-dependent race is possible.
-- apply_event_projection_and_outbox() keeps only its conflict_log/realtime_outbox side effects,
-- which never touched `patients` and were never part of this race.
-- trg_project_patient_lifecycle_status()/audit_project_lifecycle_status are dropped entirely -
-- superseded by project_patient_state().

-- =========================================================
-- New consolidated patient-state projection function
-- =========================================================

create or replace function project_patient_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.patient_id is null then
    return new;
  end if;

  if new.type = 'VITALS_RECORDED' then
    update patients
    set last_vitals_at = new.local_timestamp,
        last_seen_at = new.local_timestamp,
        needs_full_assessment = false,
        current_status = case when current_status = 'stabilizing' then 'observing' else current_status end,
        status_recorded_at = case when current_status = 'stabilizing' then new.local_timestamp else status_recorded_at end,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id;

  -- Fast-path Black/expectant handling: no further assessment debt. Preserves an earlier
  -- triage_recorded_at if one already exists, rather than overwriting it with the black-triage
  -- timestamp (matches the pre-consolidation behavior of trg_project_patient_lifecycle_status).
  elsif new.type = 'PATIENT_TRIAGED_EXPECTANT' or new.payload_json->>'current_triage' = 'black' then
    update patients
    set current_status = 'deceased',
        current_triage = 'black',
        needs_full_assessment = false,
        triage_recorded_at = coalesce(triage_recorded_at, new.local_timestamp),
        status_recorded_at = new.local_timestamp,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and current_status not in ('handed_over','closed','self_evacuated');

  -- Treatment actions imply active stabilization at the point of care.
  elsif new.type in ('TOURNIQUET_APPLIED','MEDICATION_ADMINISTERED','AIRWAY_MANAGED') then
    update patients
    set current_status = 'stabilizing',
        status_recorded_at = new.local_timestamp,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and current_status in ('identified','unknown','treating');

  elsif new.type = 'MINIMAL_TRIAGE_RECORDED' or new.type = 'QUICK_PATIENT_CREATED' then
    update patients
    set pulse_present = coalesce((new.payload_json->>'pulse_present')::boolean, pulse_present),
        breathing_present = coalesce((new.payload_json->>'breathing_present')::boolean, breathing_present),
        tourniquet_used = coalesce((new.payload_json->>'tourniquet_used')::boolean, tourniquet_used),
        injury_zones = coalesce(new.payload_json->'injury_zones', injury_zones),
        needs_full_assessment = true,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id;

  elsif new.type = 'PATIENT_TRIAGE_UPDATED' then
    update patients
    set current_triage = coalesce((new.payload_json->>'triage')::triage_level, current_triage),
        algorithm_triage = coalesce((new.payload_json->>'algorithm_triage')::triage_level, algorithm_triage),
        triage_recorded_at = new.local_timestamp,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and (triage_recorded_at is null or new.local_timestamp >= triage_recorded_at);

  elsif new.type = 'PATIENT_ACCESS_UPDATED' then
    update patients
    set access_status = coalesce(
          case
            when new.payload_json->>'trap_status' = 'trapped' then 'trapped'::access_status
            when new.payload_json->>'trap_status' = 'not_trapped' then 'free'::access_status
            else null
          end,
          (new.payload_json->>'access_status')::access_status,
          access_status
        ),
        access_recorded_at = new.local_timestamp,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and (access_recorded_at is null or new.local_timestamp >= access_recorded_at);

  -- Used by the "left site to collection point" client action (status='evacuating') among
  -- others. Terminal-status guard added here: previously only a last-write-wins timestamp
  -- check, so a stray/replayed event could reopen an already handed-over/deceased/closed patient.
  elsif new.type = 'PATIENT_STATUS_UPDATED' then
    update patients
    set current_status = coalesce((new.payload_json->>'status')::patient_status, current_status),
        status_recorded_at = new.local_timestamp,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and (status_recorded_at is null or new.local_timestamp >= status_recorded_at)
      and current_status not in ('deceased','handed_over','closed','self_evacuated');

  elsif new.type = 'PATIENT_LOCATION_UPDATED' then
    update patients
    set location_json = coalesce(new.payload_json->'location', location_json),
        location_recorded_at = new.local_timestamp,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and (location_recorded_at is null or new.local_timestamp >= location_recorded_at);

  elsif new.type in ('PATIENT_CREATED','QUICK_PATIENT_CREATED','PATIENT_INJURY_UPDATED') then
    update patients
    set injury_zones = coalesce(new.payload_json->'injury_zones', injury_zones),
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and new.payload_json ? 'injury_zones';

  elsif new.type = 'PATIENT_T_INJURY_UPDATED' then
    update patients
    set t_injury = coalesce((new.payload_json->>'t_injury')::timestamptz, t_injury),
        updated_at = now(),
        version = version + 1
    where id = new.patient_id;

  -- MIST/secure QR handover: final custody transfer to MDA/evacuation. current_status =
  -- 'handed_over' (not 'evacuating' - see migration header). Guarded against every terminal
  -- status, not just 'deceased', matching canChangePatientStatus() client-side.
  elsif new.type = 'PATIENT_HANDED_OVER' then
    update patients
    set current_status = 'handed_over',
        handed_over_at = new.local_timestamp,
        handed_over_to = coalesce(
          new.payload_json->>'destination_facility',
          new.payload_json->>'receiving_unit_transport',
          new.payload_json->>'handover_to',
          'MDA / Evacuation'
        ),
        needs_full_assessment = false,
        last_seen_at = new.local_timestamp,
        status_recorded_at = new.local_timestamp,
        handover_token_used_at = case
          when new.payload_json->>'handover_method' = 'secure_qr_token' then coalesce(handover_token_used_at, new.local_timestamp)
          else handover_token_used_at
        end,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and current_status not in ('deceased','handed_over','closed','self_evacuated');

    update watchdog_alerts
    set resolved_at = coalesce(resolved_at, new.server_timestamp),
        resolved_by_event_id = new.id,
        suppressed_before_dashboard = true,
        updated_at = now(),
        version = version + 1
    where incident_id = new.incident_id
      and patient_id = new.patient_id
      and resolved_at is null
      and alert_type in (
        'VITALS_OVERDUE',
        'REASSESSMENT_OVERDUE',
        'TOURNIQUET_REASSESSMENT_OVERDUE',
        'TOURNIQUET_CRITICAL',
        'MISSING_FULL_ASSESSMENT'
      );

    if new.payload_json->>'handover_method' = 'secure_qr_token'
       and new.payload_json ? 'token_hash'
       and new.payload_json ? 'token_signature' then
      insert into patient_handover_tokens (
        incident_id,
        patient_id,
        source_event_id,
        handover_method,
        destination_facility,
        receiving_unit_transport,
        token_hash,
        token_signature,
        encrypted_link,
        expires_at
      )
      values (
        new.incident_id,
        new.patient_id,
        new.id,
        new.payload_json->>'handover_method',
        new.payload_json->>'destination_facility',
        new.payload_json->>'receiving_unit_transport',
        new.payload_json->>'token_hash',
        new.payload_json->>'token_signature',
        new.payload_json->>'encrypted_link',
        coalesce((new.payload_json->>'token_expires_at')::timestamptz, new.server_timestamp + interval '15 minutes')
      )
      on conflict (token_hash) do nothing;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function project_patient_state() from public, anon, authenticated;

-- =========================================================
-- apply_event_projection_and_outbox() keeps only its conflict_log/realtime_outbox side effects.
-- Every `patients` UPDATE branch that used to live here moved into project_patient_state() above.
-- =========================================================

create or replace function apply_event_projection_and_outbox()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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

  if new.type in (
    'PATIENT_CREATED','QUICK_PATIENT_CREATED','VITALS_RECORDED','MINIMAL_TRIAGE_RECORDED',
    'PATIENT_TRIAGE_UPDATED','PATIENT_STATUS_UPDATED','PATIENT_HANDED_OVER','PATIENT_TRIAGED_EXPECTANT',
    'INTERVENTION_RECORDED','MEDICATION_ADMINISTERED','AIRWAY_MANAGED','TOURNIQUET_APPLIED','TOURNIQUET_RELEASED','TREATMENT_SAFETY_WARNING','HIGH_RISK_CLINICAL_VIOLATION',
    'WATCHDOG_ALERT','SUPPLY_REQUEST_CREATED','SUPPLY_REQUEST_DISPATCHED','SUPPLY_REQUEST_IN_TRANSIT','SUPPLY_REQUEST_RECEIVED',
    'BUILDING_STATUS_UPDATED','SITE_CLEAR_CONFIRMED','SYNC_CONFLICT','MSTART_OVERRIDE','JUMPSTART_OVERRIDE'
  ) then
    insert into realtime_outbox (event_id, incident_id, patient_id, event_type, channel, payload_json)
    values (new.id, new.incident_id, new.patient_id, new.type, 'chamal', new.payload_json);
  end if;

  return new;
end;
$$;

revoke execute on function apply_event_projection_and_outbox() from public, anon, authenticated;

-- =========================================================
-- Retire the superseded trigger/function; wire up the new one.
-- =========================================================

drop trigger if exists audit_project_lifecycle_status on events;
drop function if exists trg_project_patient_lifecycle_status();

drop trigger if exists trg_project_patient_state on events;
create trigger trg_project_patient_state
after insert on events
for each row execute function project_patient_state();

-- =========================================================
-- Backfill: patients already stuck at current_status='evacuating' from a real completed
-- handover (handed_over_at set by the old buggy trigger, which computed it correctly - only
-- current_status was wrong). Confirmed one such row live (TMP-001) before writing this.
-- =========================================================

update patients
set current_status = 'handed_over',
    status_recorded_at = greatest(coalesce(status_recorded_at, handed_over_at), handed_over_at),
    updated_at = now(),
    version = version + 1
where current_status = 'evacuating'
  and handed_over_at is not null;
