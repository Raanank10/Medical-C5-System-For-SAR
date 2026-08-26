-- Phase 3/PRODUCTION_READINESS.md follow-up: "Keep Chamal/command dashboards on
-- incident_command_state" was marked [~] because the precomputed snapshot only ever
-- carried the six/seven aggregate counts already exposed as flat columns - state_json
-- was populated with `to_jsonb(vw_kpi_incident_command_summary row)`, a pure echo of
-- those same columns, so nothing about *where* patients are (the command dashboard's
-- sector/building/floor heatmap) had a real server-computed equivalent. That panel was
-- 100% client-side (buildIncidentCommandStateSnapshot() in index.html, reading only the
-- device's local in-memory patients[]) despite being labeled "incident_command_state
-- cache" in the UI - a real, previously undetected mislabel.
--
-- vw_command_spatial_heatmap (001_postgresql_schema_v1.2.sql) already computes exactly
-- this - per incident/building/floor patient counts by triage color plus a structural
-- danger flag from unresolved critical watchdog_alerts - it just wasn't wired into the
-- one function that populates incident_command_state. This migration wires it in.
--
-- Scope: this only expands the RPC's server-side sector state, not the client. It does
-- not touch the per-sector inventory shown in the same panel today - that reads from a
-- client-only local stock simulation (inventoryReadModel()/SUPPLY_BASELINE) with no
-- server-side equivalent in the live schema (the real inventory_ledger_v12 ledger uses a
-- different item/owner model that doesn't line up with the demo's simplified item set),
-- so folding it in here would misrepresent a demo simulation as a server fact. Left for a
-- future pass if/when the demo inventory model is reconciled with the real ledger.

create or replace function refresh_incident_command_state(p_incident_id uuid)
returns void as $$
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
$$ language plpgsql;
