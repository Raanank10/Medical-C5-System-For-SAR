-- WP-29 (database/095): server Dead Man's Switch, run on a THROWAWAY local PostgreSQL 16 only,
-- never the live project (it creates stand-in tables). From the repo root:
--   createdb dms && psql -d dms -v ON_ERROR_STOP=1 -f scripts/rls_test_095_server_dead_mans_switch.sql
-- Every check prints "ok: ..." or stops with "FAIL: ...". 2026-11-22: all passed.
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$; do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
create schema app;
create type user_role as enum ('medic','paramedic','physician','pc','cc','logistics_officer','chamal','rpc','rcc','admin');
create type patient_status as enum ('identified','stabilizing','observing','extricating','evacuating','treating','extricated','handed_over','closed','self_evacuated','deceased','unknown');
create table profiles (id uuid primary key, display_name text not null, role user_role not null, is_active boolean not null default true);
create table incidents (id uuid primary key, status text not null default 'active');
create table patients (id uuid primary key default gen_random_uuid(), incident_id uuid references incidents(id), created_by uuid references profiles(id),
  current_status patient_status default 'identified', current_triage text default 'green', last_vitals_at timestamptz, created_at timestamptz default now());
create table events (id uuid primary key default gen_random_uuid(), incident_id uuid, actor_id uuid, type text default 'X', server_timestamp timestamptz not null default now());
create table device_presence (incident_id uuid, actor_id uuid not null, device_id text not null, last_heartbeat_at timestamptz not null default now(), unique(incident_id, actor_id, device_id));
create table tourniquets (id uuid primary key default gen_random_uuid(), incident_id uuid, patient_id uuid, limb text, applied_at timestamptz, is_active boolean, time_alert_baseline text);
create table watchdog_alerts (id uuid primary key default gen_random_uuid(), incident_id uuid not null, patient_id uuid, actor_id uuid, alert_type text not null,
  severity text not null, message text not null, triggered_at timestamptz default now(), resolved_at timestamptz, payload_json jsonb not null default '{}', dedupe_key text,
  updated_at timestamptz default now(), version int default 1);
create table refresh_log (incident_id uuid, at timestamptz default clock_timestamp());
create function refresh_incident_command_state(p uuid) returns void language sql as $$ insert into refresh_log(incident_id) values (p) $$;
create function app.tourniquet_time_level_rank(p_level text) returns int language sql immutable as $$
  select case p_level when 'notice' then 1 when 'warning' then 2 when 'decision' then 3 when 'critical' then 4 else 0 end $$;
create function app.current_user_role() returns user_role language sql as $$ select 'pc'::user_role $$;
create function app.can_read_incident_patients(p uuid) returns boolean language sql as $$ select true $$;

\ir ../database/095_server_dead_mans_switch.sql
\ir ../database/095_server_dead_mans_switch.sql

\set ON_ERROR_STOP 1
create or replace function t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin if not cond then raise exception 'FAIL: %', msg; end if; raise notice 'ok: %', msg; end $$;
create or replace function t_open(p_actor uuid, p_inc uuid default '00000000-0000-0000-0000-0000000000a1') returns int language sql as $$
  select count(*)::int from watchdog_alerts where alert_type='DEAD_MAN_SWITCH' and actor_id=p_actor and incident_id=p_inc and resolved_at is null $$;

insert into incidents values ('00000000-0000-0000-0000-0000000000a1','active'),('00000000-0000-0000-0000-0000000000a2','active'),('00000000-0000-0000-0000-0000000000c1','closed');
insert into profiles values
 ('00000000-0000-0000-0000-000000000001','Medic One','medic',true),
 ('00000000-0000-0000-0000-000000000002','Medic Two','medic',true),
 ('00000000-0000-0000-0000-000000000003','Para Three','paramedic',true),
 ('00000000-0000-0000-0000-000000000004','Medic Four','medic',true),
 ('00000000-0000-0000-0000-000000000005','Doc Five','physician',true),
 ('00000000-0000-0000-0000-000000000006','PC Six','pc',true),
 ('00000000-0000-0000-0000-000000000007','Medic Seven','medic',false),
 ('00000000-0000-0000-0000-000000000008','Medic Eight','medic',true);
