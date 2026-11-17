-- Tourniquet time entered from the body (repo owner, 2026-11-08). Apply after 079 and 080.
--
-- First responders write the time a tourniquet went on, in 4 digits, on the patient; the medic may
-- see the patient much later. Medical staff now enter that time (or correct one entered earlier) on
-- the phone, sent as TOURNIQUET_TIME_RECORDED (080). A tourniquet that was already on the patient
-- and has no time yet is recorded with time_source 'unknown'. Owner's rules: the levels already
-- passed when the time is entered do not alert (phone or server); the next level alerts as usual;
-- a tourniquet with no known time cannot be converted to direct pressure (phone-side check).
--
-- 1. tourniquets.time_source ('phone' placed with the app at the phone's time, 'entered' from the
--    body, 'unknown'), time_entered_at, time_entered_by, and time_alert_baseline: the highest alert
--    level already seen (notice / warning / decision / critical), below which the watchdog does not
--    raise. Existing rows are 'phone', the only kind there was.
-- 2. app.project_tourniquet_time() (trigger trg_tourniquet_time_events, after
--    trg_project_tourniquet_events, which creates the row):
--    - TOURNIQUET_APPLIED with payload time_source: stores it on the row just created. 'entered'
--      (a time typed in the New Patient flow) also gets time_entered_at and its baseline.
--    - TOURNIQUET_TIME_RECORDED: moves the active row of that patient and limb (the one whose
--      applied_at is previous_application_time, else the only active one on that limb) to
--      application_time, marks it 'entered', sets the baseline to the level reached at
--      time_entered_at (the phone's time of entry, never later than now), and resolves its open
--      tourniquet time alerts (raised from the old time). A time later than its entry time by more
--      than 5 minutes, or one that would clash with another row (unique patient, limb, applied_at),
--      is not applied; the event stays in the log either way. Nothing here raises.
-- 3. app.run_clinical_watchdog(): 079's body, plus: a level is raised only above the row's
--    baseline, and the dedupe key carries the start time ('tq-time:<id>:<level>:<epoch>'), so after
--    a corrected time the next levels can alert again. Before the new key is used, every active
--    row's baseline is set to the highest level already raised for it, so nothing raised before is
--    raised again.
-- The hourly phone alerts past 120 minutes stay phone-only. No RLS change: the new columns are
-- read through the existing tourniquets policies, and only the trigger writes them.
-- Tested on a local PostgreSQL 16 with stand-in tables (docs/ARCHITECTURE.md).

alter table tourniquets
  add column if not exists time_source text not null default 'phone',
  add column if not exists time_entered_at timestamptz,
  add column if not exists time_entered_by uuid,
  add column if not exists time_alert_baseline text;

do $$ begin
  alter table tourniquets add constraint tourniquets_time_source_check check (time_source in ('phone','entered','unknown'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table tourniquets add constraint tourniquets_time_alert_baseline_check check (time_alert_baseline is null or time_alert_baseline in ('notice','warning','decision','critical'));
exception when duplicate_object then null; end $$;

create or replace function app.tourniquet_time_level(p_elapsed interval)
returns text
language sql
immutable
as $$
  select case
    when p_elapsed is null then null
    when p_elapsed >= interval '120 minutes' then 'critical'
    when p_elapsed >= interval '100 minutes' then 'decision'
    when p_elapsed >= interval '60 minutes' then 'warning'
    when p_elapsed >= interval '45 minutes' then 'notice'
  end
$$;

create or replace function app.tourniquet_time_level_rank(p_level text)
returns int
language sql
immutable
as $$
  select case p_level when 'notice' then 1 when 'warning' then 2 when 'decision' then 3 when 'critical' then 4 else 0 end
$$;

-- Baseline for rows that already have alerts, so the new dedupe key raises nothing twice.
update tourniquets t
set time_alert_baseline = x.level
from (
  select (wa.payload_json->>'tourniquet_id')::uuid as tq_id,
         (array_agg(lower(replace(wa.alert_type, 'TOURNIQUET_TIME_', ''))
            order by app.tourniquet_time_level_rank(lower(replace(wa.alert_type, 'TOURNIQUET_TIME_', ''))) desc))[1] as level
  from watchdog_alerts wa
  where wa.alert_type in ('TOURNIQUET_TIME_NOTICE','TOURNIQUET_TIME_WARNING','TOURNIQUET_TIME_DECISION','TOURNIQUET_TIME_CRITICAL')
    and wa.payload_json ? 'tourniquet_id'
  group by 1
) x
where t.id = x.tq_id
  and t.is_active
  and app.tourniquet_time_level_rank(x.level) > app.tourniquet_time_level_rank(t.time_alert_baseline);

create or replace function app.project_tourniquet_time()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_source text;
  v_limb text;
  v_new timestamptz;
  v_prev timestamptz;
  v_entered timestamptz;
  v_row tourniquets%rowtype;
  v_count int;
begin
  if new.patient_id is null or new.type::text not in ('TOURNIQUET_APPLIED', 'TOURNIQUET_TIME_RECORDED') then
    return new;
  end if;
  begin
    if new.type::text = 'TOURNIQUET_APPLIED' then
      v_source := new.payload_json->>'time_source';
      if v_source not in ('phone', 'entered', 'unknown') then
        return new;
      end if;
      if v_source = 'entered' then
        v_entered := least(coalesce((new.payload_json->>'time_entered_at')::timestamptz, new.local_timestamp, now()), now());
        update tourniquets
        set time_source = 'entered',
            time_entered_at = v_entered,
            time_entered_by = new.actor_id,
            time_alert_baseline = app.tourniquet_time_level(v_entered - applied_at),
            updated_at = now()
        where applied_event_id = new.id;
      else
        update tourniquets set time_source = v_source, updated_at = now() where applied_event_id = new.id;
      end if;
      return new;
    end if;

    -- TOURNIQUET_TIME_RECORDED
    v_limb := new.payload_json->>'limb';
    v_new := (new.payload_json->>'application_time')::timestamptz;
    v_prev := nullif(new.payload_json->>'previous_application_time', '')::timestamptz;
    v_entered := least(coalesce((new.payload_json->>'time_entered_at')::timestamptz, new.local_timestamp, now()), now());
    if v_limb is null or v_new is null or v_new > v_entered + interval '5 minutes' then
      return new;
    end if;
    select * into v_row from tourniquets
    where patient_id = new.patient_id and limb = v_limb and is_active and v_prev is not null and applied_at = v_prev
    limit 1;
    if v_row.id is null then
      select count(*) into v_count from tourniquets where patient_id = new.patient_id and limb = v_limb and is_active;
      if v_count <> 1 then
        return new;
      end if;
      select * into v_row from tourniquets where patient_id = new.patient_id and limb = v_limb and is_active;
    end if;
    if exists (select 1 from tourniquets where patient_id = new.patient_id and limb = v_limb and applied_at = v_new and id <> v_row.id) then
      return new;
    end if;
    update tourniquets
    set applied_at = v_new,
        time_source = 'entered',
        time_entered_at = v_entered,
        time_entered_by = new.actor_id,
        time_alert_baseline = app.tourniquet_time_level(v_entered - v_new),
        updated_at = now()
    where id = v_row.id;
    -- Alerts raised from the old time no longer apply.
    update watchdog_alerts
    set resolved_at = now(), resolved_by_event_id = new.id, updated_at = now(), version = version + 1
    where incident_id = v_row.incident_id
      and resolved_at is null
      and alert_type in ('TOURNIQUET_TIME_NOTICE','TOURNIQUET_TIME_WARNING','TOURNIQUET_TIME_DECISION','TOURNIQUET_TIME_CRITICAL')
      and payload_json->>'tourniquet_id' = v_row.id::text;
  exception when others then
    raise warning 'project_tourniquet_time: event % not applied: %', new.id, sqlerrm;
  end;
  return new;
end;
$function$;

revoke all on function app.project_tourniquet_time() from public, anon, authenticated;

drop trigger if exists trg_tourniquet_time_events on events;
create trigger trg_tourniquet_time_events
after insert on events
for each row execute function app.project_tourniquet_time();

-- 079's watchdog, with the baseline and the start time in the dedupe key.
create or replace function app.run_clinical_watchdog()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := now();
  v_incident record;
  v_raised int := 0;
  v_resolved int := 0;
  v_n int;
  v_n2 int;
  v_changed boolean;
  v_failed int := 0;
begin
  for v_incident in select id from incidents where status <> 'closed' loop
    begin
      v_changed := false;

      -- 3a. tourniquet alerts that no longer apply
      update watchdog_alerts wa
      set resolved_at = v_now, updated_at = v_now, version = wa.version + 1
      where wa.incident_id = v_incident.id
        and wa.resolved_at is null
        and wa.alert_type in ('TOURNIQUET_TIME_NOTICE', 'TOURNIQUET_TIME_WARNING', 'TOURNIQUET_TIME_DECISION', 'TOURNIQUET_TIME_CRITICAL')
        and not exists (
          select 1 from tourniquets t join patients p on p.id = t.patient_id
          where t.id = (wa.payload_json->>'tourniquet_id')::uuid
            and t.is_active
            and coalesce(p.current_status::text, 'unknown') not in ('closed', 'deceased', 'evacuating', 'handed_over', 'self_evacuated')
        );
      get diagnostics v_n = row_count;
      v_resolved := v_resolved + v_n; v_changed := v_changed or v_n > 0;

      -- 1. tourniquet time levels
      with levels as (
        select t.id as tq_id, t.patient_id, t.limb, t.applied_at, t.time_alert_baseline,
               floor(extract(epoch from (v_now - t.applied_at)) / 60)::int as minutes,
               case
                 when v_now - t.applied_at >= interval '120 minutes' then 'critical'
                 when v_now - t.applied_at >= interval '100 minutes' then 'decision'
                 when v_now - t.applied_at >= interval '60 minutes' then 'warning'
                 when v_now - t.applied_at >= interval '45 minutes' then 'notice'
               end as level
        from tourniquets t join patients p on p.id = t.patient_id
        where t.incident_id = v_incident.id
          and t.is_active
          and coalesce(p.current_status::text, 'unknown') not in ('closed', 'deceased', 'evacuating', 'handed_over', 'self_evacuated')
      ), ins as (
        insert into watchdog_alerts (incident_id, patient_id, alert_type, severity, message, payload_json, dedupe_key, triggered_at)
        select v_incident.id, l.patient_id,
               'TOURNIQUET_TIME_' || upper(l.level),
               case l.level when 'critical' then 'critical' when 'decision' then 'warning' when 'warning' then 'warning' else 'info' end,
               'Tourniquet on ' || l.limb || ' for ' || l.minutes || ' min',
               jsonb_build_object('tourniquet_id', l.tq_id, 'limb', l.limb, 'applied_at', l.applied_at,
                                  'level', l.level, 'minutes', l.minutes, 'source', 'server_watchdog'),
               'tq-time:' || l.tq_id || ':' || l.level || ':' || floor(extract(epoch from l.applied_at))::bigint,
               v_now
        from levels l
        where l.level is not null
          and app.tourniquet_time_level_rank(l.level) > app.tourniquet_time_level_rank(l.time_alert_baseline)
          and not exists (select 1 from watchdog_alerts wa
                          where wa.incident_id = v_incident.id
                            and wa.dedupe_key = 'tq-time:' || l.tq_id || ':' || l.level || ':' || floor(extract(epoch from l.applied_at))::bigint)
        returning payload_json->>'tourniquet_id' as tq_id, alert_type
      ), superseded as (
        update watchdog_alerts wa
        set resolved_at = v_now, updated_at = v_now, version = wa.version + 1
        from ins
        where wa.incident_id = v_incident.id
          and wa.resolved_at is null
          and wa.payload_json->>'tourniquet_id' = ins.tq_id
          and wa.alert_type in ('TOURNIQUET_TIME_NOTICE', 'TOURNIQUET_TIME_WARNING', 'TOURNIQUET_TIME_DECISION', 'TOURNIQUET_TIME_CRITICAL')
          and wa.alert_type <> ins.alert_type
        returning 1
      )
      select (select count(*) from ins), (select count(*) from superseded) into v_n, v_n2;
      v_raised := v_raised + v_n; v_resolved := v_resolved + v_n2;
      v_changed := v_changed or v_n > 0 or v_n2 > 0;

      -- 3b. vitals alerts that no longer apply
      update watchdog_alerts wa
      set resolved_at = v_now, updated_at = v_now, version = wa.version + 1
      from patients p
      where wa.incident_id = v_incident.id
        and wa.resolved_at is null
        and wa.alert_type = 'VITALS_OVERDUE'
        and wa.payload_json->>'source' = 'server_watchdog'
        and p.id = wa.patient_id
        and (p.current_status in ('closed', 'deceased', 'evacuating', 'handed_over', 'self_evacuated')
             or p.current_triage in ('green', 'black')
             or coalesce(p.last_vitals_at, p.created_at) > (wa.payload_json->>'baseline_at')::timestamptz);
      get diagnostics v_n = row_count;
      v_resolved := v_resolved + v_n; v_changed := v_changed or v_n > 0;

      -- 2. vitals overdue
      insert into watchdog_alerts (incident_id, patient_id, alert_type, severity, message, payload_json, dedupe_key, triggered_at)
      select v_incident.id, p.id, 'VITALS_OVERDUE',
             case when p.current_triage = 'yellow' then 'warning' else 'critical' end,
             'Vitals overdue: ' || floor(extract(epoch from (v_now - b.baseline_at)) / 60)::int || ' min',
             jsonb_build_object('triage', p.current_triage, 'baseline_at', b.baseline_at,
                                'had_vitals', p.last_vitals_at is not null,
                                'interval_minutes', b.interval_min,
                                'minutes', floor(extract(epoch from (v_now - b.baseline_at)) / 60)::int,
                                'source', 'server_watchdog'),
             'vitals-overdue:' || p.id || ':' || floor(extract(epoch from b.baseline_at))::bigint,
             v_now
      from patients p
      cross join lateral (
        select coalesce(p.last_vitals_at, p.created_at) as baseline_at,
               case when p.current_triage = 'yellow' then 20 else 10 end as interval_min
      ) b
      where p.incident_id = v_incident.id
        and coalesce(p.current_triage::text, 'pending') in ('red', 'yellow', 'pending', 'unknown')
        and coalesce(p.current_status::text, 'unknown') not in ('closed', 'deceased', 'evacuating', 'handed_over', 'self_evacuated')
        and v_now - b.baseline_at >= make_interval(mins => b.interval_min)
        and not exists (select 1 from watchdog_alerts wa
                        where wa.incident_id = v_incident.id
                          and wa.dedupe_key = 'vitals-overdue:' || p.id || ':' || floor(extract(epoch from b.baseline_at))::bigint);
      get diagnostics v_n = row_count;
      v_raised := v_raised + v_n; v_changed := v_changed or v_n > 0;

      if v_changed then
        perform refresh_incident_command_state(v_incident.id);
      end if;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'run_clinical_watchdog: incident % failed: %', v_incident.id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('raised', v_raised, 'resolved', v_resolved, 'failed_incidents', v_failed, 'at', v_now);
end;
$$;
revoke all on function app.run_clinical_watchdog() from public, anon, authenticated;
