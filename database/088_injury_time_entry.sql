-- Injury time, editable in the field (WP-23, repo owner 2026-10-23 and 2026-11-18). Does not depend on PR #141 (085-087) or PR #134; works before or after #141's 085 (already live).
--
-- Owner's rules: injury time starts as the incident's alert time and a medic can change it in the
-- field. Medic, paramedic, physician, PC and admin may change it; CC may not (2026-11-18). The
-- command watchdog's Golden Hour / Crush rows, the MIST handover and the stored report all read it
-- (2026-11-18).
--
-- Before this file: sync-log creates the patients row with t_injury = the create event's own phone
-- time (there was no injury-time capture), and project_patient_state() applied
-- PATIENT_T_INJURY_UPDATED in arrival order, with no check on the value. Nothing sent the event.
--
-- 1. patients.t_injury_source: 'event_time' (the old fallback; every existing row), 'incident_open'
--    (the incident's t_injury_default, the alert time open_incident() stores) or 'entered' (typed by
--    someone in the field). Plus t_injury_recorded_at (the phone's time of the winning entry),
--    t_injury_set_by, t_injury_set_by_role, t_injury_set_by_event_id. Existing rows keep their value
--    and are marked 'event_time': not rewritten, so the report still says which ones are estimates.
-- 2. project_patient_state(): the PATIENT_T_INJURY_UPDATED branch is removed in place (the function
--    is ~13k characters, so it is edited like database/047 does: the live text is read, the one
--    branch replaced, and the file fails loudly if that text is not found exactly once). Its job
--    moves to (3).
-- 3. app.project_patient_t_injury() (trigger trg_project_patient_state_t_injury, after
--    trg_project_patient_state and trg_project_patient_state_evac_point):
--    - PATIENT_CREATED / QUICK_PATIENT_CREATED / FIRST_RESPONDER_REPORT: a row still at
--      'event_time' with no entry gets the incident's t_injury_default, source 'incident_open'.
--      A merged patient (database/067) keeps what it had.
--    - PATIENT_T_INJURY_UPDATED, payload t_injury (ISO): applied only when it comes from medic,
--      paramedic, physician, pc or admin (sync-log already refuses other roles; this is the second
--      gate), the value parses, is not more than 5 minutes after the entry (the phone's time, never
--      later than now) and not more than 26 hours before it (the phone's day rule gives at most 24 h),
--      and the entry is the newest by phone time: an older entry pushed late by an offline phone does
--      not overwrite a newer correction. The event stays in the log either way.
-- 4. The report gains 'golden_hour' from app.build_incident_aar_golden_hour() (in
--    app.build_incident_aar(), or in app.build_incident_aar_ext() once PR #141's 085 renamed it): how many
--    injury times were entered vs estimated, handed over within / after 60 minutes of injury, the
--    median minutes from injury to handover (overall and for red), patients still not handed over
--    more than 60 minutes after injury when the report was made, and one row per patient (temporary
--    number only, D9). Edited in place like (2). Reports already stored do not change; the next close
--    stores a new version (database/068).
-- No RLS change: the new columns are read through the existing patients policies, only the trigger
-- writes them. Tested on a local PostgreSQL 16 with stand-in tables, starting from the live text of
-- project_patient_state() and the AAR wrapper (md5 of prosrc checked equal; re-tested 2026-11-19 both with and without PR #141's rename to build_incident_aar_ext).

alter table patients
  add column if not exists t_injury_source text not null default 'event_time',
  add column if not exists t_injury_recorded_at timestamptz,
  add column if not exists t_injury_set_by uuid,
  add column if not exists t_injury_set_by_role user_role,
  add column if not exists t_injury_set_by_event_id uuid;

do $$ begin
  alter table patients add constraint patients_t_injury_source_check
    check (t_injury_source in ('event_time','incident_open','entered'));
exception when duplicate_object then null; end $$;

-- (2) Remove the arrival-order branch from project_patient_state().
do $do$
declare
  v_def text := pg_get_functiondef('public.project_patient_state()'::regprocedure);
  v_pattern text := '  elsif new\.type = ''PATIENT_T_INJURY_UPDATED'' then\n    update patients\n    set t_injury = coalesce\(\(new\.payload_json->>''t_injury''\)::timestamptz, t_injury\),\n        updated_at = now\(\),\n        version = version \+ 1\n    where id = new\.patient_id;\n\n';
begin
  if (select count(*) from regexp_matches(v_def, v_pattern, 'g')) <> 1 then
    raise exception 'database/088: expected exactly one PATIENT_T_INJURY_UPDATED branch in project_patient_state()';
  end if;
  execute regexp_replace(v_def, v_pattern,
    '  -- PATIENT_T_INJURY_UPDATED: app.project_patient_t_injury() (database/088).' || chr(10) || chr(10));
end
$do$;

revoke execute on function public.project_patient_state() from public, anon, authenticated;

-- (3)
create or replace function app.project_patient_t_injury()
returns trigger
language plpgsql
security definer
set search_path = 'public'
as $$
declare
  v_t timestamptz;
  v_entered_at timestamptz;
begin
  if new.patient_id is null then
    return new;
  end if;

  if new.type in ('PATIENT_CREATED','QUICK_PATIENT_CREATED','FIRST_RESPONDER_REPORT') then
    update patients p
    set t_injury = i.t_injury_default,
        t_injury_source = 'incident_open',
        updated_at = now(),
        version = p.version + 1
    from incidents i
    where p.id = new.patient_id
      and i.id = p.incident_id
      and p.t_injury_source = 'event_time'
      and p.t_injury_recorded_at is null
      and i.t_injury_default is not null;

  elsif new.type = 'PATIENT_T_INJURY_UPDATED' then
    if coalesce(new.actor_role::text, '') not in ('medic','paramedic','physician','pc','admin') then
      return new;
    end if;
    begin
      v_t := (new.payload_json->>'t_injury')::timestamptz;
    exception when others then
      v_t := null;
    end;
    v_entered_at := least(new.local_timestamp, now());
    if v_t is null
       or v_t > v_entered_at + interval '5 minutes'
       or v_t < v_entered_at - interval '26 hours' then
      return new;
    end if;
    update patients
    set t_injury = v_t,
        t_injury_source = 'entered',
        t_injury_recorded_at = v_entered_at,
        t_injury_set_by = new.actor_id,
        t_injury_set_by_role = new.actor_role,
        t_injury_set_by_event_id = new.id,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and (t_injury_recorded_at is null or v_entered_at >= t_injury_recorded_at);
  end if;

  return new;
end;
$$;

revoke execute on function app.project_patient_t_injury() from public, anon, authenticated;

drop trigger if exists trg_project_patient_state_t_injury on events;
create trigger trg_project_patient_state_t_injury
  after insert on events
  for each row execute function app.project_patient_t_injury();

-- (4)
create or replace function app.build_incident_aar_golden_hour(p_incident_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_end timestamptz;
begin
  select coalesce(closed_at, now()) into v_end from incidents where id = p_incident_id;
  if not found then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object('golden_hour', (
    with p as (
      select p.visual_id, p.current_triage, p.current_status, p.t_injury_source, p.created_at,
             extract(epoch from (p.handed_over_at - p.t_injury)) / 60 as to_handover,
             extract(epoch from (v_end - p.t_injury)) / 60 as since_injury,
             p.handed_over_at is not null as handed_over
      from patients p where p.incident_id = p_incident_id
    )
    select jsonb_build_object(
      'basis', 'injury_to_handover',
      'injury_time_entered', count(*) filter (where t_injury_source = 'entered'),
      'injury_time_estimated', count(*) filter (where t_injury_source <> 'entered'),
      'handed_over_within_60', count(*) filter (where handed_over and to_handover <= 60),
      'handed_over_after_60', count(*) filter (where handed_over and to_handover > 60),
      'median_minutes_injury_to_handover', round((percentile_cont(0.5) within group (order by to_handover) filter (where handed_over))::numeric, 1),
      'red_median_minutes_injury_to_handover', round((percentile_cont(0.5) within group (order by to_handover) filter (where handed_over and current_triage = 'red'))::numeric, 1),
      'not_handed_over_past_60', count(*) filter (where not handed_over and since_injury > 60
                                                   and current_status not in ('deceased','closed','self_evacuated')),
      'patient_rows', coalesce(jsonb_agg(jsonb_build_object(
          'visual_id', visual_id,
          'triage', current_triage,
          'injury_time_source', t_injury_source,
          'minutes_injury_to_handover', case when handed_over then round(to_handover) end)
        order by created_at, visual_id), '[]'::jsonb))
    from p));
end;
$$;

revoke execute on function app.build_incident_aar_golden_hour(uuid) from public, anon, authenticated;

-- The base call lives in app.build_incident_aar() until the rescue-board migration
-- (085_rescue_board_evac_point, PR #141) renames that function to app.build_incident_aar_ext() and
-- wraps it. So the edit goes to whichever app.build_incident_aar* function holds the base call, and
-- fails unless exactly one does.
do $do$
declare
  v_old text := 'select app.build_incident_aar_base(p_incident_id) || jsonb_build_object(';
  v_new text := 'select app.build_incident_aar_base(p_incident_id) || app.build_incident_aar_golden_hour(p_incident_id) || jsonb_build_object(';
  v_def text;
  v_found int := 0;
  v_target text;
  r record;
begin
  for r in select p.oid, p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'app' and p.proname in ('build_incident_aar', 'build_incident_aar_ext') loop
    v_def := pg_get_functiondef(r.oid);
    if position('build_incident_aar_golden_hour' in v_def) > 0 then
      raise exception 'database/088: % already calls the golden-hour part', r.sig;
    end if;
    v_found := v_found + (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if position(v_old in v_def) > 0 then v_target := r.sig; end if;
  end loop;
  if v_found <> 1 then
    raise exception 'database/088: expected exactly one base call in app.build_incident_aar() / app.build_incident_aar_ext(), found %', v_found;
  end if;
  execute replace(pg_get_functiondef(v_target::regprocedure), v_old, v_new);
end
$do$;

revoke execute on function app.build_incident_aar(uuid) from public, anon, authenticated;
do $$ begin
  execute 'revoke execute on function app.build_incident_aar_ext(uuid) from public, anon, authenticated';
exception when undefined_function then null; end $$;
