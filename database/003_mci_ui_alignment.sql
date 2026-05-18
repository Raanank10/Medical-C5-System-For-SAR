-- C5 Sentinel-SAR MCI UI Alignment Migration
-- Adds body-map injury zones and alert severity read support.

do $$ begin
  alter type event_type add value if not exists 'PATIENT_INJURY_UPDATED';
exception when duplicate_object or undefined_object then null; end $$;

alter table patients
  add column if not exists injury_zones jsonb not null default '[]'::jsonb;

create index if not exists idx_patients_injury_zones_gin
on patients using gin(injury_zones);

create index if not exists idx_watchdog_unresolved_severity
on watchdog_alerts(incident_id, severity, triggered_at desc)
where resolved_at is null;

create or replace function project_patient_injury_zones()
returns trigger as $$
begin
  if new.patient_id is not null
     and new.type in ('PATIENT_CREATED','QUICK_PATIENT_CREATED','PATIENT_INJURY_UPDATED')
     and new.payload_json ? 'injury_zones' then
    update patients
    set injury_zones = coalesce(new.payload_json->'injury_zones', injury_zones),
        updated_at = now(),
        version = version + 1
    where id = new.patient_id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_project_patient_injury_zones on events;
create trigger trg_project_patient_injury_zones
after insert on events
for each row execute function project_patient_injury_zones();

create or replace view vw_active_watchdog_alerts_by_severity as
select
  incident_id,
  severity,
  count(*) as active_alerts,
  count(*) filter (where patient_id is not null) as patient_linked_alerts,
  min(triggered_at) as oldest_triggered_at,
  max(triggered_at) as newest_triggered_at
from watchdog_alerts
where resolved_at is null
group by incident_id, severity;
