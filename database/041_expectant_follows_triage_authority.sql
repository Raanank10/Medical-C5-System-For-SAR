-- A medic's black (expectant) triage follows the same role-authority rule as every other triage
-- change, and a higher-authority triage that overrides a black restores the patient's status.
--
-- Gap (found live 2026-10-15 while fixing triage sync, docs/CONFLICT_RESOLUTION_DECISION.md
-- "Open question"): project_patient_state() handled PATIENT_TRIAGED_EXPECTANT in its own branch,
-- outside app.resolve_field_authority(). A medic's black therefore always overrode a pc's green
-- set a minute earlier and made the patient deceased. That branch also never recorded who set the
-- triage (triage_set_by_role / triage_set_by_event_id) and kept the old triage_recorded_at, so
-- after a black the server still believed the earlier role and time owned the triage.
--
-- Decided with the repo owner 2026-10-16:
-- - Black uses the same 5-minute rule as PATIENT_TRIAGE_UPDATED: within 5 minutes of a different
--   triage, the higher role (physician > paramedic > cc > pc > medic) wins and the loser is
--   written to conflict_log (PATIENT_FIELD_CONFLICT_DETECTED). More than 5 minutes apart, the
--   later value wins as a reassessment.
-- - When a red/yellow/green triage wins over a black, the status the patient had before the
--   black is restored (saved in patients.pre_expectant_status when the black was applied), or
--   'identified' if none was saved.
-- - Once a physician has confirmed the death (PATIENT_DEATH_CONFIRMED, physician-only), only a
--   physician can move the triage away from black. Anyone else's red/yellow/green is not applied
--   and is logged as an authority conflict (otherwise triage would read green while the status
--   stays deceased, and PATIENT_STATUS_UPDATED never touches a deceased patient). A physician who
--   does reverse it also restores the status and clears physician_death_confirmed_at/by on the
--   patient row; the confirmation itself stays in death_confirmations and the event log.
-- Everything else in the function is unchanged from the live definition (database/021 + later).

alter table patients add column if not exists pre_expectant_status patient_status;

comment on column patients.pre_expectant_status is
  'Status before a black/expectant triage made the patient deceased; restored if a winning non-black triage reverses it (database/041).';

create or replace function public.project_patient_state()
returns trigger
language plpgsql
security definer
set search_path to 'public'
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

  elsif new.type = 'PATIENT_TRIAGED_EXPECTANT' or new.payload_json->>'current_triage' = 'black' then
    -- database/041: same authority rule as PATIENT_TRIAGE_UPDATED (see header).
    select current_triage::text as value, triage_recorded_at as recorded_at, triage_set_by_role as role,
           current_status
      into v_incumbent from patients
      where id = new.patient_id
        and current_status not in ('handed_over','closed','self_evacuated')
      for update;

    if found then
      v_decision := app.resolve_field_authority(
        v_incumbent.recorded_at, v_incumbent.role, v_incumbent.value,
        new.local_timestamp, new.actor_role, 'black'
      );

      if v_decision.new_wins then
        update patients
        set pre_expectant_status = case when current_status <> 'deceased' then current_status else pre_expectant_status end,
            current_status = 'deceased',
            current_triage = 'black',
            needs_full_assessment = false,
            triage_recorded_at = new.local_timestamp,
            triage_set_by_role = new.actor_role,
            triage_set_by_event_id = new.id,
            status_recorded_at = new.local_timestamp,
            status_set_by_role = new.actor_role,
            status_set_by_event_id = new.id,
            updated_at = now(),
            version = version + 1
        where id = new.patient_id;
      end if;

      if v_decision.is_collision then
        perform app.log_field_authority_conflict(
          new.incident_id, new.patient_id, new.actor_id, new.id, 'current_triage',
          case when v_decision.new_wins then new.actor_role else v_decision.incumbent_role end,
          case when v_decision.new_wins then v_decision.incumbent_role else new.actor_role end,
          case when v_decision.new_wins then 'black' else v_incumbent.value end,
          case when v_decision.new_wins then v_incumbent.value else 'black' end,
          case when v_decision.new_wins then new.id else null end,
          case when v_decision.new_wins then null else new.id end,
          v_decision.authority_decided
        );
      end if;
    end if;

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

  elsif new.type = 'PATIENT_TRIAGE_UPDATED' and new.payload_json ? 'triage' then
    v_new_value := new.payload_json->>'triage';

    select current_triage::text as value, triage_recorded_at as recorded_at, triage_set_by_role as role,
           physician_death_confirmed_at
      into v_incumbent from patients where id = new.patient_id for update;

    v_decision := app.resolve_field_authority(
      v_incumbent.recorded_at, v_incumbent.role, v_incumbent.value,
      new.local_timestamp, new.actor_role, v_new_value
    );

    -- database/041: a physician-confirmed death keeps the triage black for everyone but a physician.
    if v_incumbent.value = 'black' and v_new_value <> 'black'
       and v_incumbent.physician_death_confirmed_at is not null
       and new.actor_role is distinct from 'physician' then
      v_decision.new_wins := false;
      v_decision.is_collision := true;
      v_decision.authority_decided := true;
      v_decision.incumbent_role := 'physician';
    end if;

    if v_decision.new_wins then
      update patients
      set current_triage = v_new_value::triage_level,
          algorithm_triage = coalesce((new.payload_json->>'algorithm_triage')::triage_level, algorithm_triage),
          triage_recorded_at = new.local_timestamp,
          triage_set_by_role = new.actor_role,
          triage_set_by_event_id = new.id,
          updated_at = now(), version = version + 1
      where id = new.patient_id;

      -- database/041: a winning non-black triage over a black reverses the deceased status the
      -- black set. Past the guard above, a physician-confirmed death only gets here from a physician.
      if v_incumbent.value = 'black' and v_new_value <> 'black' then
        update patients
        set current_status = coalesce(pre_expectant_status, 'identified'),
            pre_expectant_status = null,
            physician_death_confirmed_at = null,
            physician_death_confirmed_by = null,
            status_recorded_at = new.local_timestamp,
            status_set_by_role = new.actor_role,
            status_set_by_event_id = new.id,
            updated_at = now(), version = version + 1
        where id = new.patient_id
          and current_status = 'deceased';
      end if;
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
