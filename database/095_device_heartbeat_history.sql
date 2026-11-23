-- Heartbeat history (owner 2026-11-23, prepares WP-29's drill measurement in WP-21). Apply after 094.
--
-- device_presence keeps only the newest heartbeat per (incident, actor, device): every 45-second
-- upsert from the phone (pushDevicePresence in index.html) overwrites the previous one, so after a
-- drill nobody can see how long a phone was silent along the way. WP-29 (server Dead Man's Switch,
-- parked as draft PR #156) was parked over the fear of false alarms from locked screens; to measure
-- that, the drills need the gaps.
--
-- What this adds:
-- * device_heartbeats: one row per heartbeat the server received. received_at is the server's time
--   (the one that counts for silence); device_time is what the phone sent (last_heartbeat_at, the
--   phone's clock), kept to see clock skew and late pushes. No location (current_location_json is
--   not copied), no patient.
-- * An AFTER INSERT / UPDATE trigger on device_presence writes the row. No client change, so every
--   phone version already in the field is recorded. An update that does not change
--   last_heartbeat_at (database/067's merge moving incident_id, a sync_status change on its own) is
--   not a heartbeat and is not recorded. A failure in the trigger is a warning only: a heartbeat is
--   never refused because its history could not be written.
-- * RLS on, read by admin only, no write policy: the phones cannot write or change it directly; the
--   analysis reads it with the service key (analytics export_live_incident.py) and a later server
--   function would read it as security definer.
--
-- Known limits:
-- * A heartbeat the phone could not send (offline, or the screen locked and the page timer stopped)
--   leaves no row. That gap is the point: it is what the server saw.
-- * The phone sends a heartbeat for every incident it has open, so one phone can have rows in
--   several incidents at the same moment. For "was this medic reachable" read by actor_id across
--   incidents, not by incident.
-- * A merged duplicate's rows stay under the duplicate's incident_id (067 moves device_presence,
--   not history).
-- * Volume: about 80 rows per phone per open incident per hour. Retention follows device_presence
--   (docs/AUDIT_AND_RETENTION_POLICY.md, Class B); rows go with their incident (on delete cascade).
-- Tested on a local PostgreSQL 16 with stand-in tables: scripts/rls_test_095_heartbeat_history.sql.

create table if not exists device_heartbeats (
  id bigint generated always as identity primary key,
  incident_id uuid references incidents(id) on delete cascade,
  actor_id uuid not null references profiles(id),
  device_id text not null,
  received_at timestamptz not null default now(),
  device_time timestamptz,
  sync_status text
);

create index if not exists idx_device_heartbeats_actor_received on device_heartbeats (actor_id, received_at);
create index if not exists idx_device_heartbeats_incident_received on device_heartbeats (incident_id, received_at);

alter table device_heartbeats enable row level security;
drop policy if exists device_heartbeats_read_admin on device_heartbeats;
create policy device_heartbeats_read_admin on device_heartbeats for select to authenticated
  using ((select app.current_user_role()) = 'admin');
revoke insert, update, delete, truncate on device_heartbeats from anon, authenticated;

create or replace function app.record_device_heartbeat()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' or new.last_heartbeat_at is distinct from old.last_heartbeat_at then
    begin
      insert into device_heartbeats (incident_id, actor_id, device_id, device_time, sync_status)
      values (new.incident_id, new.actor_id, new.device_id, new.last_heartbeat_at, new.sync_status);
    exception when others then
      raise warning 'record_device_heartbeat: % / % not recorded: %', new.actor_id, new.device_id, sqlerrm;
    end;
  end if;
  return null;
end;
$$;
revoke all on function app.record_device_heartbeat() from public, anon, authenticated;

drop trigger if exists trg_device_heartbeat_history on device_presence;
create trigger trg_device_heartbeat_history
  after insert or update on device_presence
  for each row execute function app.record_device_heartbeat();
