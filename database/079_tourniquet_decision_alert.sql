-- Tourniquet 100-minute decision alert on the server watchdog (repo owner, 2026-10-26).
-- A medic may release a tourniquet (convert to direct pressure) only up to 120 minutes after it
-- went on; past that only a physician may, up to 6 hours. The phone now alerts at 45, 60, 100 and
-- 120 minutes (src/domain/rules.js: TOURNIQUET_DECISION_MS, tourniquetTimer().stage), so the
-- 100-minute "prepare a decision (convert / evacuate)" alert gives 20 minutes before that window
-- closes. This file makes the server watchdog (database/072, WP-12) raise the same level:
--   - app.run_clinical_watchdog(): a new level 'decision' between 'warning' (60) and 'critical'
--     (120), written as TOURNIQUET_TIME_DECISION, severity 'warning', dedupe_key
--     'tq-time:<tourniquet>:decision', once per tourniquet like the others. A higher level resolves
--     the lower open one, so DECISION resolves WARNING and CRITICAL resolves DECISION.
--   - silence_resolved_watchdogs_for_event(): a release or a handover also resolves DECISION.
-- Both bodies are 072's, with only those additions; the pg_cron job and index from 072 are
-- unchanged and not recreated here. watchdog_alerts.alert_type is text, so no enum change.
-- Applied live: a tourniquet already past 100 minutes (and under 120) with an open WARNING gets
-- DECISION on the next minute's run, and its WARNING is resolved; one already past 120 is not
-- given a DECISION (only the highest level reached is raised, as before).
-- Client (V2.99.70): SERVER_WATCHDOG_TYPES and SERVER_TQ_LEVEL_RANK in index.html know the new
-- type; until this file is applied the phone still raises 100 minutes on its own.
-- Deploy order: either order works.

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
        select t.id as tq_id, t.patient_id, t.limb, t.applied_at,
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
               'tq-time:' || l.tq_id || ':' || l.level,
               v_now
        from levels l
        where l.level is not null
          and not exists (select 1 from watchdog_alerts wa
                          where wa.incident_id = v_incident.id
                            and wa.dedupe_key = 'tq-time:' || l.tq_id || ':' || l.level)
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

-- Same body as 072, plus TOURNIQUET_TIME_DECISION in the release and handover lists.
create or replace function public.silence_resolved_watchdogs_for_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e record;
begin
  select * into e from events where id = p_event_id;
  if e.id is null then return; end if;

  -- Example: a vitals event resolves missing/reassessment alerts for that patient before dashboard emission.
  if e.type = 'VITALS_RECORDED' then
    update watchdog_alerts
    set resolved_at = coalesce(resolved_at, e.server_timestamp),
        resolved_by_event_id = e.id,
        suppressed_before_dashboard = true
    where incident_id = e.incident_id
      and patient_id = e.patient_id
      and resolved_at is null
      and alert_type in ('VITALS_OVERDUE','REASSESSMENT_OVERDUE');
  end if;

  if e.type = 'TOURNIQUET_RELEASED' then
    update watchdog_alerts
    set resolved_at = coalesce(resolved_at, e.server_timestamp),
        resolved_by_event_id = e.id,
        suppressed_before_dashboard = true
    where incident_id = e.incident_id
      and patient_id = e.patient_id
      and resolved_at is null
      and alert_type in ('TOURNIQUET_TIME_NOTICE','TOURNIQUET_TIME_WARNING','TOURNIQUET_TIME_DECISION','TOURNIQUET_TIME_CRITICAL')
      and not exists (select 1 from tourniquets t
                      where t.id = (watchdog_alerts.payload_json->>'tourniquet_id')::uuid and t.is_active);
  end if;

  if e.type in ('TOURNIQUET_REASSESSMENT','TOURNIQUET_RELEASED') then
    update watchdog_alerts
    set resolved_at = coalesce(resolved_at, e.server_timestamp),
        resolved_by_event_id = e.id,
        suppressed_before_dashboard = true
    where incident_id = e.incident_id
      and patient_id = e.patient_id
      and resolved_at is null
      and alert_type in ('TOURNIQUET_REASSESSMENT_OVERDUE','TOURNIQUET_CRITICAL');
  end if;

  if e.type = 'PATIENT_HANDED_OVER' then
    update watchdog_alerts
    set resolved_at = coalesce(resolved_at, e.server_timestamp),
        resolved_by_event_id = e.id,
        suppressed_before_dashboard = true
    where incident_id = e.incident_id
      and patient_id = e.patient_id
      and resolved_at is null
      and alert_type in (
        'VITALS_OVERDUE',
        'REASSESSMENT_OVERDUE',
        'TOURNIQUET_REASSESSMENT_OVERDUE',
        'TOURNIQUET_CRITICAL',
        'TOURNIQUET_TIME_NOTICE',
        'TOURNIQUET_TIME_WARNING',
        'TOURNIQUET_TIME_DECISION',
        'TOURNIQUET_TIME_CRITICAL',
        'MISSING_FULL_ASSESSMENT'
      );
  end if;
end;
$$;
