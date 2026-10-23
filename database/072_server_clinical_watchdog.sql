-- Durable server watchdog (docs/GAP_CLOSURE_PLAN.md WP-12). Owner decisions 2026-10-22:
--   - tourniquet: the server raises the phone's own levels from the time on the limb
--     (src/domain/rules.js tourniquetTimer): 45 min heads-up (info), 60 min (warning),
--     120 min (critical). Same rule as the phone (D1); the 30/60 min reassessment schedule the
--     projection stores in tourniquets.next_reassessment_due_at stays data only.
--   - vitals: red and yellow patients only, the phone's intervals (red 10 min, yellow 20 min).
--     pending / unknown triage counts as red, as on the phone (vitalsIntervalMsFor falls back to
--     red). Green is left to the phone.
--   - audience: command and the medic (client side; this file only writes watchdog_alerts, whose
--     read policy is unchanged: app.can_read_incident_patients).
--
-- Why a server watchdog at all, now that open command phones already compute remote tourniquet
-- and vitals timers from server rows (WP-2, N6): it keeps working with no phone open, it leaves a
-- durable record for the after-action report (alerts_by_type), and it is the base for an
-- outside channel later (B1).
--
-- app.run_clinical_watchdog() runs every minute from pg_cron. For every incident that is not
-- closed it:
--   1. raises TOURNIQUET_TIME_NOTICE / _WARNING / _CRITICAL for each active tourniquet of a
--      patient still in care, the highest level reached only, each level once per tourniquet
--      (dedupe_key 'tq-time:<tourniquet>:<level>', checked against every row, open or resolved,
--      so a level never comes back); a higher level resolves the lower open one;
--   2. raises VITALS_OVERDUE for a red / yellow / pending / unknown patient still in care whose
--      last vitals (or, with none, its creation) are older than the interval; once per vitals
--      reading (dedupe_key 'vitals-overdue:<patient>:<baseline epoch>');
--   3. resolves its own open alerts that no longer apply: tourniquet released or patient out of
--      care; vitals recorded since, triage now green / black, or patient out of care;
--   4. refreshes incident_command_state for each incident it changed (that projection is
--      otherwise refreshed only by events).
-- "Out of care" is the phone's VITALS_CLOSED_STATUSES that exist on the server: closed,
-- deceased, evacuating, handed_over, self_evacuated. Between runs, project_patient_state()
-- already resolves VITALS_OVERDUE when PATIENT_HANDED_OVER lands, and
-- silence_resolved_watchdogs_for_event() (called by project_tourniquet_events() only) now also
-- resolves the tourniquet time alerts on TOURNIQUET_RELEASED; a handover and new vitals
-- are picked up by the next run (step 3).
-- Never raises: one bad incident must not stop the others (each incident runs in its own
-- sub-block). Not callable by clients.

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
        and wa.alert_type in ('TOURNIQUET_TIME_NOTICE', 'TOURNIQUET_TIME_WARNING', 'TOURNIQUET_TIME_CRITICAL')
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
               case l.level when 'critical' then 'critical' when 'warning' then 'warning' else 'info' end,
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
          and wa.alert_type in ('TOURNIQUET_TIME_NOTICE', 'TOURNIQUET_TIME_WARNING', 'TOURNIQUET_TIME_CRITICAL')
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

-- The dedupe checks above look up every row of an incident by key, open or resolved.
create index if not exists idx_watchdog_incident_dedupe on watchdog_alerts (incident_id, dedupe_key);

-- Event-time resolution (from project_tourniquet_events()): a release resolves the tourniquet
-- time alerts of tourniquets no longer active, not only the legacy reassessment types; the minute
-- job also catches it. The function body is the live definition plus the two additions.
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
      and alert_type in ('TOURNIQUET_TIME_NOTICE','TOURNIQUET_TIME_WARNING','TOURNIQUET_TIME_CRITICAL')
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
        'TOURNIQUET_TIME_CRITICAL',
        'MISSING_FULL_ASSESSMENT'
      );
  end if;
end;
$$;

create extension if not exists pg_cron;

select cron.schedule(
  'clinical-watchdog',
  '* * * * *',
  $$select app.run_clinical_watchdog()$$
);
