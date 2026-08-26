-- Prerequisite for kit templates' "editable only in staging/non-active incident mode" gate
-- (C5_SENTINEL_SAR_MVP_SPEC_v1.2.md sec 5.6, incident_status enum: draft/staging/active/closed).
-- Found while scoping that work: the client has no real-time visibility into the server's
-- actual incidents.status at all today. Its local siteData.incidentStatus is a separate,
-- never-synced concept with its own different vocabulary (draft/official/closed, set by
-- rescueOpenOfficialIncident()/rescueToggleIncidentClosed() - see index.html), not derived from
-- the real incident_status enum in any way.
--
-- Rather than stand up a new read path, this extends the one already polled every 45s
-- (get_incident_command_state() -> incident_command_state, database/014) - same reuse-over-
-- duplicate-plumbing approach 030 used to add sector detail to the same table/function/RPC.
--
-- Real bug caught live-testing this, not assumed away: trg_refresh_command_state_after_event
-- (AFTER INSERT ON events) only fires for a fixed allowlist of clinical/patient event types
-- (its own WHEN clause - QUICK_PATIENT_CREATED, VITALS_RECORDED, TOURNIQUET_APPLIED, etc.),
-- which does NOT include INCIDENT_OPENED/CONFIRMED/CLOSED/REOPENED or anything else that
-- would touch incidents.status - so a real status change would NOT reliably or promptly
-- refresh this snapshot at all, event-driven or not. Verified live: pushing an unrelated
-- event for an incident left incident_command_state.last_refreshed_at untouched. Fixed with a
-- second, direct trigger on incidents(status) itself - correct regardless of which code path
-- or event type ends up writing that column, rather than trying to enumerate every possible
-- cause in the events-side WHEN clause.

alter table incident_command_state add column if not exists status incident_status;

create or replace view vw_kpi_incident_command_summary as
with patient_counts as (
  select
    incident_id,
    count(*) filter (where current_triage = 'red' and current_status not in ('evacuating','handed_over','closed','self_evacuated','deceased')) as active_red_patients,
    count(*) filter (where needs_full_assessment = true and current_status not in ('evacuating','handed_over','closed','self_evacuated','deceased')) as patients_missing_full_vitals,
    count(*) filter (where current_status in ('evacuating','handed_over')) as handed_over_patients,
    count(*) as total_patients
  from patients
  group by incident_id
), alert_counts as (
  select
    incident_id,
    count(*) filter (where resolved_at is null) as active_watchdog_alerts
  from watchdog_alerts
  group by incident_id
), medic_counts as (
  select
    incident_id,
    count(*) filter (where last_heartbeat_at < now() - interval '5 minutes') as dead_man_switch_active,
    count(*) filter (where last_heartbeat_at >= now() - interval '5 minutes') as active_medics
  from device_presence
  group by incident_id
)
select
  i.id as incident_id,
  coalesce(pc.active_red_patients, 0) as active_red_patients,
  coalesce(pc.patients_missing_full_vitals, 0) as patients_missing_full_vitals,
  coalesce(pc.handed_over_patients, 0) as handed_over_patients,
  coalesce(pc.total_patients, 0) as total_patients,
  coalesce(ac.active_watchdog_alerts, 0) as active_watchdog_alerts,
  coalesce(mc.dead_man_switch_active, 0) as dead_man_switch_active,
  coalesce(pc.active_red_patients, 0)::numeric / nullif(coalesce(mc.active_medics, 0), 0) as red_patients_per_active_medic,
  i.status as status
from incidents i
left join patient_counts pc on pc.incident_id = i.id
left join alert_counts ac on ac.incident_id = i.id
left join medic_counts mc on mc.incident_id = i.id;

create or replace function refresh_incident_command_state(p_incident_id uuid)
returns void
language plpgsql
set search_path to 'public'
as $$
begin
  insert into incident_command_state (
    incident_id,
    status,
    active_red_patients,
    patients_missing_full_vitals,
    handed_over_patients,
    total_patients,
    active_watchdog_alerts,
    dead_man_switch_active,
    red_patients_per_active_medic,
    last_refreshed_at,
    state_json
  )
  select
    s.incident_id,
    s.status,
    s.active_red_patients,
    s.patients_missing_full_vitals,
    s.handed_over_patients,
    s.total_patients,
    s.active_watchdog_alerts,
    s.dead_man_switch_active,
    s.red_patients_per_active_medic,
    now(),
    jsonb_build_object(
      'summary', to_jsonb(s),
      'sectors', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'building_id', h.building_id,
              'floor_id', h.floor_id,
              'total_patients_on_site', h.total_patients_on_site,
              'count_red_triage', h.count_red_triage,
              'count_yellow_triage', h.count_yellow_triage,
              'count_green_triage', h.count_green_triage,
              'count_deceased', h.count_deceased,
              'structural_alert_state', h.structural_alert_state
            )
            order by h.total_patients_on_site desc, h.building_id, h.floor_id
          )
          from vw_command_spatial_heatmap h
          where h.incident_id = p_incident_id
        ),
        '[]'::jsonb
      )
    )
  from vw_kpi_incident_command_summary s
  where s.incident_id = p_incident_id
  on conflict (incident_id) do update set
    status = excluded.status,
    active_red_patients = excluded.active_red_patients,
    patients_missing_full_vitals = excluded.patients_missing_full_vitals,
    handed_over_patients = excluded.handed_over_patients,
    total_patients = excluded.total_patients,
    active_watchdog_alerts = excluded.active_watchdog_alerts,
    dead_man_switch_active = excluded.dead_man_switch_active,
    red_patients_per_active_medic = excluded.red_patients_per_active_medic,
    last_refreshed_at = excluded.last_refreshed_at,
    state_json = excluded.state_json;
end;
$$;

create or replace function refresh_command_state_after_incident_status_change()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  perform refresh_incident_command_state(new.id);
  return new;
end;
$$;

drop trigger if exists trg_refresh_command_state_after_incident_status_change on incidents;
create trigger trg_refresh_command_state_after_incident_status_change
after update of status on incidents
for each row
when (old.status is distinct from new.status)
execute function refresh_command_state_after_incident_status_change();

revoke execute on function refresh_command_state_after_incident_status_change() from public, anon, authenticated;
