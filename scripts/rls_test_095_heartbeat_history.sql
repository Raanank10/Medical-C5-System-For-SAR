-- database/095 (heartbeat history): run on a THROWAWAY local PostgreSQL 16 only, never the live
-- project (it creates stand-in tables). From the repo root:
--   createdb hb && psql -d hb -v ON_ERROR_STOP=1 -f scripts/rls_test_095_heartbeat_history.sql
-- Every check prints "ok: ..." or stops with "FAIL: ...".
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
-- Supabase's default: every new public table is granted to anon and authenticated (095 revokes the writes)
alter default privileges in schema public grant all on tables to anon, authenticated;
create schema app;
create type user_role as enum ('medic','paramedic','physician','pc','cc','logistics_officer','chamal','rpc','rcc','admin');
create table profiles (id uuid primary key, role user_role not null);
create table incidents (id uuid primary key);
create table device_presence (id uuid primary key default gen_random_uuid(), incident_id uuid references incidents(id) on delete cascade,
  actor_id uuid not null references profiles(id), device_id text not null, last_heartbeat_at timestamptz not null default now(),
  sync_status text not null default 'online', updated_at timestamptz not null default now(), unique (incident_id, actor_id, device_id));
create function app.current_user_role() returns user_role language sql stable as $$ select nullif(current_setting('test.role', true), '')::user_role $$;
grant usage on schema app to authenticated; grant execute on function app.current_user_role() to authenticated;

\ir ../database/095_device_heartbeat_history.sql
\ir ../database/095_device_heartbeat_history.sql

create function t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin if not cond then raise exception 'FAIL: %', msg; end if; raise notice 'ok: %', msg; end $$;
grant execute on function t_assert(boolean, text) to authenticated;
insert into incidents values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2');
insert into profiles values ('00000000-0000-0000-0000-000000000001','medic'), ('00000000-0000-0000-0000-000000000009','admin');

-- the phone's upsert, with the phone's clock 3 minutes behind the server
insert into device_presence (incident_id, actor_id, device_id, last_heartbeat_at) values
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','dev-1', now()-interval '3 min')
  on conflict (incident_id, actor_id, device_id) do update set last_heartbeat_at = excluded.last_heartbeat_at, sync_status = excluded.sync_status;
select t_assert((select count(*) = 1 and bool_and(abs(extract(epoch from now() - received_at)) < 5) and bool_and(abs(extract(epoch from (received_at - device_time)) - 180) < 5) from device_heartbeats),
  'first heartbeat recorded: server time in received_at, the phone''s time in device_time');
insert into device_presence (incident_id, actor_id, device_id, last_heartbeat_at, sync_status) values
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','dev-1', now()-interval '2 min', 'syncing')
  on conflict (incident_id, actor_id, device_id) do update set last_heartbeat_at = excluded.last_heartbeat_at, sync_status = excluded.sync_status;
select t_assert((select count(*) from device_heartbeats) = 2 and (select count(*) from device_presence) = 1,
  'the next upsert adds a row while device_presence keeps one');
select t_assert((select sync_status from device_heartbeats order by id desc limit 1) = 'syncing', 'sync_status kept per heartbeat');
update device_presence set sync_status = 'error';
select t_assert((select count(*) from device_heartbeats) = 2, 'a sync_status change alone is not a heartbeat');
update device_presence set incident_id = '00000000-0000-0000-0000-0000000000a2';
select t_assert((select count(*) from device_heartbeats) = 2, 'moving incident_id (067 merge) is not a heartbeat');
update device_presence set incident_id = '00000000-0000-0000-0000-0000000000a1';

-- a failure writing the history never refuses the heartbeat
alter table device_heartbeats add constraint t_block check (device_id <> 'dev-bad');
insert into device_presence (incident_id, actor_id, device_id) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','dev-bad');
select t_assert((select count(*) from device_presence where device_id = 'dev-bad') = 1 and (select count(*) from device_heartbeats where device_id = 'dev-bad') = 0,
  'history write failed: heartbeat still stored, no history row');
alter table device_heartbeats drop constraint t_block;

-- the phone writes device_presence as a signed-in user; the trigger still records (security definer)
set role authenticated;
insert into device_presence (incident_id, actor_id, device_id) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','dev-2');
reset role;
select t_assert((select count(*) from device_heartbeats where device_id = 'dev-2') = 1, 'a signed-in phone''s heartbeat is recorded although it cannot write the table');

-- RLS: admin reads, everyone else reads nothing, nobody signed in writes
set role authenticated;
set test.role = 'pc';
select t_assert((select count(*) from device_heartbeats) = 0, 'RLS: pc reads no heartbeat history');
set test.role = 'medic';
select t_assert((select count(*) from device_heartbeats) = 0, 'RLS: medic reads no heartbeat history');
set test.role = 'admin';
select t_assert((select count(*) from device_heartbeats) = 3, 'RLS: admin reads it');
do $$ begin
  insert into device_heartbeats (actor_id, device_id) values ('00000000-0000-0000-0000-000000000001','forged');
  raise exception 'FAIL: a signed-in user inserted history directly';
exception when insufficient_privilege then raise notice 'ok: a signed-in user cannot insert history directly';
end $$;
do $$ begin
  delete from device_heartbeats;
  raise exception 'FAIL: a signed-in user deleted history';
exception when insufficient_privilege then raise notice 'ok: a signed-in user cannot delete history';
end $$;
reset role;

delete from incidents where id = '00000000-0000-0000-0000-0000000000a1';
select t_assert((select count(*) from device_heartbeats) = 0, 'rows go with their incident (on delete cascade)');
