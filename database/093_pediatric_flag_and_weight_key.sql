-- The server learns which casualty is a child, and the missing-weight check reads the weight the
-- phone sends (owner, 2026-11-21).
--
-- Measured live 2026-11-21 (read-only):
-- - Nothing set patients.is_pediatric (default false): the phone never sent the age group, and no
--   function wrote the column. Of 27 patients one was pediatric, a test row set by hand
--   (TEST-DEVICE, 2026-08-19). Other phones build a remote patient's age group from it
--   (remotePatientRecord in index.html), so a child registered on one phone showed as an adult on
--   every other phone and command, and the pediatric dose guard did not apply there.
-- - flag_pediatric_medication_missing_weight() looked for payload_json.weight_estimate_kg; the phone
--   sends estimated_weight_kg (medicationEntriesFromState). Once is_pediatric is set, every pediatric
--   medication would have raised a false critical PEDIATRIC_MEDICATION_MISSING_WEIGHT alert.
--   The 2 existing alerts of that type come from that test patient's events, which carried no
--   weight under any name: they are correct and stay as they are.
--
-- 1. project_patient_age(), a separate AFTER INSERT trigger on PATIENT_CREATED /
--    QUICK_PATIENT_CREATED (the full patient form sends the age, V2.99.84): sets is_pediatric
--    from patient_age_group = 'pediatric' or a patient_age under 8 (src/domain/rules.js
--    PEDIATRIC_AGE_CUTOFF), and pediatric_age_years for a child. A create event without
--    patient_age_group (sweep markers, life-saving action, first responder, older phones) leaves
--    the row as it is.
-- 2. flag_pediatric_medication_missing_weight(): the weight counts under either name. The rest of
--    the function is the live text unchanged.

create or replace function public.project_patient_age()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_group text := new.payload_json->>'patient_age_group';
  v_age integer;
  v_pediatric boolean;
begin
  if new.patient_id is null or v_group is null then
    return new;
  end if;
  begin
    if (new.payload_json->>'patient_age') ~ '^[0-9]{1,3}$' then
      v_age := (new.payload_json->>'patient_age')::integer;
    end if;
    v_pediatric := v_group = 'pediatric' or (v_age is not null and v_age < 8);
    update patients p
       set is_pediatric = v_pediatric,
           pediatric_age_years = case when v_pediatric then v_age end,
           updated_at = now(),
           version = coalesce(p.version, 0) + 1
     where p.id = new.patient_id
       and (p.is_pediatric is distinct from v_pediatric
            or p.pediatric_age_years is distinct from (case when v_pediatric then v_age end));
  exception when others then
    raise warning 'project_patient_age: % (event %)', sqlerrm, new.id;
  end;
  return new;
end;
$function$;

drop trigger if exists trg_project_patient_age on events;
create trigger trg_project_patient_age
after insert on events
for each row
when (new.type::text in ('PATIENT_CREATED','QUICK_PATIENT_CREATED'))
execute function public.project_patient_age();

revoke all on function public.project_patient_age() from public, anon, authenticated;

create or replace function public.flag_pediatric_medication_missing_weight()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  patient_is_pediatric boolean;
begin
  if new.patient_id is null or new.type <> 'MEDICATION_ADMINISTERED' then
    return new;
  end if;

  select is_pediatric into patient_is_pediatric
  from patients
  where id = new.patient_id;

  -- The phone sends estimated_weight_kg; weight_estimate_kg is the name this check always read
  -- (database/093).
  if patient_is_pediatric = true
     and coalesce(nullif(trim(new.payload_json->>'weight_estimate_kg'), ''),
                  nullif(trim(new.payload_json->>'estimated_weight_kg'), '')) is null
  then
    insert into watchdog_alerts (
      incident_id, patient_id, actor_id, alert_type, severity, message, payload_json
    ) values (
      new.incident_id,
      new.patient_id,
      new.actor_id,
      'PEDIATRIC_MEDICATION_MISSING_WEIGHT',
      'critical',
      'Pediatric medication recorded without weight estimate. Review immediately.',
      jsonb_build_object('event_id', new.id, 'source_event_type', new.type, 'payload', new.payload_json)
    );

    insert into conflict_log (
      incident_id, event_id, patient_id, actor_id, conflict_type, severity, description, payload_json
    ) values (
      new.incident_id,
      new.id,
      new.patient_id,
      new.actor_id,
      'HIGH_RISK_CLINICAL_VIOLATION',
      'critical',
      'Pediatric medication recorded without weight_estimate_kg.',
      jsonb_build_object('violation','PEDIATRIC_MEDICATION_MISSING_WEIGHT','payload',new.payload_json)
    );
  end if;

  return new;
end;
$function$;
