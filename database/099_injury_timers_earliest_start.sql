-- 099: the server's injury timers start at the earliest known time (owner 2026-11-27/28).
--
-- Owner: "The golden hour starts when the incident occurs by alert or open by someone, the earlier
-- beats everything else" (2026-11-27), and "Crush syndrome or any other injury timer starts when the
-- alert comes in or open by someone, the earlier beats all" (2026-11-28); the 60-minute extraction
-- rule: "put it on the same rule" (2026-11-28). The phones do this since V2.99.96 (PR #164,
-- src/domain/rules.js goldenHourStartMs, index.html injuryTimerClock). The server still counted the
-- report's golden hour from patients.t_injury and the extraction rule from the first of the site's
-- official T0, the incident's T0 and its opening, so phone and server could disagree.
--
-- The start, in both functions below, is the earliest of:
--   - the site's official T0 (incident_site_authority.official_t0) and the incident's alert time
--     (incidents.t_zero) and opening (incidents.opened_at),
--   - the casualty's injury time when it is a real one (t_injury_source 'entered', or the
--     'incident_open' default, which is T0),
--   - the casualty's registration (patients.created_at): certainly injured by then,
-- leaving out any time more than one minute after the reference moment (now for the report, the
-- extraction's own time for the rule): a wrong clock. Ties go to the incident's time, as on the phone.
--
-- 1. app.build_incident_aar_golden_hour(uuid) (database/088): the report already merges it in. Stored
--    report versions are not touched: a version built before 099 keeps its 'injury_to_handover'
--    figures, and the client shows them under their old label. A new version says 'basis':
--    'earliest_start_to_handover' and carries the start source per casualty. The old keys are kept
--    with the new meaning, so a client from before 099 still shows sensible numbers.
-- 2. app.project_patient_extracted() (database/086): only the start of the 60-minute check changes;
--    the unsorted check, the statuses and the updates are as in 086. Its trigger from 085 keeps
--    calling it.
--
-- Not changed: patients.t_injury and its source (the recorded injury time), the MIST handover
-- payload, get_rescue_patient_board (074), analytics/ (golden_hour_compliance still uses t_injury).
--
-- Rollback: re-run the two functions from database/088 and database/086 (create or replace, same
-- signatures and grants).

create or replace function app.build_incident_aar_golden_hour(p_incident_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = 'public'
as $$
declare
  v_end timestamptz;
  v_t0 timestamptz;
  v_opened timestamptz;
  v_limit timestamptz := now() + interval '1 minute';
begin
  -- v_t0: the earlier of the site's official T0 and the incident's alert time (both "alert").
  select coalesce(i.closed_at, now()),
         least(case when a.official_t0 <= v_limit then a.official_t0 end,
               case when i.t_zero <= v_limit then i.t_zero end),
         case when i.opened_at <= v_limit then i.opened_at end
    into v_end, v_t0, v_opened
    from incidents i left join incident_site_authority a on a.incident_id = i.id
   where i.id = p_incident_id;
  if not found then
    return '{}'::jsonb;
  end if;

  return jsonb_build_object('golden_hour', (
    with c as (
      select p.visual_id, p.current_triage, p.current_status, p.created_at, p.handed_over_at,
             least(v_t0, v_opened) as c_incident,
             case when p.t_injury_source in ('entered', 'incident_open') and p.t_injury <= v_limit
                  then p.t_injury end as c_injury,
             p.t_injury_source,
             case when p.created_at <= v_limit then p.created_at end as c_registered
        from patients p where p.incident_id = p_incident_id
    ), s as (
      select c.*,
             least(c_incident, c_injury, c_registered) as start_at
        from c
    ), p as (
      select s.*,
             case
               when start_at is null then null
               when start_at = c_incident and start_at = v_t0 then 'alert'
               when start_at = c_incident then 'opened'
               when start_at = c_injury and t_injury_source = 'entered' then 'entered'
               when start_at = c_injury then 'alert'
               else 'registration'
             end as start_source,
             extract(epoch from (handed_over_at - start_at)) / 60 as to_handover,
             extract(epoch from (v_end - start_at)) / 60 as since_start,
             handed_over_at is not null as handed_over
        from s
    )
    select jsonb_build_object(
      'basis', 'earliest_start_to_handover',
      'start_from_alert', count(*) filter (where start_source = 'alert'),
      'start_from_opened', count(*) filter (where start_source = 'opened'),
      'start_from_entered', count(*) filter (where start_source = 'entered'),
      'start_from_registration', count(*) filter (where start_source = 'registration'),
      'start_unknown', count(*) filter (where start_source is null),
      -- kept for clients from before 099, same meaning as the new keys below
      'injury_time_entered', count(*) filter (where t_injury_source = 'entered'),
      'injury_time_estimated', count(*) filter (where t_injury_source is distinct from 'entered'),
      'handed_over_within_60', count(*) filter (where handed_over and to_handover <= 60),
      'handed_over_after_60', count(*) filter (where handed_over and to_handover > 60),
      'median_minutes_injury_to_handover', round((percentile_cont(0.5) within group (order by to_handover) filter (where handed_over))::numeric, 1),
      'red_median_minutes_injury_to_handover', round((percentile_cont(0.5) within group (order by to_handover) filter (where handed_over and current_triage = 'red'))::numeric, 1),
      'median_minutes_start_to_handover', round((percentile_cont(0.5) within group (order by to_handover) filter (where handed_over))::numeric, 1),
      'red_median_minutes_start_to_handover', round((percentile_cont(0.5) within group (order by to_handover) filter (where handed_over and current_triage = 'red'))::numeric, 1),
      'not_handed_over_past_60', count(*) filter (where not handed_over and since_start > 60
                                                   and current_status not in ('deceased','closed','self_evacuated')),
      'patient_rows', coalesce(jsonb_agg(jsonb_build_object(
          'visual_id', visual_id,
          'triage', current_triage,
          'injury_time_source', t_injury_source,
          'start_source', start_source,
          'minutes_injury_to_handover', case when handed_over then round(to_handover) end,
          'minutes_start_to_handover', case when handed_over then round(to_handover) end)
        order by created_at, visual_id), '[]'::jsonb))
    from p));
end;
$$;

revoke execute on function app.build_incident_aar_golden_hour(uuid) from public, anon, authenticated;

create or replace function app.project_patient_extracted()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_status text;
  v_triage text;
  v_access text;
  v_t_injury timestamptz;
  v_t_injury_source text;
  v_created timestamptz;
  v_limit timestamptz;
  v_start timestamptz;
begin
  if new.patient_id is null or new.actor_role::text not in ('rpc', 'rcc', 'admin') then
    return new;
  end if;
  select current_status::text, current_triage::text, access_status::text, t_injury, t_injury_source::text, created_at
    into v_status, v_triage, v_access, v_t_injury, v_t_injury_source, v_created
    from patients where id = new.patient_id;
  if v_status is null then
    return new;
  end if;
  -- 086: a trapped casualty no medic has sorted yet (the rescue board's "pending": no triage
  -- colour, no active tourniquet, not dead) is not extracted before a medic checks them. The
  -- event stays in the log; the patient row does not change.
  if v_status <> 'deceased'
     and coalesce(v_triage, '') not in ('red', 'yellow', 'green', 'black')
     and not exists (select 1 from tourniquets t where t.patient_id = new.patient_id and t.is_active) then
    return new;
  end if;
  -- Trapped 60 minutes or more: a medic present records the extraction, not the rescue chain.
  -- 099: the 60 minutes run from the earliest known start (see the header), not the first found.
  if v_status not in ('evacuating', 'handed_over', 'evacuated', 'self_evacuated', 'closed', 'deceased')
     and coalesce(v_access, '') in ('trapped', 'partial', 'blocked') then
    v_limit := new.local_timestamp + interval '1 minute';
    select least(
             case when a.official_t0 <= v_limit then a.official_t0 end,
             case when i.t_zero <= v_limit then i.t_zero end,
             case when i.opened_at <= v_limit then i.opened_at end,
             case when v_t_injury_source in ('entered', 'incident_open') and v_t_injury <= v_limit then v_t_injury end,
             case when v_created <= v_limit then v_created end)
      into v_start
      from incidents i left join incident_site_authority a on a.incident_id = i.id
     where i.id = new.incident_id;
    if v_start is not null and new.local_timestamp - v_start >= interval '60 minutes' then
      return new;
    end if;
  end if;
  if v_status in ('evacuating', 'handed_over', 'evacuated', 'self_evacuated', 'closed', 'deceased') then
    -- Already on the way, out or dead: only the access changes.
    update patients
       set access_status = 'free', access_recorded_at = new.local_timestamp, updated_at = now(), version = version + 1
     where id = new.patient_id;
  else
    update patients
       set access_status = 'free', access_recorded_at = new.local_timestamp,
           current_status = 'evacuating', status_recorded_at = new.local_timestamp,
           status_set_by_role = new.actor_role, status_set_by_event_id = new.id,
           evac_point_arrived_at = null, evac_point_arrived_role = null,
           updated_at = now(), version = version + 1
     where id = new.patient_id;
  end if;
  return new;
end;
$function$;
revoke execute on function app.project_patient_extracted() from public, anon, authenticated;
