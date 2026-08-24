-- F3: field-level conflict resolution for cross-device concurrent edits to
-- the same patient (docs/FAILURE_MODE_REVIEW.md F3, docs/CONFLICT_RESOLUTION_DECISION.md).
-- Requires 019/020 (physician/paramedic roles + their RLS) to already be applied.
--
-- Mechanism: PATIENT_TRIAGE_UPDATED/PATIENT_STATUS_UPDATED stop being pure
-- last-write-wins overwrites. A genuine same-field collision (different value,
-- within a short window of the incumbent's own recorded timestamp) is resolved
-- by role-authority rank (physician > paramedic > cc > pc > medic); outside
-- that window it's treated as a legitimate later reassessment and falls back to
-- plain last-write-wins, unchanged from pre-F3 behavior. Every authority-decided
-- override is logged to conflict_log, never silent. Scope is deliberately
-- narrow to these two event types - PATIENT_TRIAGED_EXPECTANT, PATIENT_HANDED_OVER,
-- and the treatment-implied 'stabilizing' status write are lifecycle-terminal/
-- side-effect writes, not the deliberate concurrent field edits F3's failure
-- scenario (triage override vs. medication administration) describes, and keep
-- their existing guards unchanged.

-- Note: 'PATIENT_FIELD_CONFLICT_DETECTED' is used below only as a
-- conflict_log.conflict_type value - that column is text, not the event_type
-- enum, so no enum change is needed. It's deliberately never inserted as a
-- real events row either: unlike MSTART_OVERRIDE/SYNC_CONFLICT/etc. (genuine
-- client-submitted events apply_event_projection_and_outbox() reacts to), a
-- field-authority conflict isn't submitted by any device - it's discovered by
-- this trigger while projecting an ordinary PATIENT_TRIAGE_UPDATED/
-- PATIENT_STATUS_UPDATED event. Synthesizing a fake events row for it would
-- need a synthetic device_id/local_event_id and would recursively re-invoke
-- this same trigger for no functional gain, since nothing today builds an
-- events-table-driven conflict view.

-- ── Field-authority state on patients (reuses the existing "latest value +
-- latest timestamp" shape already used by triage_recorded_at/status_recorded_at
-- - full field history is already available for free via the append-only
-- events table itself, so a side table would add write-path complexity for no
-- behavior this feature needs) ──────────────────────────────────────────────

alter table patients
  add column if not exists triage_set_by_role user_role,
  add column if not exists triage_set_by_event_id uuid references events(id),
  add column if not exists status_set_by_role user_role,
  add column if not exists status_set_by_event_id uuid references events(id);

-- Backfill from the most recent matching event per patient. actor_role has
-- existed on events since the beginning, so this is fully backfillable, not
-- just best-effort. Looks across every branch that can set current_status
-- today (not just PATIENT_STATUS_UPDATED), so a patient whose last status
-- write actually came from PATIENT_TRIAGED_EXPECTANT/PATIENT_HANDED_OVER/a
-- treatment-implied branch doesn't end up with stale/null role data.
update patients p
set triage_set_by_role = e.actor_role, triage_set_by_event_id = e.id
from (
  select distinct on (patient_id) patient_id, id, actor_role
  from events
  where type = 'PATIENT_TRIAGE_UPDATED' and patient_id is not null
  order by patient_id, local_timestamp desc
) e
where e.patient_id = p.id and p.triage_recorded_at is not null;

update patients p
set status_set_by_role = e.actor_role, status_set_by_event_id = e.id
from (
  select distinct on (patient_id) patient_id, id, actor_role
  from events
  where patient_id is not null
    and type in (
      'PATIENT_STATUS_UPDATED', 'PATIENT_TRIAGED_EXPECTANT', 'PATIENT_HANDED_OVER',
      'TOURNIQUET_APPLIED', 'MEDICATION_ADMINISTERED', 'AIRWAY_MANAGED', 'VITALS_RECORDED'
    )
  order by patient_id, local_timestamp desc
) e
where e.patient_id = p.id and p.status_recorded_at is not null;

-- ── Role-authority rank ──────────────────────────────────────────────────

create or replace function app.role_authority_rank(r user_role)
returns int
language sql
immutable
set search_path = 'public'
as $function$
  select case r
    when 'physician' then 5
    when 'paramedic' then 4
    when 'cc'        then 3
    when 'pc'        then 2
    when 'medic'     then 1
    else 0  -- chamal, admin, logistics_officer, rpc, rcc, and any future role: not part of
            -- the clinical tie-break (docs/CONFLICT_RESOLUTION_DECISION.md). Rank 0 (below
            -- medic) is a deliberate safe default - e.g. admin bypasses
            -- ROLE_ALLOWED_EVENT_TYPES entirely in the sync-log Edge Function, so an
            -- admin/test push must never silently outrank a real clinical role's edit.
  end
$function$;
revoke execute on function app.role_authority_rank(user_role) from public, anon, authenticated;

-- ── Field-authority decision helper (shared by triage and status) ───────────

drop type if exists app.field_authority_decision cascade;
create type app.field_authority_decision as (
  new_wins boolean,
  is_collision boolean,          -- genuine same-field, same-window, different-value edit
  authority_decided boolean,     -- is_collision and the two ranks actually differ
  incumbent_role user_role,
  incumbent_recorded_at timestamptz
);

-- 5-minute collision window: a reasoned starting default (client syncs every 45s
-- plus realistic offline-reconnect slack), not something the decision doc pins
-- exactly - adjustable from real field-drill data later
-- (docs/FIELD_USABILITY_TEST_PLAN.md).
create or replace function app.resolve_field_authority(
  p_incumbent_recorded_at timestamptz,
  p_incumbent_role user_role,
  p_incumbent_value text,
  p_new_recorded_at timestamptz,
  p_new_role user_role,
  p_new_value text,
  p_window_seconds int default 300
) returns app.field_authority_decision
language plpgsql
immutable
set search_path = 'public'
as $function$
declare
  d app.field_authority_decision;
  new_rank int := app.role_authority_rank(p_new_role);
  incumbent_rank int := coalesce(app.role_authority_rank(p_incumbent_role), -1);
begin
  d.incumbent_role := p_incumbent_role;
  d.incumbent_recorded_at := p_incumbent_recorded_at;

  -- No prior value recorded at all: nothing to conflict with.
  if p_incumbent_recorded_at is null then
    d.is_collision := false; d.authority_decided := false; d.new_wins := true;
    return d;
  end if;

  -- Same value being reasserted (retry/idempotent duplicate, or two devices
  -- independently confirming the same clinical conclusion): not a real conflict.
  if p_new_value is not distinct from p_incumbent_value then
    d.is_collision := false; d.authority_decided := false;
    d.new_wins := p_new_recorded_at >= p_incumbent_recorded_at;
    return d;
  end if;

  -- Genuine collision = different value AND within the collision window of the
  -- incumbent's recorded timestamp. Outside the window this is a legitimate
  -- later reassessment, not a concurrent-edit conflict - plain last-write-wins
  -- (unchanged pre-F3 behavior) applies, so an old authority edit can never
  -- permanently freeze a patient's projected state against real, later data.
  d.is_collision := abs(extract(epoch from (p_new_recorded_at - p_incumbent_recorded_at))) <= p_window_seconds;

  if d.is_collision then
    -- Authority overrides arrival order within the window (per the decision
    -- doc's "regardless of which event's trigger happened to fire last"),
    -- not just simultaneity ties.
    d.authority_decided := (new_rank <> incumbent_rank);
    d.new_wins := new_rank > incumbent_rank
      or (new_rank = incumbent_rank and p_new_recorded_at >= p_incumbent_recorded_at);
  else
    d.authority_decided := false;
    d.new_wins := p_new_recorded_at >= p_incumbent_recorded_at;
  end if;

  return d;
end;
$function$;
revoke execute on function app.resolve_field_authority(timestamptz,user_role,text,timestamptz,user_role,text,int) from public, anon, authenticated;

-- ── Conflict logging ─────────────────────────────────────────────────────
-- winning/losing role+value go in payload_json and a human-readable
-- description, not algorithm_value/human_value (those are MSTART/JUMPSTART-
-- specific: "algorithm suggested X, human overrode with Y" - a different
-- concept from two humans' edits colliding). Also logs equal-rank genuine
-- collisions (e.g. two medics, same field, same window) at lower severity -
-- the decision doc's "surfaced, not silent" principle reads as applying to
-- any real silent-loss case, not only authority-decided ones.

create or replace function app.log_field_authority_conflict(
  p_incident_id uuid, p_patient_id uuid, p_actor_id uuid, p_event_id uuid,
  p_field text, p_winning_role user_role, p_losing_role user_role,
  p_winning_value text, p_losing_value text,
  p_winning_event_id uuid, p_losing_event_id uuid,
  p_authority_decided boolean
) returns void
language plpgsql
security definer
set search_path = 'public'
as $function$
begin
  insert into conflict_log (
    incident_id, event_id, patient_id, actor_id, conflict_type, severity,
    reason, description, payload_json
  ) values (
    p_incident_id, p_event_id, p_patient_id, p_actor_id,
    'PATIENT_FIELD_CONFLICT_DETECTED',
    case when p_authority_decided then 'high' else 'medium' end,
    case when p_authority_decided then 'role_authority_tiebreak' else 'concurrent_edit_no_authority_difference' end,
    format('%s on %s: %s edit (%s) %s %s edit (%s)',
      case when p_authority_decided then 'Role-authority override' else 'Concurrent edit, same authority' end,
      p_field, p_winning_role, p_winning_value,
      case when p_winning_role = p_losing_role then 'wins tie over' else 'overrides' end,
      p_losing_role, p_losing_value),
    jsonb_build_object(
      'field', p_field,
      'winning_role', p_winning_role, 'losing_role', p_losing_role,
      'winning_value', p_winning_value, 'losing_value', p_losing_value,
      'winning_event_id', p_winning_event_id, 'losing_event_id', p_losing_event_id
    )
  );
end;
$function$;
revoke execute on function app.log_field_authority_conflict(uuid,uuid,uuid,uuid,text,user_role,user_role,text,text,uuid,uuid,boolean) from public, anon, authenticated;

-- ── project_patient_state() rewrite ──────────────────────────────────────
-- Full function replacement (same signature/security as 013's version).
-- Every branch except PATIENT_TRIAGE_UPDATED/PATIENT_STATUS_UPDATED is
-- reproduced verbatim from the live definition (pulled via execute_sql
-- immediately before writing this file) - only those two branches change.
-- One small deliberate behavior refinement in both changed branches: they now
-- require the relevant payload key ('triage'/'status') to actually be present
-- before entering the branch at all, instead of 013's coalesce()-to-current-
-- value fallback. Net effect is the same (a malformed event with no
-- triage/status key still leaves the field unchanged) except it no longer
-- bumps triage_recorded_at/status_recorded_at/version for a no-op - avoids
-- ever computing a decision against a NULL new value, which the coalesce()
-- approach would have silently smoothed over instead of catching.

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
  end if;

  return new;
end;
$function$;
