-- WP-29: Dead Man's Switch on the server (owner decisions 2026-11-21). Apply after 081.
--
-- Before this file only a phone that was open noticed a silent medic (isDeviceSilent, 10 min,
-- src/domain/rules.js). The minute job (database/072, pg_cron) now raises it with no phone open.
--
-- Owner decisions, 2026-11-21:
-- 1. Who sees it: the incident's PC and CC, and the rescue chain (RCC / RPC). The rescue chain reads
--    only this alert type from watchdog_alerts (policy below); the alert carries no patient, no
--    colour, no tourniquet, only the medic, how long, and how many patients they registered that
--    are still open (database/074's rule for the rescue chain holds).
-- 2. Silent: no heartbeat (device_presence, any of the medic's devices, any incident) AND no event
--    stored by the server from that medic (events.server_timestamp, any incident) for 10 minutes.
--    The server's time, never the phone's: a phone that was offline pushes late with old
--    local_timestamp values, and the push itself is contact. Known limit: the heartbeat is a
--    45-second timer in the page, which a locked screen stops (iOS suspends it, Android freezes
--    it within minutes), so a medic doing 10+ minutes of hands-on care with the screen off and
--    nothing synced will raise it. To be measured in WP-21 before the threshold is revisited
--    (device-silence threshold: CLAUDE.md change rules).
-- 3. Whose patients: the server has no "assigned medic" on a patient (the phone's assignedMedicId
--    is local; PATIENT_REASSIGNED_* is not modelled, WP-7). patients.created_by (the registrant,
--    set by sync-log) stands for it. Open = not closed / deceased / evacuating (handed over) /
--    handed_over / self_evacuated: the watchdog's own list, so a patient waiting at the נאפ״ל is
--    still open.
-- 4. One alert per medic per incident per silence, not per device: dedupe_key
--    'dms:<medic>:<epoch of last contact>'. Resolved when any device of the medic heartbeats or
--    the server stores an event from them after that contact, or when none of their patients is
--    open. A new silence after that raises again.
-- Only medic / paramedic profiles that are active (an inactive profile cannot heartbeat).
-- generate_dead_man_switch_alerts() in 001 (5 min, per medic, PC only) is never scheduled and is
-- not used or changed here. DEAD_MAN_SWITCH_ESCALATED is left to WP-28.
-- The DMS block runs in its own sub-block: if it fails, the tourniquet and vitals alerts of the
-- same incident stay.
-- Tested on a local PostgreSQL 16 with stand-in tables (docs/ARCHITECTURE.md).

-- Last time the server heard from a profile: newest heartbeat of any device, or newest event it
-- stored from them, whichever is later. Called only by the watchdog (security definer).
create or replace function app.medic_last_contact_at(p_actor_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select greatest(
    (select max(dp.last_heartbeat_at) from device_presence dp where dp.actor_id = p_actor_id),
    (select max(e.server_timestamp) from events e where e.actor_id = p_actor_id))
$$;
revoke all on function app.medic_last_contact_at(uuid) from public, anon, authenticated;

-- The watchdog looks both up per medic every minute.
create index if not exists idx_device_presence_actor_heartbeat on device_presence (actor_id, last_heartbeat_at desc);
create index if not exists idx_events_actor_server_time on events (actor_id, server_timestamp desc);

-- 081's watchdog, plus step 4.
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

      -- 4. Dead Man's Switch (WP-29, owner 2026-11-21). In its own block: a failure here leaves
      --    the tourniquet and vitals alerts above in place.
      begin
        -- 4a. silences that ended (any device of the medic heartbeated, or the server stored an
        --     event from them, after the contact the alert was raised on), or the medic has no
        --     open patient in this incident any more
        update watchdog_alerts wa
        set resolved_at = v_now, updated_at = v_now, version = wa.version + 1
        where wa.incident_id = v_incident.id
          and wa.resolved_at is null
          and wa.alert_type = 'DEAD_MAN_SWITCH'
          and wa.payload_json->>'source' = 'server_watchdog'
          and (coalesce(app.medic_last_contact_at(wa.actor_id), '-infinity'::timestamptz)
                 > (wa.payload_json->>'last_contact_at')::timestamptz
               or not exists (
                 select 1 from patients p
                 where p.incident_id = v_incident.id
                   and p.created_by = wa.actor_id
                   and coalesce(p.current_status::text, 'unknown') not in ('closed', 'deceased', 'evacuating', 'handed_over', 'self_evacuated')));
        get diagnostics v_n = row_count;
        v_resolved := v_resolved + v_n; v_changed := v_changed or v_n > 0;

        -- 4b. a medic / paramedic who registered a patient still in their hands, silent 10 min
        insert into watchdog_alerts (incident_id, actor_id, alert_type, severity, message, payload_json, dedupe_key, triggered_at)
        select v_incident.id, s.actor_id, 'DEAD_MAN_SWITCH', 'critical',
               'No contact from ' || s.role || ' for ' || floor(extract(epoch from (v_now - s.last_contact_at)) / 60)::int || ' min',
               jsonb_build_object('medic_name', s.display_name, 'role', s.role,
                                  'open_patients', s.open_patients,
                                  'last_heartbeat_at', s.last_heartbeat_at,
                                  'last_event_at', s.last_event_at,
                                  'last_contact_at', s.last_contact_at,
                                  'minutes', floor(extract(epoch from (v_now - s.last_contact_at)) / 60)::int,
                                  'threshold_minutes', 10,
                                  'source', 'server_watchdog'),
               'dms:' || s.actor_id || ':' || floor(extract(epoch from s.last_contact_at))::bigint,
               v_now
        from (
          select m.actor_id, m.open_patients, pr.display_name, pr.role::text as role,
                 c.last_heartbeat_at, c.last_event_at,
                 greatest(c.last_heartbeat_at, c.last_event_at) as last_contact_at
          from (
            select p.created_by as actor_id, count(*)::int as open_patients
            from patients p
            where p.incident_id = v_incident.id
              and p.created_by is not null
              and coalesce(p.current_status::text, 'unknown') not in ('closed', 'deceased', 'evacuating', 'handed_over', 'self_evacuated')
            group by p.created_by
          ) m
          join profiles pr on pr.id = m.actor_id
          cross join lateral (
            select (select max(dp.last_heartbeat_at) from device_presence dp where dp.actor_id = m.actor_id) as last_heartbeat_at,
                   (select max(e.server_timestamp) from events e where e.actor_id = m.actor_id) as last_event_at
          ) c
          where pr.role in ('medic', 'paramedic')
            and pr.is_active
        ) s
        where s.last_contact_at is not null
          and v_now - s.last_contact_at >= interval '10 minutes'
          and not exists (select 1 from watchdog_alerts wa
                          where wa.incident_id = v_incident.id
                            and wa.actor_id = s.actor_id
                            and wa.alert_type = 'DEAD_MAN_SWITCH'
                            and wa.resolved_at is null)
          and not exists (select 1 from watchdog_alerts wa
                          where wa.incident_id = v_incident.id
                            and wa.dedupe_key = 'dms:' || s.actor_id || ':' || floor(extract(epoch from s.last_contact_at))::bigint);
        get diagnostics v_n = row_count;
        v_raised := v_raised + v_n; v_changed := v_changed or v_n > 0;
      exception when others then
        v_failed := v_failed + 1;
        raise warning 'run_clinical_watchdog: dead man''s switch, incident % failed: %', v_incident.id, sqlerrm;
      end;

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

-- The rescue chain reads this alert type only (every other watchdog alert stays clinical, 074).
drop policy if exists watchdog_read_dead_man_switch_rescue on watchdog_alerts;
create policy watchdog_read_dead_man_switch_rescue on watchdog_alerts for select to authenticated
  using (alert_type = 'DEAD_MAN_SWITCH'
         and app.current_user_role() in ('rpc', 'rcc')
         and app.can_read_incident_patients(incident_id));
