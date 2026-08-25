-- 030 re-created refresh_incident_command_state() without `set search_path`, which the
-- original 001_postgresql_schema_v1.2.sql definition also lacked - get_advisors flagged
-- it (function_search_path_mutable) immediately after 030 was applied. Fixed here rather
-- than left as a known gap: a function with a mutable search_path can be tricked into
-- resolving its unqualified table references (incident_command_state, vw_kpi_incident_
-- command_summary, vw_command_spatial_heatmap) against an attacker-controlled schema
-- earlier in a caller's search_path. Matches the same `set search_path to 'public'`
-- pattern already used by get_incident_command_state() and the two retention functions
-- in 028. Verified live via get_advisors before/after: the warning is gone, no new
-- findings introduced.

create or replace function refresh_incident_command_state(p_incident_id uuid)
returns void
language plpgsql
set search_path to 'public'
as $$
begin
  insert into incident_command_state (
    incident_id,
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