-- open patients for everyone in a1; Medic Four's patient is handed over; Medic Eight only in the closed incident
insert into patients (incident_id, created_by, current_status) values
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','treating'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000001','extricated'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000002','treating'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000003','identified'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000004','handed_over'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000005','treating'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000006','treating'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-000000000007','treating'),
 ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-000000000008','treating');
update patients set current_triage='green', last_vitals_at=now();
-- contact: everyone silent 15 min by default
insert into device_presence select null, id, 'dev-'||right(id::text,1), now()-interval '15 min' from profiles;
insert into events (actor_id, server_timestamp) select id, now()-interval '12 min' from profiles;
-- Medic Two: heartbeat stale, but the server stored an event 3 min ago
insert into events (actor_id, server_timestamp) values ('00000000-0000-0000-0000-000000000002', now()-interval '3 min');
-- Para Three: device A 20 min old, device B (other incident) fresh
update device_presence set last_heartbeat_at=now()-interval '20 min' where actor_id='00000000-0000-0000-0000-000000000003';
insert into device_presence values ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-000000000003','dev-3b', now()-interval '1 min');

select app.run_clinical_watchdog() as run1 \gset
\echo :run1
select t_assert(t_open('00000000-0000-0000-0000-000000000001')=1, 'S1 silent medic with open patients raises one alert (not one per patient)');
select t_assert((select (payload_json->>'open_patients')::int=2 and (payload_json->>'minutes')::int=12 and severity='critical' and patient_id is null
                 from watchdog_alerts where actor_id='00000000-0000-0000-0000-000000000001' and alert_type='DEAD_MAN_SWITCH'), 'S1 payload: 2 open patients, 12 min since last contact (the event, not the heartbeat), critical, no patient');
select t_assert(t_open('00000000-0000-0000-0000-000000000002')=0, 'S2 stale heartbeat but recent server event: no alert');
select t_assert(t_open('00000000-0000-0000-0000-000000000003')=0, 'S3 a second device with a fresh heartbeat: no alert');
select t_assert(t_open('00000000-0000-0000-0000-000000000004')=0, 'S7 all patients handed over: no alert');
select t_assert(t_open('00000000-0000-0000-0000-000000000005')=0 and t_open('00000000-0000-0000-0000-000000000006')=0, 'S8 physician / PC registrants: no alert');
select t_assert(t_open('00000000-0000-0000-0000-000000000007')=0, 'S8 inactive medic: no alert');
select t_assert(t_open('00000000-0000-0000-0000-000000000008','00000000-0000-0000-0000-0000000000c1')=0, 'S9 closed incident: no alert');
select t_assert((select count(*) from watchdog_alerts where alert_type='DEAD_MAN_SWITCH')=1, 'only one DMS alert overall');

select app.run_clinical_watchdog() as run2 \gset
\echo :run2
select t_assert((select count(*) from watchdog_alerts where alert_type='DEAD_MAN_SWITCH')=1 and (:'run2'::jsonb->>'raised')::int=0, 'S4 second run idempotent');

-- S6b: a late offline push 10 min after the event (event stored now, local time irrelevant) resolves
update device_presence set last_heartbeat_at=now() where actor_id='00000000-0000-0000-0000-000000000001' and device_id='dev-1';
select app.run_clinical_watchdog() as run3 \gset
select t_assert(t_open('00000000-0000-0000-0000-000000000001')=0, 'S5 fresh heartbeat resolves');

-- silent again: new contact time 11 min ago -> a new alert with a new key
update device_presence set last_heartbeat_at=now()-interval '11 min' where actor_id='00000000-0000-0000-0000-000000000001';
select app.run_clinical_watchdog() as run4 \gset
select t_assert(t_open('00000000-0000-0000-0000-000000000001')=1 and (select count(*) from watchdog_alerts where actor_id='00000000-0000-0000-0000-000000000001')=2, 'S6 a new silence raises a new alert');

