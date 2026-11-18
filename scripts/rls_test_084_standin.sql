-- Stand-in tables for scripts/rls_test_084_supply_request_cancel.sql (WP-24): the live definitions the test
-- needs (enums, profiles, incidents, events, supply_requests with its pre-084 policies), on a throwaway
-- local PostgreSQL. Order: this file, database/059, the trigger from 033, 082 (WP-38), 083, 084, then the test.
-- stand-ins shaped like the live definitions (types, profiles, incidents, events, supply_requests, policies)
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$; do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
create schema app;
create type user_role as enum ('medic','paramedic','physician','pc','cc','logistics_officer','chamal','rpc','rcc','admin');
create type event_type as enum ('SUPPLY_REQUEST_CREATED','RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE','RESUPPLY_REQUEST_ESCALATED_CC','RESUPPLY_APPROVED_FROM_PC_TRUCK','PC_TRUCK_RESUPPLY_UNAVAILABLE_ESCALATED','RESUPPLY_ESCALATED_TO_CC','SUPPLY_REQUEST_DISPATCHED','SUPPLY_REQUEST_IN_TRANSIT','SUPPLY_REQUEST_RECEIVED','VITALS_RECORDED');
create type supply_request_status as enum ('requested','approved','dispatched','in_transit','delivered','cancelled');
create table profiles (id uuid primary key, role user_role not null);
create table incidents (id uuid primary key);
create table events (id bigserial primary key, incident_id uuid, actor_id uuid, actor_role user_role, device_id text, local_event_id text, type event_type, payload_json jsonb default '{}', local_timestamp timestamptz default now());
create table supply_requests (
  id uuid primary key default gen_random_uuid(), incident_id uuid not null references incidents(id) on delete cascade,
  requester_id uuid not null references profiles(id), supervisor_id uuid, logistics_officer_id uuid references profiles(id), kit_template_id uuid,
  status supply_request_status not null default 'requested',
  request_level text not null default 'medic_to_pc' check (request_level in ('medic_to_pc','pc_to_logo','logo_direct_to_medic')),
  parent_supply_request_id uuid, approved_by_pc uuid references profiles(id), direct_resupply_override_reason text,
  delivery_location_json jsonb not null default '{}', eta_minutes integer, notes text, requested_at timestamptz not null default now(),
  dispatched_at timestamptz, in_transit_at timestamptz, delivered_at timestamptz, updated_at timestamptz not null default now(), version integer not null default 1,
  origin_device_id text, origin_client_request_id text, items_json jsonb not null default '[]', assigned_runner_name text);
create unique index on supply_requests(origin_device_id, origin_client_request_id) where origin_device_id is not null and origin_client_request_id is not null;
create function app.current_user_role() returns user_role language sql stable security definer set search_path=public as $$ select role from profiles where id = nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
create function app.can_access_incident(uuid) returns boolean language sql stable as $$ select true $$;
create function app.can_read_incident_patients(uuid) returns boolean language sql stable as $$ select true $$;
alter table supply_requests enable row level security;
create policy supply_requests_read_authenticated on supply_requests for select to authenticated using (app.can_read_incident_patients(incident_id));
create policy supply_requests_insert on supply_requests for insert with check (app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[]));
create policy supply_requests_update on supply_requests for update using (app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[]));
create policy supply_requests_delete on supply_requests for delete using (app.can_access_incident(incident_id) and app.current_user_role() = any (array['medic','pc','paramedic','logistics_officer','admin']::user_role[]));
grant usage on schema public, app to authenticated, anon;
grant select, insert, update, delete on supply_requests to authenticated, anon;
grant execute on function app.current_user_role(), app.can_access_incident(uuid), app.can_read_incident_patients(uuid) to authenticated;
