-- Real physician-only "confirms death" clinical action. Requires 024 (the
-- PATIENT_DEATH_CONFIRMED enum value) to already be applied.
--
-- Distinct from official/legal death certification (stays out of scope, per
-- docs/CONFLICT_RESOLUTION_DECISION.md) - this records one authenticated
-- clinical fact: "a physician reviewed this patient and confirms death",
-- alongside the medic's existing field black-tag (PATIENT_TRIAGED_EXPECTANT,
-- unchanged, still open to every clinical role).
--
-- Mirrors the high_risk_override_confirmations pattern (004): events RLS
-- gates only by role membership, not by event type (see 022's comment on
-- events_insert_by_role), so a second, narrowly-scoped table with its own
-- INSERT policy is what actually makes this physician-exclusive at the
-- database level, rather than relying solely on the sync-log Edge Function's
-- ROLE_ALLOWED_EVENT_TYPES (defense in depth, not a replacement for it).

-- ── patients: record who/when, mirroring handed_over_at/handed_over_to's
-- "plain column set by one dedicated trigger branch" shape (021) ───────────

alter table patients
  add column if not exists physician_death_confirmed_at timestamptz,
  add column if not exists physician_death_confirmed_by uuid references profiles(id);

-- ── death_confirmations: the actual physician-only-write audit record ──────

create table if not exists death_confirmations (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid references incidents(id) on delete cascade,
  patient_id uuid references patients(id) on delete cascade,
  event_id uuid references events(id) on delete cascade,
  actor_id uuid references profiles(id),
  notes text,
  confirmed_at timestamptz not null default now(),
  unique (event_id)
);

create index if not exists idx_death_confirmations_patient
on death_confirmations(patient_id);

alter table death_confirmations enable row level security;

drop policy if exists death_confirmations_read on death_confirmations;
create policy death_confirmations_read on death_confirmations for select to authenticated using (
  app.can_access_incident(incident_id) and (app.is_command_role() or actor_id = (select auth.uid()))
);

-- physician-only, matching high_risk_override_insert's shape (023) but with
-- a single-role check instead of an array, since this action has no second
-- authorized role by design (docs/CONFLICT_RESOLUTION_DECISION.md: "official
-- death certification stays physician-only" is the one deliberate exception
-- to paramedic/physician clinical-authority parity).
drop policy if exists death_confirmations_insert on death_confirmations;
create policy death_confirmations_insert on death_confirmations for insert to authenticated with check (
  app.can_access_incident(incident_id)
  and actor_id = (select auth.uid())
  and (select app.current_user_role()) = 'physician'
);

-- ── project_patient_state(): add the PATIENT_DEATH_CONFIRMED branch ────────
-- Every other branch reproduced verbatim from the live definition (pulled via
-- execute_sql immediately before writing this file - no drift from 021).
-- The new branch is a pure "record a fact" write, same shape as
-- PATIENT_HANDED_OVER's handed_over_at/handed_over_to: it does not touch
-- current_triage/current_status (already 'black'/'deceased' from the medic's
-- own PATIENT_TRIAGED_EXPECTANT event), and is guarded to only apply once the
-- patient is already field-tagged deceased - a physician confirming a patient
-- nobody has black-tagged yet is a no-op here, not an error (same "server
-- preserves received data, the event itself is never lost" philosophy used
-- throughout this trigger). coalesce() makes a second confirmation event
-- idempotent rather than overwriting the first physician's timestamp/identity.