-- an event pushed now (offline phone back) resolves
insert into events (actor_id, server_timestamp) values ('00000000-0000-0000-0000-000000000001', now());
select app.run_clinical_watchdog() as run5 \gset
select t_assert(t_open('00000000-0000-0000-0000-000000000001')=0, 'S5b a stored event resolves');

-- silent again and then every patient handed over -> resolves
update device_presence set last_heartbeat_at=now()-interval '30 min' where actor_id='00000000-0000-0000-0000-000000000001';
-- (test data only: contact time never moves back in real life; this gives a fresh contact time)
update events set server_timestamp=now()-interval '20 min' where actor_id='00000000-0000-0000-0000-000000000001';
select app.run_clinical_watchdog() as run6 \gset
select t_assert(t_open('00000000-0000-0000-0000-000000000001')=1, 'S6c silent again raises');
update patients set current_status='handed_over' where created_by='00000000-0000-0000-0000-000000000001';
select app.run_clinical_watchdog() as run7 \gset
select t_assert(t_open('00000000-0000-0000-0000-000000000001')=0, 'S7b last patient handed over resolves');

-- 9 min 50 s is not yet 10 min
update device_presence set last_heartbeat_at=now()-interval '9 min 50 sec' where actor_id='00000000-0000-0000-0000-000000000002';
delete from events where actor_id='00000000-0000-0000-0000-000000000002';
select app.run_clinical_watchdog() as run8 \gset
select t_assert(t_open('00000000-0000-0000-0000-000000000002')=0, 'S10 under 10 min: no alert');

-- vitals alerts still raised, and a DMS failure does not take them down
update patients set current_triage='red', last_vitals_at=now()-interval '15 min' where created_by='00000000-0000-0000-0000-000000000003';
update device_presence set last_heartbeat_at=now()-interval '20 min' where actor_id='00000000-0000-0000-0000-000000000003';
alter function app.medic_last_contact_at(uuid) rename to medic_last_contact_at_hidden;
select app.run_clinical_watchdog() as run9 \gset
\echo :run9
select t_assert((select count(*) from watchdog_alerts where alert_type='VITALS_OVERDUE' and resolved_at is null)=1 and (:'run9'::jsonb->>'failed_incidents')::int>=1, 'S11 DMS failure: vitals alert still raised, failure counted');
alter function app.medic_last_contact_at_hidden(uuid) rename to medic_last_contact_at;
select app.run_clinical_watchdog() as run10 \gset
select t_assert(t_open('00000000-0000-0000-0000-000000000003')=1 and (:'run10'::jsonb->>'failed_incidents')::int=0, 'S11b recovered: para three (both devices now 20 min) raises');

-- RLS: the rescue chain reads this alert type only
create or replace function app.current_user_role() returns user_role language sql stable as $$ select current_setting('test.role')::user_role $$;
create or replace function app.can_read_incident_clinical(p uuid) returns boolean language sql stable as $$ select app.current_user_role() not in ('rpc','rcc','logistics_officer') $$;
alter table watchdog_alerts enable row level security;
create policy watchdog_read_authenticated on watchdog_alerts for select to authenticated using (app.can_read_incident_clinical(incident_id));
grant usage on schema app to authenticated; grant select on watchdog_alerts to authenticated;
grant execute on function t_assert(boolean,text),  app.current_user_role(), app.can_read_incident_clinical(uuid), app.can_read_incident_patients(uuid) to authenticated;
set role authenticated;
set test.role='rpc';
select t_assert((select count(*) from watchdog_alerts where alert_type<>'DEAD_MAN_SWITCH')=0 and (select count(*) from watchdog_alerts)>0, 'RLS rpc reads DMS alerts only');
set test.role='rcc';
select t_assert((select count(*) from watchdog_alerts where alert_type<>'DEAD_MAN_SWITCH')=0 and (select count(*) from watchdog_alerts)>0, 'RLS rcc reads DMS alerts only');
set test.role='logistics_officer';
select t_assert((select count(*) from watchdog_alerts)=0, 'RLS logistics reads none');
set test.role='pc';
select t_assert((select count(*) from watchdog_alerts where alert_type='VITALS_OVERDUE')>0, 'RLS pc still reads clinical alerts');
