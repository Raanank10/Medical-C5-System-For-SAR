-- A casualty counts as fully assessed only when all five vital signs were recorded (owner,
-- 2026-10-23: "full assessment is only when all the vital signs are measured").
--
-- Before this file (measured live 2026-10-23, read-only):
-- - project_patient_state() (database/041, unchanged live) set patients.needs_full_assessment =
--   false on ANY VITALS_RECORDED, even one carrying only a pulse.
-- - patients.needs_full_assessment defaults to false, so a casualty created with PATIENT_CREATED
--   (the full patient flow) counted as fully assessed from creation, with no vitals at all. Only
--   QUICK_PATIENT_CREATED / MINIMAL_TRIAGE_RECORDED set it to true.
-- Both fed incident_command_state.patients_missing_full_vitals, the watchdog (072) and the AAR.
--
-- Rule (same as the phone since V2.99.61, hasMeasuredVitals() in index.html): across all of the
-- casualty's VITALS_RECORDED events there was at least once
--   - a numeric pulse and a numeric breathing rate (a range such as rr_range '10-30' is not a count),
--   - a numeric SpO2, or spo2_unavailable = true ("אין מד סטורציה"),
--   - an AVPU (A/V/P/U),
--   - a blood pressure / perfusion estimate.
-- Since V2.99.61 phones send only what was measured (no 80 / 16 / 98 stand-ins). Events from older
-- builds may still carry those stand-ins; they cannot be told apart here and count as measured.
--
-- How: a separate AFTER INSERT trigger, trg_project_vitals_completeness, instead of editing the
-- 13 kB project_patient_state(). Postgres fires same-event triggers in name order, so it runs after
-- trg_events_projection_outbox and trg_project_patient_state (which may have just set the value)
-- and before trg_refresh_command_state_after_event (so the command counts see the result).
-- On VITALS_RECORDED and PATIENT_CREATED it sets needs_full_assessment = not complete, except for
-- a casualty that is black, deceased, handed over, closed or self-evacuated: those were cleared on
-- purpose by the expectant / handover branches and stay as they are.
-- Existing rows are not recomputed; the rule applies from the next event of each casualty.
-- Nothing here raises (same rule as 044/050/052/054/057): a raise in an AFTER INSERT trigger would
-- roll back the event insert and lose the field record.

create or replace function app.vitals_set_complete(p_patient_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
       bool_or((e.payload_json->>'pulse') ~ '^[0-9]+(\.[0-9]+)?$')
   and bool_or((e.payload_json->>'rr') ~ '^[0-9]+(\.[0-9]+)?$')
   and bool_or((e.payload_json->>'spo2') ~ '^[0-9]+(\.[0-9]+)?$' or (e.payload_json->>'spo2_unavailable') = 'true')
   and bool_or((e.payload_json->>'avpu') in ('A','V','P','U'))
   and bool_or(nullif(btrim(e.payload_json->>'bp_estimate'), '') is not null),
   false)
  from events e
  where e.patient_id = p_patient_id
    and e.type = 'VITALS_RECORDED';
$function$;

comment on function app.vitals_set_complete(uuid) is
  'True once the casualty''s VITALS_RECORDED events together hold a counted pulse and breathing rate, SpO2 or spo2_unavailable, AVPU and a blood pressure estimate (database/073).';

create or replace function public.project_vitals_completeness()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_needs boolean;
begin
  if new.patient_id is null or new.type::text not in ('VITALS_RECORDED','PATIENT_CREATED') then
    return new;
  end if;
  begin
    v_needs := not app.vitals_set_complete(new.patient_id);
    update patients p
       set needs_full_assessment = v_needs,
           updated_at = now(),
           version = coalesce(p.version, 0) + 1
     where p.id = new.patient_id
       and coalesce(p.current_triage::text, '') <> 'black'
       and coalesce(p.current_status::text, '') not in ('deceased','handed_over','closed','self_evacuated')
       and p.needs_full_assessment is distinct from v_needs;
  exception when others then
    raise warning 'project_vitals_completeness: % (event %)', sqlerrm, new.id;
  end;
  return new;
end;
$function$;

drop trigger if exists trg_project_vitals_completeness on events;
create trigger trg_project_vitals_completeness
after insert on events
for each row
when (new.type::text in ('VITALS_RECORDED','PATIENT_CREATED'))
execute function public.project_vitals_completeness();

-- Not callable through /rest/v1/rpc (database/046).
revoke all on function public.project_vitals_completeness() from public, anon, authenticated;
revoke all on function app.vitals_set_complete(uuid) from public, anon, authenticated;