create or replace function public.project_patient_state()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $function$
declare
  v_incumbent record;
  v_new_value text;
  v_decision app.field_authority_decision;
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
  -- Deliberately NOT routed through the F3 authority mechanism - a lifecycle-terminal
  -- transition, not the deliberate concurrent field edit F3 targets (see migration header).
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

  -- Treatment actions imply active stabilization at the point of care. Side-effect status
  -- write, not a deliberate "I am setting this patient's status" act - not routed through F3.
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

  -- F3: field-level authority resolution (docs/CONFLICT_RESOLUTION_DECISION.md).
  elsif new.type = 'PATIENT_TRIAGE_UPDATED' and new.payload_json ? 'triage' then
    v_new_value := new.payload_json->>'triage';

    select current_triage::text as value, triage_recorded_at as recorded_at, triage_set_by_role as role
      into v_incumbent from patients where id = new.patient_id for update;

    v_decision := app.resolve_field_authority(
      v_incumbent.recorded_at, v_incumbent.role, v_incumbent.value,
      new.local_timestamp, new.actor_role, v_new_value
    );

    if v_decision.new_wins then
      update patients
      set current_triage = v_new_value::triage_level,
          algorithm_triage = coalesce((new.payload_json->>'algorithm_triage')::triage_level, algorithm_triage),
          triage_recorded_at = new.local_timestamp,
          triage_set_by_role = new.actor_role,
          triage_set_by_event_id = new.id,
          updated_at = now(), version = version + 1
      where id = new.patient_id;
    end if;

    if v_decision.is_collision then
      perform app.log_field_authority_conflict(
        new.incident_id, new.patient_id, new.actor_id, new.id, 'current_triage',
        case when v_decision.new_wins then new.actor_role else v_decision.incumbent_role end,
        case when v_decision.new_wins then v_decision.incumbent_role else new.actor_role end,
        case when v_decision.new_wins then v_new_value else v_incumbent.value end,
        case when v_decision.new_wins then v_incumbent.value else v_new_value end,
        case when v_decision.new_wins then new.id else null end,
        case when v_decision.new_wins then null else new.id end,
        v_decision.authority_decided
      );
    end if;

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

  -- F3: field-level authority resolution. Terminal-status guard (from 013) still applies
  -- FIRST - a terminal patient's status must never be reopened by this mechanism either.
  elsif new.type = 'PATIENT_STATUS_UPDATED' and new.payload_json ? 'status' then
    select current_status::text as value, status_recorded_at as recorded_at, status_set_by_role as role
      into v_incumbent from patients
      where id = new.patient_id
        and current_status not in ('deceased','handed_over','closed','self_evacuated')
      for update;

    if found then
      v_new_value := new.payload_json->>'status';

      v_decision := app.resolve_field_authority(
        v_incumbent.recorded_at, v_incumbent.role, v_incumbent.value,
        new.local_timestamp, new.actor_role, v_new_value
      );

      if v_decision.new_wins then
        update patients
        set current_status = v_new_value::patient_status,
            status_recorded_at = new.local_timestamp,
            status_set_by_role = new.actor_role,
            status_set_by_event_id = new.id,
            updated_at = now(), version = version + 1
        where id = new.patient_id;
      end if;

      if v_decision.is_collision then
        perform app.log_field_authority_conflict(
          new.incident_id, new.patient_id, new.actor_id, new.id, 'current_status',
          case when v_decision.new_wins then new.actor_role else v_decision.incumbent_role end,
          case when v_decision.new_wins then v_decision.incumbent_role else new.actor_role end,
          case when v_decision.new_wins then v_new_value else v_incumbent.value end,
          case when v_decision.new_wins then v_incumbent.value else v_new_value end,
          case when v_decision.new_wins then new.id else null end,
          case when v_decision.new_wins then null else new.id end,
          v_decision.authority_decided
        );
      end if;
    end if;

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
  -- status, not just 'deceased', matching canChangePatientStatus() client-side. Deliberately
  -- NOT routed through F3 - a lifecycle-terminal transition, not a deliberate field edit.
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

  -- Real physician-only clinical death confirmation (distinct from any legal
  -- certification, which stays out of scope). Pure fact-recording, mirroring
  -- PATIENT_HANDED_OVER's handed_over_at/handed_over_to shape - does not
  -- re-derive current_triage/current_status, which are already 'black'/
  -- 'deceased' from the medic's own PATIENT_TRIAGED_EXPECTANT event. Guarded
  -- to patients already field-tagged deceased; a confirmation submitted for
  -- any other patient is a silent no-op here (the audit event itself is
  -- still written to the events log either way - see death_confirmations
  -- insert below, which is unconditional). coalesce() makes a second
  -- confirmation idempotent rather than overwriting the first physician.
  elsif new.type = 'PATIENT_DEATH_CONFIRMED' then
    update patients
    set physician_death_confirmed_at = coalesce(physician_death_confirmed_at, new.local_timestamp),
        physician_death_confirmed_by = coalesce(physician_death_confirmed_by, new.actor_id),
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and current_status = 'deceased';

    insert into death_confirmations (incident_id, patient_id, event_id, actor_id, notes)
    values (new.incident_id, new.patient_id, new.id, new.actor_id, new.payload_json->>'notes')
    on conflict (event_id) do nothing;
  end if;

  return new;
end;
$function$;
