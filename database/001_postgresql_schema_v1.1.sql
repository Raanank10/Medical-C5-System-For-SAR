-- C5 Sentinel-SAR PostgreSQL / Supabase Schema v1.1
-- Event-sourced, offline-first, realtime-outbox architecture

create extension if not exists pgcrypto;

-- =========================================================
-- ENUMS
-- =========================================================

do $$ begin create type user_role as enum ('medic','pc','logistics_officer','cc','chamal','admin'); exception when duplicate_object then null; end $$;

-- v1.1 enum additions for dependency-aware sync, dynamic tourniquet context, and rolling AAR notes.
do $$ begin
  alter type event_type add value if not exists 'TOURNIQUET_CONTEXT_UPDATED';
  alter type event_type add value if not exists 'AAR_CONTEXT_NOTE_ADDED';
  alter type event_type add value if not exists 'HIGH_RISK_OVERRIDE_CONFIRMED';
  alter type event_type add value if not exists 'PATIENT_INJURY_UPDATED';
  alter type event_type add value if not exists 'PATIENT_IDENTIFIED';
  alter type event_type add value if not exists 'PATIENT_TRIAGED_EXPECTANT';
  alter type event_type add value if not exists 'AIRWAY_MANAGED';
exception when duplicate_object or undefined_object then null; end $$;

do $$ begin create type incident_status as enum ('draft','staging','active','closed'); exception when duplicate_object then null; end $$;
do $$ begin create type triage_level as enum ('red','yellow','green','black','pending','unknown'); exception when duplicate_object then null; end $$;
do $$ begin create type access_status as enum ('trapped','partial','free','unknown'); exception when duplicate_object then null; end $$;
do $$ begin create type patient_status as enum ('identified','stabilizing','observing','extricating','evacuating','treating','extricated','handed_over','closed','self_evacuated','deceased','unknown'); exception when duplicate_object then null; end $$;
do $$ begin
  alter type patient_status add value if not exists 'stabilizing';
  alter type patient_status add value if not exists 'extricating';
  alter type patient_status add value if not exists 'evacuating';
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin create type supply_request_status as enum ('requested','approved','dispatched','in_transit','delivered','cancelled'); exception when duplicate_object then null; end $$;
do $$ begin create type external_source as enum ('mda','united_hatzalah','police','idf','civilian','other'); exception when duplicate_object then null; end $$;

do $$ begin
  create type event_type as enum (
    'INCIDENT_DRAFT_CREATED','INCIDENT_OPENED','INCIDENT_CONFIRMED','INCIDENT_DRAFT_MERGED','INCIDENT_DRAFT_REJECTED','INCIDENT_CLOSED','INCIDENT_REOPENED',
    'PATIENT_CREATED','QUICK_PATIENT_CREATED','PATIENT_IDENTIFIED','PATIENT_TRIAGED_EXPECTANT','PATIENT_T_INJURY_UPDATED','PATIENT_LOCATION_UPDATED','PATIENT_INJURY_UPDATED','PATIENT_ACCESS_UPDATED','PATIENT_TRIAGE_UPDATED','PATIENT_STATUS_UPDATED','PATIENT_HANDED_OVER',
    'VITALS_RECORDED','MINIMAL_TRIAGE_RECORDED','SABCDE_RECORDED','MSTART_SUGGESTED','JUMPSTART_SUGGESTED','MSTART_OVERRIDE','JUMPSTART_OVERRIDE',
    'TOURNIQUET_APPLIED','TOURNIQUET_REASSESSMENT','TOURNIQUET_RELEASED','INTERVENTION_RECORDED','MEDICATION_ADMINISTERED','AIRWAY_MANAGED',
    'EXTERNAL_REPORT_CREATED','EXTERNAL_REPORT_LINKED',
    'SUPPLY_REQUEST_CREATED','SUPPLY_REQUEST_DISPATCHED','SUPPLY_REQUEST_IN_TRANSIT','SUPPLY_REQUEST_RECEIVED',
    'INVENTORY_LEDGER_ENTRY','INVENTORY_INITIALIZED','INVENTORY_TRANSFER_OUT','INVENTORY_TRANSFER_IN','PLATOON_STOCK_INITIALIZED','PLATOON_STOCK_REFILLED','DIRECT_LOGO_TO_MEDIC_REFILL','WATCHDOG_ALERT','WATCHDOG_ACKNOWLEDGED','WATCHDOG_RESOLVED',
    'BUILDING_STATUS_UPDATED','SITE_CLEAR_CONFIRMED','MEDIC_SITE_CLOSE_REQUESTED',
    'SYNC_CONFLICT','CONFLICT_LOG_ENTRY','TREATMENT_SAFETY_WARNING','COMMAND_CONTEXT_NOTE_ADDED','VOICE_MEMO_ADDED','HIGH_RISK_CLINICAL_VIOLATION','DEAD_MAN_SWITCH_ESCALATED','NOTE_ADDED',
    'TOURNIQUET_CONTEXT_UPDATED','AAR_CONTEXT_NOTE_ADDED','HIGH_RISK_OVERRIDE_CONFIRMED'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  alter type event_type add value if not exists 'PATIENT_IDENTIFIED';
exception when duplicate_object or undefined_object then null; end $$;

-- =========================================================
-- USERS / PROFILES
-- =========================================================

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  role user_role not null default 'medic',
  unit_name text,
  phone text,
  device_id text,
  last_seen_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create index if not exists idx_profiles_role on profiles(role);
create index if not exists idx_profiles_last_seen on profiles(last_seen_at);

-- =========================================================
-- INCIDENTS
-- t_zero is official strike/incident time.
-- t_injury_default defaults to t_zero and is used by clinical timers.
-- =========================================================

create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  visual_id text unique,
  t_zero timestamptz not null,
  t_injury_default timestamptz not null,
  location_name text not null,
  address text,
  incident_type text,
  status incident_status not null default 'draft',
  draft_created_by uuid references profiles(id),
  confirmed_by uuid references profiles(id),
  opened_by uuid references profiles(id),
  closed_by uuid references profiles(id),
  opened_at timestamptz not null default now(),
  confirmed_at timestamptz,
  draft_acknowledged_by uuid references profiles(id),
  draft_acknowledged_at timestamptz,
  draft_resolved_at timestamptz,
  closed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  constraint chk_incident_time_default check (t_injury_default >= t_zero)
);

create index if not exists idx_incidents_status on incidents(status);
create index if not exists idx_incidents_t_zero on incidents(t_zero);

-- Incident memberships scope operational access.
-- Command/global roles may still use service-role dashboards, but direct table RLS
-- is scoped by incident membership instead of broad authenticated access.
create table if not exists incident_memberships (
  incident_id uuid not null references incidents(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  role_at_incident user_role not null,
  assigned_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (incident_id, profile_id)
);

create index if not exists idx_incident_memberships_profile
on incident_memberships(profile_id, incident_id);


-- =========================================================
-- SECTORS
-- =========================================================

create table if not exists sectors (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  building_no text not null,
  floor text,
  apartment text,
  room text,
  sector_label text not null default 'UNASSIGNED',
  building_status text not null default 'unknown' check (building_status in ('stable','unstable','unknown')),
  is_site_clear boolean not null default false,
  site_clear_confirmed_by uuid references profiles(id),
  site_clear_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (incident_id, building_no, floor, apartment, room)
);

create index if not exists idx_sectors_incident on sectors(incident_id);
create index if not exists idx_sectors_location on sectors(incident_id, building_no, floor, apartment, room);

-- Auto-label sectors for heatmap display.
create or replace function fill_sector_label()
returns trigger as $$
begin
  if new.sector_label is null or trim(new.sector_label) = '' or new.sector_label = 'UNASSIGNED' then
    new.sector_label := concat_ws(' / ',
      'Building ' || new.building_no,
      case when new.floor is not null then 'Floor ' || new.floor end,
      case when new.apartment is not null then 'Apt ' || new.apartment end,
      case when new.room is not null then new.room end
    );
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_fill_sector_label on sectors;
create trigger trg_fill_sector_label
before insert or update on sectors
for each row execute function fill_sector_label();


-- =========================================================
-- PATIENTS — projection/read model
-- =========================================================

create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  sector_id uuid references sectors(id),
  visual_id text not null,
  optional_name text,
  t_injury timestamptz not null,
  current_triage triage_level not null default 'pending',
  algorithm_triage triage_level,
  triage_recorded_at timestamptz,
  access_status access_status not null default 'unknown',
  access_recorded_at timestamptz,
  current_status patient_status not null default 'identified',
  status_recorded_at timestamptz,
  is_pediatric boolean not null default false,
  pediatric_age_years integer,
  needs_full_assessment boolean not null default false,
  pending_incident_approval boolean not null default false,
  pulse_present boolean,
  breathing_present boolean,
  tourniquet_used boolean,
  injury_zones jsonb not null default '[]'::jsonb,
  is_trapped boolean generated always as (access_status in ('trapped','partial')) stored,
  location_json jsonb not null default '{}'::jsonb,
  location_recorded_at timestamptz,
  last_vitals_at timestamptz,
  last_seen_at timestamptz,
  handed_over_at timestamptz,
  handed_over_to text,
  handover_token uuid not null default gen_random_uuid(),
  handover_token_used_at timestamptz,
  handover_token_expires_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (incident_id, visual_id),
  constraint chk_pediatric_age check (pediatric_age_years is null or pediatric_age_years between 0 and 17)
);

create index if not exists idx_patients_incident on patients(incident_id);
create index if not exists idx_patients_triage on patients(current_triage);
create index if not exists idx_patients_status on patients(current_status);
create index if not exists idx_patients_sector on patients(sector_id);
create index if not exists idx_patients_last_vitals on patients(last_vitals_at);
create unique index if not exists idx_patients_handover_token on patients(handover_token);
create index if not exists idx_patients_needs_full_assessment on patients(needs_full_assessment) where needs_full_assessment = true;
create index if not exists idx_patients_pending_incident_approval on patients(pending_incident_approval) where pending_incident_approval = true;

alter table patients
  add column if not exists injury_zones jsonb not null default '[]'::jsonb;

create index if not exists idx_patients_injury_zones_gin on patients using gin(injury_zones);

-- =========================================================
-- EVENTS — immutable append-only log
-- =========================================================

create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  patient_id uuid references patients(id) on delete cascade,
  actor_id uuid references profiles(id),
  actor_role user_role,
  type event_type not null,
  payload_json jsonb not null default '{}'::jsonb,
  device_id text not null,
  local_event_id text not null,
  local_timestamp timestamptz not null,
  server_timestamp timestamptz not null default now(),
  synced_at timestamptz,
  sync_cursor bigserial,
  event_version integer not null default 1,
  unique (device_id, local_event_id)
);

create index if not exists idx_events_incident_time on events(incident_id, server_timestamp);
create index if not exists idx_events_patient_time on events(patient_id, server_timestamp);
create index if not exists idx_events_type on events(type);
create index if not exists idx_events_sync_cursor on events(sync_cursor);
create index if not exists idx_events_payload_gin on events using gin(payload_json);
create index if not exists idx_events_vitals_bp on events ((payload_json->>'bp')) where type = 'VITALS_RECORDED' and payload_json ? 'bp';
create index if not exists idx_events_vitals_avpu on events ((payload_json->>'avpu')) where type = 'VITALS_RECORDED' and payload_json ? 'avpu';
create index if not exists idx_events_vitals_spo2 on events (((payload_json->>'spo2')::int)) where type = 'VITALS_RECORDED' and payload_json ? 'spo2';
create index if not exists idx_events_triage on events ((payload_json->>'triage')) where payload_json ? 'triage';
create index if not exists idx_events_status on events ((payload_json->>'status')) where payload_json ? 'status';
create index if not exists idx_events_lifecycle_milestones
on events(incident_id, patient_id, type, local_timestamp)
where type in ('QUICK_PATIENT_CREATED','PATIENT_CREATED','PATIENT_IDENTIFIED','VITALS_RECORDED','TOURNIQUET_APPLIED','PATIENT_HANDED_OVER');
create index if not exists idx_events_patient_lifecycle_status
on events(patient_id, local_timestamp)
where type in ('PATIENT_TRIAGED_EXPECTANT','TOURNIQUET_APPLIED','MEDICATION_ADMINISTERED','AIRWAY_MANAGED','VITALS_RECORDED','PATIENT_HANDED_OVER');

update events
set device_id = 'legacy-unknown-device'
where device_id is null;

alter table events
  alter column device_id set not null;

create or replace function prevent_event_mutation()
returns trigger as $$
begin
  raise exception 'events are immutable. append a new event instead.';
end;
$$ language plpgsql;

drop trigger if exists trg_prevent_event_update on events;
create trigger trg_prevent_event_update
before update or delete on events
for each row execute function prevent_event_mutation();

-- Temporary signed handover tokens used by MIST QR handoff.
-- The QR code carries an encrypted URL/token, not static clinical files.
create table if not exists patient_handover_tokens (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  source_event_id uuid references events(id) on delete set null,
  handover_method text not null default 'secure_qr_token',
  destination_facility text,
  receiving_unit_transport text,
  token_hash text not null,
  token_signature text not null,
  encrypted_link text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (token_hash)
);

create index if not exists idx_handover_tokens_patient
on patient_handover_tokens(patient_id, created_at desc);

create index if not exists idx_handover_tokens_unconsumed
on patient_handover_tokens(expires_at)
where consumed_at is null;


-- =========================================================
-- SYNC INGESTION ERRORS
-- Poison/malformed events are quarantined here so one bad event
-- cannot block the rest of a device sync batch.
-- Clinical events that are parseable but incomplete should still be
-- accepted into events and flagged via watchdog/conflict tables.
-- =========================================================

create table if not exists sync_ingestion_errors (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid references incidents(id) on delete set null,
  device_id text,
  actor_id uuid references profiles(id) on delete set null,
  local_event_id text,
  error_code text not null,
  error_message text not null,
  raw_payload jsonb,
  retryable boolean not null default false,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references profiles(id) on delete set null,
  resolution_notes text
);

create index if not exists idx_sync_ingestion_errors_device_event
on sync_ingestion_errors(device_id, local_event_id);

create index if not exists idx_sync_ingestion_errors_unresolved
on sync_ingestion_errors(created_at)
where resolved_at is null;

-- =========================================================
-- REALTIME OUTBOX
-- =========================================================

create table if not exists realtime_outbox (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  incident_id uuid not null references incidents(id) on delete cascade,
  patient_id uuid references patients(id) on delete cascade,
  event_type event_type not null,
  channel text not null default 'chamal',
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  retry_count integer not null default 0,
  last_error text
);

create index if not exists idx_realtime_outbox_unprocessed on realtime_outbox(created_at) where processed_at is null;
create index if not exists idx_realtime_outbox_incident on realtime_outbox(incident_id, created_at);

-- =========================================================
-- EXTERNAL REPORTS / DEDUP
-- =========================================================

create table if not exists external_reports (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  source external_source not null,
  external_reference text,
  reported_red integer not null default 0 check (reported_red >= 0),
  reported_yellow integer not null default 0 check (reported_yellow >= 0),
  reported_green integer not null default 0 check (reported_green >= 0),
  reported_black integer not null default 0 check (reported_black >= 0),
  evacuation_destination text,
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create index if not exists idx_external_reports_incident on external_reports(incident_id);
create index if not exists idx_external_reports_source on external_reports(source);

create table if not exists external_patient_links (
  id uuid primary key default gen_random_uuid(),
  external_report_id uuid not null references external_reports(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  match_score numeric(5,2) not null default 0,
  match_reason jsonb not null default '{}'::jsonb,
  linked_by uuid references profiles(id),
  linked_at timestamptz not null default now(),
  unique (external_report_id, patient_id)
);

-- =========================================================
-- INVENTORY LEDGER / LOGISTICS
-- =========================================================

create table if not exists inventory_items (
  id uuid primary key default gen_random_uuid(),
  sku text unique not null,
  name text not null,
  category text,
  unit text not null default 'unit',
  is_life_saving boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

-- Treatment catalog defines available treatment actions and their safety requirements.
create table if not exists treatment_catalog (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  display_name text not null,
  category text not null check (category in ('hemorrhage','airway','circulation','medication','cpr','other')),
  event_type event_type not null,
  requires_limb boolean not null default false,
  requires_application_time boolean not null default false,
  is_medication boolean not null default false,
  requires_pediatric_weight boolean not null default false,
  warns_on_reduced_avpu boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Maps a treatment action to inventory consumption.
-- Example: TOURNIQUET -> TQ x1; COMBAT_GAUZE -> COMBAT_GAUZE x1.
create table if not exists treatment_inventory_items (
  id uuid primary key default gen_random_uuid(),
  treatment_code text not null references treatment_catalog(code),
  item_id uuid not null references inventory_items(id),
  quantity_per_treatment integer not null check (quantity_per_treatment > 0),
  unique (treatment_code, item_id)
);

create index if not exists idx_treatment_catalog_active on treatment_catalog(is_active) where is_active = true;


create table if not exists inventory_ledger (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid references incidents(id) on delete cascade,

  -- Current owner of this ledger row.
  owner_id uuid references profiles(id),
  owner_type text not null default 'medic_bag' check (owner_type in ('medic_bag','platoon_stock','truck_stock','logistics_stock','external')),
  owner_label text,

  -- Transfer metadata. Paired transfer rows share transfer_group_id.
  source_owner_id uuid references profiles(id),
  source_owner_type text check (source_owner_type in ('medic_bag','platoon_stock','truck_stock','logistics_stock','external')),
  target_owner_id uuid references profiles(id),
  target_owner_type text check (target_owner_type in ('medic_bag','platoon_stock','truck_stock','logistics_stock','external')),
  transfer_group_id uuid,
  transfer_kind text check (transfer_kind in ('INITIAL_FILL','MEDIC_REQUEST_FROM_PLATOON','PC_TO_MEDIC','LOGO_TO_PLATOON','DIRECT_LOGO_TO_MEDIC','TREATMENT_CONSUMPTION','MANUAL_ADJUSTMENT')),
  authorized_by uuid references profiles(id),
  direct_override_reason text,

  item_id uuid not null references inventory_items(id),
  quantity_change integer not null,
  location_at_time jsonb not null default '{}'::jsonb,
  reason text not null check (reason in ('INITIAL_STOCK','INTERVENTION_USED','MEDICATION_USED','TRANSFER_OUT','TRANSFER_IN','RESUPPLY_SENT','RESUPPLY_RECEIVED','MANUAL_ADJUSTMENT','LOSS_REPORTED')),
  related_patient_id uuid references patients(id),
  related_event_id uuid references events(id),
  supply_request_id uuid,
  device_id text,
  local_ledger_id text not null,
  local_timestamp timestamptz not null,
  server_timestamp timestamptz not null default now(),
  synced_at timestamptz,
  notes text,
  unique (device_id, local_ledger_id),
  constraint chk_inventory_direct_logo_override check (
    transfer_kind <> 'DIRECT_LOGO_TO_MEDIC'
    or (direct_override_reason is not null and length(trim(direct_override_reason)) >= 10)
  )
);

create index if not exists idx_inventory_ledger_incident on inventory_ledger(incident_id);
create index if not exists idx_inventory_ledger_owner_item on inventory_ledger(owner_id, owner_label, item_id);
create index if not exists idx_inventory_ledger_item on inventory_ledger(item_id);
create index if not exists idx_inventory_ledger_time on inventory_ledger(server_timestamp);

create index if not exists idx_inventory_ledger_owner_type_item on inventory_ledger(owner_type, owner_id, owner_label, item_id);
create index if not exists idx_inventory_ledger_transfer_group on inventory_ledger(transfer_group_id) where transfer_group_id is not null;
create index if not exists idx_inventory_ledger_transfer_kind on inventory_ledger(transfer_kind) where transfer_kind is not null;


create table if not exists kit_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  is_active boolean not null default true,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create table if not exists kit_template_items (
  id uuid primary key default gen_random_uuid(),
  kit_template_id uuid not null references kit_templates(id) on delete cascade,
  item_id uuid not null references inventory_items(id),
  quantity integer not null check (quantity > 0),
  unique (kit_template_id, item_id)
);

create table if not exists supply_requests (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  requester_id uuid not null references profiles(id),
  supervisor_id uuid references profiles(id),
  logistics_officer_id uuid references profiles(id),
  kit_template_id uuid references kit_templates(id),
  status supply_request_status not null default 'requested',
  request_level text not null default 'medic_to_pc' check (request_level in ('medic_to_pc','pc_to_logo','logo_direct_to_medic')),
  parent_supply_request_id uuid,
  approved_by_pc uuid references profiles(id),
  direct_resupply_override_reason text,
  delivery_location_json jsonb not null default '{}'::jsonb,
  eta_minutes integer,
  notes text,
  requested_at timestamptz not null default now(),
  dispatched_at timestamptz,
  in_transit_at timestamptz,
  delivered_at timestamptz,
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create index if not exists idx_supply_requests_incident on supply_requests(incident_id);
create index if not exists idx_supply_requests_status on supply_requests(status);
create index if not exists idx_supply_requests_request_level on supply_requests(request_level);

alter table supply_requests drop constraint if exists fk_supply_requests_parent;
alter table supply_requests add constraint fk_supply_requests_parent foreign key (parent_supply_request_id) references supply_requests(id);

alter table supply_requests drop constraint if exists chk_supply_direct_override_reason;
alter table supply_requests add constraint chk_supply_direct_override_reason check (
  request_level <> 'logo_direct_to_medic'
  or (direct_resupply_override_reason is not null and length(trim(direct_resupply_override_reason)) >= 10)
);

create table if not exists supply_request_items (
  id uuid primary key default gen_random_uuid(),
  supply_request_id uuid not null references supply_requests(id) on delete cascade,
  item_id uuid not null references inventory_items(id),
  quantity integer not null check (quantity > 0),
  unique (supply_request_id, item_id)
);

alter table inventory_ledger drop constraint if exists fk_inventory_ledger_supply_request;
alter table inventory_ledger add constraint fk_inventory_ledger_supply_request foreign key (supply_request_id) references supply_requests(id);

-- =========================================================
-- WATCHDOG / DEVICE / CONFLICT
-- =========================================================

create table if not exists watchdog_alerts (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  patient_id uuid references patients(id) on delete cascade,
  actor_id uuid references profiles(id),
  alert_type text not null,
  severity text not null check (severity in ('info','warning','critical')),
  message text not null,
  triggered_at timestamptz not null default now(),
  acknowledged_by uuid references profiles(id),
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  payload_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create index if not exists idx_watchdog_incident on watchdog_alerts(incident_id);
create index if not exists idx_watchdog_patient on watchdog_alerts(patient_id);
create index if not exists idx_watchdog_unresolved on watchdog_alerts(resolved_at) where resolved_at is null;
create index if not exists idx_watchdog_unresolved_severity on watchdog_alerts(incident_id, severity, triggered_at desc) where resolved_at is null;

alter table watchdog_alerts
  add column if not exists dedupe_key text,
  add column if not exists source_event_id uuid references events(id),
  add column if not exists resolved_by_event_id uuid references events(id),
  add column if not exists suppressed_before_dashboard boolean not null default false;

create table if not exists device_presence (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid references incidents(id) on delete cascade,
  actor_id uuid not null references profiles(id),
  device_id text not null,
  current_location_json jsonb not null default '{}'::jsonb,
  current_patient_id uuid references patients(id),
  last_heartbeat_at timestamptz not null default now(),
  sync_status text not null default 'online' check (sync_status in ('online','offline','syncing','error')),
  updated_at timestamptz not null default now(),
  version integer not null default 1,
  unique (incident_id, actor_id, device_id)
);

create index if not exists idx_device_presence_incident on device_presence(incident_id);
create index if not exists idx_device_presence_heartbeat on device_presence(last_heartbeat_at);

create table if not exists conflict_log (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  event_id uuid references events(id),
  patient_id uuid references patients(id),
  actor_id uuid references profiles(id),
  conflict_type text not null,
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  algorithm_value text,
  human_value text,
  reason text,
  description text not null,
  payload_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  resolved_by uuid references profiles(id),
  resolved_at timestamptz,
  updated_at timestamptz not null default now(),
  version integer not null default 1
);

create index if not exists idx_conflict_incident on conflict_log(incident_id);
create index if not exists idx_conflict_patient on conflict_log(patient_id);
create index if not exists idx_conflict_unresolved on conflict_log(resolved_at) where resolved_at is null;

-- =========================================================
-- TRIGGER: projections + outbox + conflict materialization
-- =========================================================

create or replace function apply_event_projection_and_outbox()
returns trigger as $$
begin
  if new.patient_id is not null then
    if new.type = 'VITALS_RECORDED' then
      update patients
      set last_vitals_at = new.local_timestamp,
          last_seen_at = new.local_timestamp,
          needs_full_assessment = false,
          updated_at = now(),
          version = version + 1
      where id = new.patient_id;

    elsif new.type = 'PATIENT_TRIAGED_EXPECTANT' then
      update patients
      set current_status = 'deceased',
          current_triage = 'black',
          needs_full_assessment = false,
          triage_recorded_at = new.local_timestamp,
          status_recorded_at = new.local_timestamp,
          updated_at = now(),
          version = version + 1
      where id = new.patient_id;

    elsif new.type = 'MINIMAL_TRIAGE_RECORDED' or new.type = 'QUICK_PATIENT_CREATED' then
      update patients
      set pulse_present = coalesce((new.payload_json->>'pulse_present')::boolean, pulse_present),
          breathing_present = coalesce((new.payload_json->>'breathing_present')::boolean, breathing_present),
          tourniquet_used = coalesce((new.payload_json->>'tourniquet_used')::boolean, tourniquet_used),
          injury_zones = coalesce(new.payload_json->'injury_zones', injury_zones),
          needs_full_assessment = true,
          updated_at = now(),
          version = version + 1
      where id = new.patient_id;

    elsif new.type = 'PATIENT_TRIAGE_UPDATED' then
      update patients
      set current_triage = coalesce((new.payload_json->>'triage')::triage_level, current_triage),
          algorithm_triage = coalesce((new.payload_json->>'algorithm_triage')::triage_level, algorithm_triage),
          triage_recorded_at = new.local_timestamp,
          updated_at = now(),
          version = version + 1
      where id = new.patient_id
        and (triage_recorded_at is null or new.local_timestamp >= triage_recorded_at);

    elsif new.type = 'PATIENT_ACCESS_UPDATED' then
      update patients
      set access_status = coalesce((new.payload_json->>'access_status')::access_status, access_status),
          access_recorded_at = new.local_timestamp,
          updated_at = now(),
          version = version + 1
      where id = new.patient_id
        and (access_recorded_at is null or new.local_timestamp >= access_recorded_at);

    elsif new.type = 'PATIENT_STATUS_UPDATED' then
      update patients
      set current_status = coalesce((new.payload_json->>'status')::patient_status, current_status),
          status_recorded_at = new.local_timestamp,
          updated_at = now(),
          version = version + 1
      where id = new.patient_id
        and (status_recorded_at is null or new.local_timestamp >= status_recorded_at);

    elsif new.type = 'PATIENT_LOCATION_UPDATED' then
      update patients
      set location_json = coalesce(new.payload_json->'location', location_json),
          location_recorded_at = new.local_timestamp,
          updated_at = now(),
          version = version + 1
      where id = new.patient_id
        and (location_recorded_at is null or new.local_timestamp >= location_recorded_at);

    elsif new.type in ('PATIENT_CREATED','QUICK_PATIENT_CREATED','PATIENT_INJURY_UPDATED') then
      update patients
      set injury_zones = coalesce(new.payload_json->'injury_zones', injury_zones),
          updated_at = now(),
          version = version + 1
      where id = new.patient_id
        and new.payload_json ? 'injury_zones';

    elsif new.type = 'PATIENT_T_INJURY_UPDATED' then
      update patients
      set t_injury = coalesce((new.payload_json->>'t_injury')::timestamptz, t_injury),
          updated_at = now(),
          version = version + 1
      where id = new.patient_id;

    elsif new.type = 'PATIENT_HANDED_OVER' then
      update patients
      set current_status = 'evacuating',
          handed_over_at = new.local_timestamp,
          handed_over_to = coalesce(
            new.payload_json->>'destination_facility',
            new.payload_json->>'receiving_unit_transport',
            new.payload_json->>'handover_to',
            'MDA / Evacuation'
          ),
          needs_full_assessment = false,
          last_seen_at = new.local_timestamp,
          handover_token_used_at = case
            when new.payload_json->>'handover_method' = 'secure_qr_token' then coalesce(handover_token_used_at, new.local_timestamp)
            else handover_token_used_at
          end,
          updated_at = now(),
          version = version + 1
      where id = new.patient_id;

      update watchdog_alerts
      set resolved_at = coalesce(resolved_at, new.server_timestamp),
          resolved_by_event_id = new.id,
          suppressed_before_dashboard = true,
          updated_at = now(),
          version = version + 1
      where incident_id = new.incident_id
        and patient_id = new.patient_id
        and resolved_at is null
        and alert_type in (
          'VITALS_OVERDUE',
          'REASSESSMENT_OVERDUE',
          'TOURNIQUET_REASSESSMENT_OVERDUE',
          'TOURNIQUET_CRITICAL',
          'MISSING_FULL_ASSESSMENT'
        );

      if new.payload_json->>'handover_method' = 'secure_qr_token'
         and new.payload_json ? 'token_hash'
         and new.payload_json ? 'token_signature' then
        insert into patient_handover_tokens (
          incident_id,
          patient_id,
          source_event_id,
          handover_method,
          destination_facility,
          receiving_unit_transport,
          token_hash,
          token_signature,
          encrypted_link,
          expires_at
        )
        values (
          new.incident_id,
          new.patient_id,
          new.id,
          new.payload_json->>'handover_method',
          new.payload_json->>'destination_facility',
          new.payload_json->>'receiving_unit_transport',
          new.payload_json->>'token_hash',
          new.payload_json->>'token_signature',
          new.payload_json->>'encrypted_link',
          coalesce((new.payload_json->>'token_expires_at')::timestamptz, new.server_timestamp + interval '15 minutes')
        )
        on conflict (token_hash) do nothing;
      end if;
    end if;
  end if;

  if new.type in ('MSTART_OVERRIDE','JUMPSTART_OVERRIDE','SYNC_CONFLICT','CONFLICT_LOG_ENTRY','TREATMENT_SAFETY_WARNING','COMMAND_CONTEXT_NOTE_ADDED','VOICE_MEMO_ADDED','HIGH_RISK_CLINICAL_VIOLATION') then
    insert into conflict_log (incident_id, event_id, patient_id, actor_id, conflict_type, severity, algorithm_value, human_value, reason, description, payload_json)
    values (
      new.incident_id,
      new.id,
      new.patient_id,
      new.actor_id,
      new.type::text,
      coalesce(new.payload_json->>'severity','medium'),
      new.payload_json->>'algorithm_value',
      new.payload_json->>'human_value',
      new.payload_json->>'reason',
      coalesce(new.payload_json->>'description', new.type::text),
      new.payload_json
    );
  end if;

  if new.type in (
    'PATIENT_CREATED','QUICK_PATIENT_CREATED','VITALS_RECORDED','MINIMAL_TRIAGE_RECORDED',
    'PATIENT_TRIAGE_UPDATED','PATIENT_STATUS_UPDATED','PATIENT_HANDED_OVER','PATIENT_TRIAGED_EXPECTANT',
    'INTERVENTION_RECORDED','MEDICATION_ADMINISTERED','AIRWAY_MANAGED','TOURNIQUET_APPLIED','TOURNIQUET_RELEASED','TREATMENT_SAFETY_WARNING','HIGH_RISK_CLINICAL_VIOLATION',
    'WATCHDOG_ALERT','SUPPLY_REQUEST_CREATED','SUPPLY_REQUEST_DISPATCHED','SUPPLY_REQUEST_IN_TRANSIT','SUPPLY_REQUEST_RECEIVED',
    'BUILDING_STATUS_UPDATED','SITE_CLEAR_CONFIRMED','SYNC_CONFLICT','MSTART_OVERRIDE','JUMPSTART_OVERRIDE'
  ) then
    insert into realtime_outbox (event_id, incident_id, patient_id, event_type, channel, payload_json)
    values (new.id, new.incident_id, new.patient_id, new.type, 'chamal', new.payload_json);
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_events_projection_outbox on events;
create trigger trg_events_projection_outbox
after insert on events
for each row execute function apply_event_projection_and_outbox();

create or replace function trg_project_patient_lifecycle_status()
returns trigger as $$
declare
  v_payload jsonb;
begin
  v_payload := new.payload_json;

  if new.patient_id is null then
    return new;
  end if;

  -- Fast-path Black/expectant handling: no further assessment debt.
  if new.type = 'PATIENT_TRIAGED_EXPECTANT'
     or v_payload->>'current_triage' = 'black' then
    update patients
    set current_status = 'deceased',
        current_triage = 'black',
        needs_full_assessment = false,
        triage_recorded_at = coalesce(triage_recorded_at, new.local_timestamp),
        status_recorded_at = new.local_timestamp,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id;

  -- Treatment actions imply active stabilization at the point of care.
  elsif new.type in ('TOURNIQUET_APPLIED','MEDICATION_ADMINISTERED','AIRWAY_MANAGED') then
    update patients
    set current_status = 'stabilizing',
        status_recorded_at = new.local_timestamp,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and current_status in ('identified','unknown','treating');

  -- First/secondary vitals after stabilization means care is complete enough for observation.
  elsif new.type = 'VITALS_RECORDED' then
    update patients
    set current_status = 'observing',
        needs_full_assessment = false,
        status_recorded_at = new.local_timestamp,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and current_status = 'stabilizing';

  -- MIST/secure QR handover means the patient is in evacuation/handoff custody.
  elsif new.type = 'PATIENT_HANDED_OVER' then
    update patients
    set current_status = 'evacuating',
        handover_token_used_at = coalesce(handover_token_used_at, now()),
        status_recorded_at = new.local_timestamp,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and current_status <> 'deceased';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists audit_project_lifecycle_status on events;
create trigger audit_project_lifecycle_status
after insert on events
for each row execute function trg_project_patient_lifecycle_status();

-- =========================================================
-- VIEWS
-- =========================================================

create or replace view vw_patient_latest_vitals as
select distinct on (e.patient_id)
  e.patient_id,
  e.local_timestamp as vitals_at,
  coalesce((e.payload_json #>> '{heart_rate,calculated_bpm}')::int, (e.payload_json->>'hr')::int) as hr,
  coalesce((e.payload_json #>> '{respiratory_rate,calculated_per_min}')::int, (e.payload_json->>'rr')::int) as rr,
  e.payload_json->>'bp' as bp,
  e.payload_json->>'avpu' as avpu,
  (e.payload_json->>'spo2')::int as spo2
from events e
where e.type = 'VITALS_RECORDED'
order by e.patient_id, e.local_timestamp desc;

create or replace view vw_incident_tactical_funnel as
select
  i.id as incident_id,
  count(p.id) filter (where p.current_status in ('identified')) as identified,
  count(p.id) filter (where p.current_status in ('stabilizing','treating')) as stabilizing,
  count(p.id) filter (where p.current_status = 'observing') as observing,
  count(p.id) filter (where p.current_status in ('extricating','extricated')) as extricating,
  count(p.id) filter (where p.current_status in ('evacuating','handed_over')) as evacuating,
  count(p.id) filter (where p.current_status = 'deceased') as deceased,
  count(p.id) as total
from incidents i
left join patients p on p.incident_id = i.id
group by i.id;

create or replace view vw_sector_clearance_status as
select
  s.id as sector_id,
  s.incident_id,
  s.building_no,
  s.floor,
  s.apartment,
  s.room,
  s.building_status,
  s.is_site_clear,
  count(p.id) as registered_patients,
  count(p.id) filter (where p.current_status in ('evacuating','handed_over')) as handed_over_patients,
  (
    count(p.id) = count(p.id) filter (where p.current_status in ('evacuating','handed_over','deceased','closed','self_evacuated'))
    and s.is_site_clear = true
  ) as heatmap_green
from sectors s
left join patients p on p.sector_id = s.id
group by s.id;

create or replace view vw_current_inventory as
select
  il.incident_id,
  il.owner_id,
  il.owner_type,
  il.owner_label,
  il.item_id,
  ii.sku,
  ii.name as item_name,
  ii.category,
  ii.unit,
  ii.is_life_saving,
  sum(il.quantity_change) as current_quantity,
  min(il.server_timestamp) as first_ledger_at,
  max(il.server_timestamp) as last_ledger_at
from inventory_ledger il
join inventory_items ii on ii.id = il.item_id
group by il.incident_id, il.owner_id, il.owner_type, il.owner_label, il.item_id, ii.sku, ii.name, ii.category, ii.unit, ii.is_life_saving;

create or replace view vw_active_patient_priority as
select
  p.id as patient_id,
  p.incident_id,
  p.visual_id,
  p.current_triage,
  p.access_status,
  p.current_status,
  p.needs_full_assessment,
  p.tourniquet_used,
  p.pulse_present,
  p.breathing_present,
  p.location_json,
  p.last_vitals_at,
  v.hr,
  v.rr,
  v.bp,
  v.avpu,
  v.spo2,
  case
    when p.current_triage = 'red' then 100
    when p.current_triage = 'yellow' then 60
    when p.current_triage = 'green' then 20
    when p.current_triage = 'black' then 5
    when p.current_triage = 'pending' then 50
    else 10
  end
  + case when p.needs_full_assessment then 40 else 0 end
  + case when p.last_vitals_at is null then 30 else 0 end
  + case when p.last_vitals_at < now() - interval '5 minutes' then 25 else 0 end
  + case when v.spo2 is not null and v.spo2 < 92 then 25 else 0 end
  + case when v.avpu is not null and v.avpu in ('Pain','Unresponsive') then 20 else 0 end
  + case when p.tourniquet_used is true then 15 else 0 end
  as priority_score
from patients p
left join vw_patient_latest_vitals v on v.patient_id = p.id
where p.current_status not in ('evacuating','handed_over','closed','self_evacuated','deceased');


-- =========================================================
-- v1.1 VITALS STEPPER SUPPORT INDEXES
-- Stores raw count + measurement window in events.payload_json:
-- {
--   "heart_rate": {"raw_count": 31, "window_seconds": 15, "calculated_bpm": 124, "entry_method": "stepper"},
--   "respiratory_rate": {"raw_count": 16, "window_seconds": 30, "calculated_per_min": 32, "entry_method": "stepper"}
-- entry_method may be "stepper" or "clinical_override" for explicit no-breathing decisions.
-- }
-- =========================================================

create index if not exists idx_events_vitals_hr_calculated
on events (((payload_json #>> '{heart_rate,calculated_bpm}')::int))
where type = 'VITALS_RECORDED'
  and payload_json #>> '{heart_rate,calculated_bpm}' is not null;

create index if not exists idx_events_vitals_hr_raw_count
on events (((payload_json #>> '{heart_rate,raw_count}')::int))
where type = 'VITALS_RECORDED'
  and payload_json #>> '{heart_rate,raw_count}' is not null;

create index if not exists idx_events_vitals_rr_calculated
on events (((payload_json #>> '{respiratory_rate,calculated_per_min}')::int))
where type = 'VITALS_RECORDED'
  and payload_json #>> '{respiratory_rate,calculated_per_min}' is not null;

create index if not exists idx_inventory_ledger_location_at_time
on inventory_ledger using gin(location_at_time);


-- =========================================================
-- v1.1 PEDIATRIC MEDICATION SAFETY — DO NOT BLOCK CLINICAL SAVES
-- Accepts medication events even if pediatric weight is missing.
-- Flags the issue as a high-risk clinical violation and creates a watchdog alert.
-- =========================================================

create or replace function flag_pediatric_medication_missing_weight()
returns trigger as $$
declare
  patient_is_pediatric boolean;
begin
  if new.patient_id is null or new.type <> 'MEDICATION_ADMINISTERED' then
    return new;
  end if;

  select is_pediatric into patient_is_pediatric
  from patients
  where id = new.patient_id;

  if patient_is_pediatric = true
     and (
       new.payload_json->>'weight_estimate_kg' is null
       or nullif(trim(new.payload_json->>'weight_estimate_kg'), '') is null
     )
  then
    insert into watchdog_alerts (
      incident_id, patient_id, actor_id, alert_type, severity, message, payload_json
    ) values (
      new.incident_id,
      new.patient_id,
      new.actor_id,
      'PEDIATRIC_MEDICATION_MISSING_WEIGHT',
      'critical',
      'Pediatric medication recorded without weight estimate. Review immediately.',
      jsonb_build_object('event_id', new.id, 'source_event_type', new.type, 'payload', new.payload_json)
    );

    insert into conflict_log (
      incident_id, event_id, patient_id, actor_id, conflict_type, severity, description, payload_json
    ) values (
      new.incident_id,
      new.id,
      new.patient_id,
      new.actor_id,
      'HIGH_RISK_CLINICAL_VIOLATION',
      'critical',
      'Pediatric medication recorded without weight_estimate_kg.',
      jsonb_build_object('violation','PEDIATRIC_MEDICATION_MISSING_WEIGHT','payload',new.payload_json)
    );
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_validate_pediatric_medication_event on events;
drop trigger if exists trg_flag_pediatric_medication_missing_weight on events;
create trigger trg_flag_pediatric_medication_missing_weight
after insert on events
for each row execute function flag_pediatric_medication_missing_weight();


-- =========================================================
-- v1.1 TREATMENT UPDATE SUPPORT INDEXES
-- =========================================================

create index if not exists idx_events_treatment_type
on events ((payload_json->>'treatment_type'))
where type in ('INTERVENTION_RECORDED','MEDICATION_ADMINISTERED','TOURNIQUET_APPLIED')
  and payload_json ? 'treatment_type';

create index if not exists idx_events_treatment_location
on events using gin ((payload_json->'location_at_time'))
where type in ('INTERVENTION_RECORDED','MEDICATION_ADMINISTERED','TOURNIQUET_APPLIED')
  and payload_json ? 'location_at_time';


create or replace view vw_patient_treatment_history as
select
  e.id as event_id,
  e.incident_id,
  e.patient_id,
  e.actor_id,
  e.type,
  e.local_timestamp,
  e.payload_json->>'treatment_type' as treatment_type,
  e.payload_json->>'limb' as limb,
  e.payload_json->>'medication' as medication,
  e.payload_json->'location_at_time' as location_at_time,
  e.payload_json as payload_json
from events e
where e.type in ('INTERVENTION_RECORDED','MEDICATION_ADMINISTERED','TOURNIQUET_APPLIED')
order by e.patient_id, e.local_timestamp;



-- Active tourniquet projection rebuilt from append-only events.
create table if not exists tourniquets (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  patient_id uuid not null references patients(id) on delete cascade,
  limb text not null,
  applied_event_id uuid references events(id),
  released_event_id uuid references events(id),
  last_reassessed_event_id uuid references events(id),
  applied_at timestamptz not null,
  released_at timestamptz,
  last_reassessed_at timestamptz,
  reassessment_due_at timestamptz,
  tourniquet_status text not null default 'applied' check (tourniquet_status in ('applied','reassessed','converted','downgraded','released','timed_out')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (patient_id, limb, applied_at)
);

create index if not exists idx_tourniquets_active on tourniquets(incident_id, patient_id) where is_active = true;


-- v1.1 dynamic tourniquet columns required by projection function.
alter table tourniquets
  add column if not exists clinical_context text not null default 'unknown' check (clinical_context in ('arterial_bleed','amputation','crush_entrapment','venous_bleed','uncertain','unknown')),
  add column if not exists reassessment_interval_minutes integer not null default 60 check (reassessment_interval_minutes between 10 and 120),
  add column if not exists next_reassessment_due_at timestamptz,
  add column if not exists last_reassessment_event_id uuid references events(id),
  add column if not exists released_by_event_id uuid references events(id);

create or replace function project_tourniquet_events()
returns trigger as $$
declare
  v_context text;
  v_interval integer;
  v_applied_at timestamptz;
begin
  if new.type = 'TOURNIQUET_APPLIED' and new.patient_id is not null then
    v_context := coalesce(new.payload_json->>'clinical_context', 'unknown');
    v_interval := coalesce(
      nullif(new.payload_json->>'reassessment_interval_minutes','')::integer,
      case v_context
        when 'crush_entrapment' then 30
        when 'uncertain' then 30
        when 'unknown' then 30
        when 'arterial_bleed' then 60
        when 'amputation' then 60
        when 'venous_bleed' then 60
        else 60
      end
    );
    v_interval := least(greatest(v_interval, 10), 120);
    v_applied_at := coalesce((new.payload_json->>'application_time')::timestamptz, new.local_timestamp);

    insert into tourniquets (
      incident_id,
      patient_id,
      limb,
      applied_event_id,
      applied_at,
      reassessment_due_at,
      clinical_context,
      reassessment_interval_minutes,
      next_reassessment_due_at,
      is_active
    )
    values (
      new.incident_id,
      new.patient_id,
      coalesce(new.payload_json->>'limb','unknown'),
      new.id,
      v_applied_at,
      v_applied_at + make_interval(mins => v_interval),
      v_context,
      v_interval,
      v_applied_at + make_interval(mins => v_interval),
      true
    )
    on conflict (patient_id, limb, applied_at) do nothing;

  elsif new.type = 'TOURNIQUET_REASSESSMENT' and new.patient_id is not null then
    v_context := coalesce(new.payload_json->>'clinical_context', new.payload_json->>'tourniquet_context', 'unknown');
    v_interval := coalesce(nullif(new.payload_json->>'next_reassessment_interval_minutes','')::integer, nullif(new.payload_json->>'reassessment_interval_minutes','')::integer, 60);
    v_interval := least(greatest(v_interval, 10), 120);

    update tourniquets
    set last_reassessed_event_id = new.id,
        last_reassessment_event_id = new.id,
        last_reassessed_at = new.local_timestamp,
        reassessment_due_at = new.local_timestamp + make_interval(mins => v_interval),
        next_reassessment_due_at = new.local_timestamp + make_interval(mins => v_interval),
        reassessment_interval_minutes = v_interval,
        clinical_context = case when v_context = 'unknown' then clinical_context else v_context end,
        tourniquet_status = coalesce(new.payload_json->>'tourniquet_status', 'reassessed'),
        updated_at = now()
    where patient_id = new.patient_id
      and limb = coalesce(new.payload_json->>'limb', limb)
      and is_active = true;

  elsif new.type = 'TOURNIQUET_CONTEXT_UPDATED' and new.patient_id is not null then
    v_context := coalesce(new.payload_json->>'clinical_context','unknown');
    v_interval := coalesce(nullif(new.payload_json->>'reassessment_interval_minutes','')::integer, 60);
    v_interval := least(greatest(v_interval, 10), 120);

    update tourniquets
    set clinical_context = v_context,
        reassessment_interval_minutes = v_interval,
        reassessment_due_at = new.local_timestamp + make_interval(mins => v_interval),
        next_reassessment_due_at = new.local_timestamp + make_interval(mins => v_interval),
        updated_at = now()
    where patient_id = new.patient_id
      and limb = coalesce(new.payload_json->>'limb', limb)
      and is_active = true;

  elsif new.type = 'TOURNIQUET_RELEASED' and new.patient_id is not null then
    update tourniquets
    set is_active = false,
        released_event_id = new.id,
        released_by_event_id = new.id,
        released_at = new.local_timestamp,
        tourniquet_status = 'released',
        updated_at = now()
    where patient_id = new.patient_id
      and limb = coalesce(new.payload_json->>'limb', limb)
      and is_active = true;
  end if;

  perform silence_resolved_watchdogs_for_event(new.id);
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_project_tourniquet_events on events;
create trigger trg_project_tourniquet_events
after insert on events
for each row execute function project_tourniquet_events();

-- =========================================================
-- v1.1 PLATOON STOCK LOGISTICS
-- =========================================================

create or replace view vw_platoon_stock as
select
  incident_id,
  owner_id as platoon_commander_id,
  owner_label,
  item_id,
  sku,
  item_name,
  category,
  unit,
  is_life_saving,
  current_quantity,
  first_ledger_at,
  last_ledger_at
from vw_current_inventory
where owner_type = 'platoon_stock';

create or replace view vw_inventory_transfer_audit as
select
  transfer_group_id,
  incident_id,
  min(server_timestamp) as transfer_started_at,
  max(server_timestamp) as transfer_completed_at,
  transfer_kind,
  item_id,
  sum(case when quantity_change < 0 then abs(quantity_change) else 0 end) as quantity_out,
  sum(case when quantity_change > 0 then quantity_change else 0 end) as quantity_in,
  jsonb_agg(
    jsonb_build_object(
      'ledger_id', id,
      'owner_type', owner_type,
      'owner_id', owner_id,
      'owner_label', owner_label,
      'quantity_change', quantity_change,
      'reason', reason,
      'location_at_time', location_at_time,
      'authorized_by', authorized_by,
      'direct_override_reason', direct_override_reason,
      'server_timestamp', server_timestamp
    ) order by server_timestamp
  ) as ledger_rows
from inventory_ledger
where transfer_group_id is not null
group by transfer_group_id, incident_id, transfer_kind, item_id;


-- Auto-fill inventory location_at_time from the related patient's current projection when not supplied.
create or replace function autofill_inventory_location_at_time()
returns trigger as $$
begin
  if (new.location_at_time is null or new.location_at_time = '{}'::jsonb) and new.related_patient_id is not null then
    select coalesce(location_json, '{}'::jsonb)
    into new.location_at_time
    from patients
    where id = new.related_patient_id;
  end if;

  new.location_at_time := coalesce(new.location_at_time, '{}'::jsonb);
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_autofill_inventory_location_at_time on inventory_ledger;
create trigger trg_autofill_inventory_location_at_time
before insert on inventory_ledger
for each row execute function autofill_inventory_location_at_time();

create or replace function validate_inventory_transfer_rules()
returns trigger as $$
begin
  -- Medic consumption during treatment must be from medic bag.
  if new.transfer_kind = 'TREATMENT_CONSUMPTION' and new.owner_type <> 'medic_bag' then
    raise exception 'Treatment consumption must deduct from medic_bag inventory.';
  end if;

  -- Platoon stock manual initial fill is PC-owned.
  if new.transfer_kind = 'INITIAL_FILL' and new.owner_type = 'platoon_stock' then
    if new.authorized_by is null then
      raise exception 'Platoon Stock initial fill requires authorized_by PC.';
    end if;
  end if;

  -- Direct Log-O to Medic refill requires override reason.
  if new.transfer_kind = 'DIRECT_LOGO_TO_MEDIC'
     and (new.direct_override_reason is null or length(trim(new.direct_override_reason)) < 10) then
    raise exception 'Direct Log-O to Medic refill requires override reason of at least 10 characters.';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_validate_inventory_transfer_rules on inventory_ledger;
create trigger trg_validate_inventory_transfer_rules
before insert on inventory_ledger
for each row execute function validate_inventory_transfer_rules();


-- =========================================================
-- INVENTORY STOCK MISMATCH ALERTS
-- Never block clinical documentation due to inventory state.
-- If a treatment consumes stock that drives inventory below zero,
-- preserve the ledger row and flag command/PC review.
-- =========================================================

create or replace function flag_negative_inventory_after_insert()
returns trigger as $$
declare
  current_qty integer;
begin
  if new.incident_id is null or new.quantity_change >= 0 then
    return new;
  end if;

  select coalesce(sum(quantity_change), 0)
  into current_qty
  from inventory_ledger
  where incident_id = new.incident_id
    and item_id = new.item_id
    and owner_type = new.owner_type
    and coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(new.owner_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and coalesce(owner_label, '') = coalesce(new.owner_label, '');

  if current_qty < 0 then
    insert into watchdog_alerts (incident_id, patient_id, actor_id, alert_type, severity, message, payload_json)
    values (
      new.incident_id,
      new.related_patient_id,
      new.owner_id,
      'INVENTORY_NEGATIVE_STOCK_USED',
      'warning',
      'Inventory went negative after a treatment or transfer. Preserve clinical record and review stock model.',
      jsonb_build_object(
        'inventory_ledger_id', new.id,
        'item_id', new.item_id,
        'owner_id', new.owner_id,
        'owner_type', new.owner_type,
        'owner_label', new.owner_label,
        'current_quantity', current_qty,
        'quantity_change', new.quantity_change,
        'location_at_time', new.location_at_time
      )
    );
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_flag_negative_inventory_after_insert on inventory_ledger;
create trigger trg_flag_negative_inventory_after_insert
after insert on inventory_ledger
for each row execute function flag_negative_inventory_after_insert();



-- =========================================================
-- v1.1 DRAFT INCIDENT APPROVAL QUEUE
-- =========================================================

create or replace view vw_draft_incident_approval_queue as
select
  i.id as incident_id,
  i.visual_id,
  i.location_name,
  i.address,
  i.draft_created_by,
  creator.display_name as draft_created_by_name,
  i.created_at,
  i.draft_acknowledged_at,
  count(p.id) as attached_patients,
  count(p.id) filter (where p.current_triage = 'red') as red_patients,
  count(p.id) filter (where p.needs_full_assessment = true) as patients_missing_full_assessment,
  (i.status = 'draft' and i.draft_resolved_at is null) as requires_approval,
  case
    when i.draft_acknowledged_at is null then true
    else false
  end as should_blink
from incidents i
left join profiles creator on creator.id = i.draft_created_by
left join patients p on p.incident_id = i.id
where i.status = 'draft' and i.draft_resolved_at is null
group by i.id, creator.display_name;

create or replace function mark_patient_pending_when_incident_is_draft()
returns trigger as $$
begin
  if exists (select 1 from incidents i where i.id = new.incident_id and i.status = 'draft') then
    new.pending_incident_approval := true;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_mark_patient_pending_when_incident_is_draft on patients;
create trigger trg_mark_patient_pending_when_incident_is_draft
before insert on patients
for each row execute function mark_patient_pending_when_incident_is_draft();

create or replace function clear_patient_pending_on_incident_confirmation()
returns trigger as $$
begin
  if old.status = 'draft' and new.status <> 'draft' then
    update patients
    set pending_incident_approval = false,
        updated_at = now(),
        version = version + 1
    where incident_id = new.id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_clear_patient_pending_on_incident_confirmation on incidents;
create trigger trg_clear_patient_pending_on_incident_confirmation
after update on incidents
for each row execute function clear_patient_pending_on_incident_confirmation();

create or replace function draft_incident_approval_outbox()
returns trigger as $$
begin
  if new.type in ('INCIDENT_DRAFT_CREATED','INCIDENT_CONFIRMED','INCIDENT_DRAFT_MERGED','INCIDENT_DRAFT_REJECTED') then
    insert into realtime_outbox (event_id, incident_id, patient_id, event_type, channel, payload_json)
    values (new.id, new.incident_id, new.patient_id, new.type, 'draft_incident_approval', new.payload_json);
  end if;

  if new.type in ('PATIENT_CREATED','QUICK_PATIENT_CREATED')
     and exists (select 1 from incidents i where i.id = new.incident_id and i.status = 'draft') then
    insert into realtime_outbox (event_id, incident_id, patient_id, event_type, channel, payload_json)
    values (new.id, new.incident_id, new.patient_id, new.type, 'draft_incident_approval', jsonb_build_object('message','Patient created under draft incident','patient_id',new.patient_id,'payload',new.payload_json));
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_draft_incident_approval_outbox on events;
create trigger trg_draft_incident_approval_outbox
after insert on events
for each row execute function draft_incident_approval_outbox();

-- =========================================================
-- v1.1 STEPPER VITALS SUPPORT
-- Payload format:
-- {
--   "heart_rate": {"raw_count": 31, "window_seconds": 15, "calculated_bpm": 124, "entry_method": "stepper"},
--   "respiratory_rate": {"raw_count": 16, "window_seconds": 30, "calculated_per_min": 32, "entry_method": "stepper"}
-- entry_method may be "stepper" or "clinical_override" for explicit no-breathing decisions.
-- }
-- =========================================================

create index if not exists idx_events_vitals_hr_entry_method
on events ((payload_json #>> '{heart_rate,entry_method}'))
where type = 'VITALS_RECORDED'
  and payload_json #>> '{heart_rate,entry_method}' is not null;

create index if not exists idx_events_vitals_rr_entry_method
on events ((payload_json #>> '{respiratory_rate,entry_method}'))
where type = 'VITALS_RECORDED'
  and payload_json #>> '{respiratory_rate,entry_method}' is not null;

-- =========================================================
-- v1.1 KPI HELPER VIEWS
-- =========================================================

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
  coalesce(pc.active_red_patients, 0)::numeric / nullif(coalesce(mc.active_medics, 0), 0) as red_patients_per_active_medic
from incidents i
left join patient_counts pc on pc.incident_id = i.id
left join alert_counts ac on ac.incident_id = i.id
left join medic_counts mc on mc.incident_id = i.id;

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

create or replace view vw_kpi_sync_latency as
select
  incident_id,
  type as event_type,
  count(*) as event_count,
  avg(extract(epoch from (server_timestamp - local_timestamp))) as avg_latency_seconds,
  percentile_cont(0.95) within group (order by extract(epoch from (server_timestamp - local_timestamp))) as p95_latency_seconds,
  count(*) filter (where synced_at is null) as unsynced_or_unconfirmed_events
from events
group by incident_id, type;

create or replace view vw_kpi_time_to_first_vitals as
with patient_created as (
  select patient_id, min(local_timestamp) as patient_created_at
  from events
  where type in ('PATIENT_CREATED','QUICK_PATIENT_CREATED')
  group by patient_id
), first_vitals as (
  select patient_id, min(local_timestamp) as first_vitals_at
  from events
  where type = 'VITALS_RECORDED'
  group by patient_id
)
select
  p.incident_id,
  p.id as patient_id,
  p.visual_id,
  pc.patient_created_at,
  fv.first_vitals_at,
  extract(epoch from (fv.first_vitals_at - pc.patient_created_at)) as seconds_to_first_vitals
from patients p
left join patient_created pc on pc.patient_id = p.id
left join first_vitals fv on fv.patient_id = p.id;

create or replace view vw_kpi_inventory_stockout_risk as
select
  ci.incident_id,
  ci.owner_id,
  ci.owner_type,
  ci.owner_label,
  ci.item_id,
  ci.sku,
  ci.item_name,
  ci.current_quantity,
  coalesce(abs(sum(il.quantity_change) filter (where il.quantity_change < 0 and il.server_timestamp >= now() - interval '30 minutes')),0) as consumed_last_30m,
  case
    when coalesce(abs(sum(il.quantity_change) filter (where il.quantity_change < 0 and il.server_timestamp >= now() - interval '30 minutes')),0) = 0 then null
    else ci.current_quantity / (abs(sum(il.quantity_change) filter (where il.quantity_change < 0 and il.server_timestamp >= now() - interval '30 minutes')) / 30.0)
  end as estimated_minutes_to_empty
from vw_current_inventory ci
left join inventory_ledger il on il.incident_id = ci.incident_id and il.owner_id = ci.owner_id and il.item_id = ci.item_id
group by ci.incident_id, ci.owner_id, ci.owner_type, ci.owner_label, ci.item_id, ci.sku, ci.item_name, ci.current_quantity;


-- =========================================================
-- PRECOMPUTED COMMAND STATE
-- Dashboard reads should use service-role backed current-state rows rather
-- than repeatedly scanning large event tables with RLS-heavy joins.
-- =========================================================

create table if not exists incident_command_state (
  incident_id uuid primary key references incidents(id) on delete cascade,
  active_red_patients integer not null default 0,
  patients_missing_full_vitals integer not null default 0,
  handed_over_patients integer not null default 0,
  total_patients integer not null default 0,
  active_watchdog_alerts integer not null default 0,
  dead_man_switch_active integer not null default 0,
  red_patients_per_active_medic numeric,
  last_refreshed_at timestamptz not null default now(),
  state_json jsonb not null default '{}'::jsonb
);

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
    to_jsonb(s)
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

create index if not exists idx_incident_command_state_refreshed
on incident_command_state(last_refreshed_at);

create or replace function refresh_command_state_after_event()
returns trigger as $$
begin
  if new.incident_id is not null then
    perform refresh_incident_command_state(new.incident_id);
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_refresh_command_state_after_event on events;
create trigger trg_refresh_command_state_after_event
after insert on events
for each row
when (new.type in (
  'QUICK_PATIENT_CREATED',
  'PATIENT_CREATED',
  'PATIENT_IDENTIFIED',
  'VITALS_RECORDED',
  'MINIMAL_TRIAGE_RECORDED',
  'PATIENT_TRIAGE_UPDATED',
  'PATIENT_STATUS_UPDATED',
  'PATIENT_HANDED_OVER',
  'PATIENT_TRIAGED_EXPECTANT',
  'TOURNIQUET_APPLIED',
  'AIRWAY_MANAGED',
  'MEDICATION_ADMINISTERED',
  'TOURNIQUET_REASSESSMENT',
  'TOURNIQUET_RELEASED',
  'WATCHDOG_ALERT',
  'WATCHDOG_RESOLVED',
  'DEAD_MAN_SWITCH_ESCALATED'
))
execute function refresh_command_state_after_event();

create or replace function trg_verify_pediatric_safety()
returns trigger as $$
declare
  v_override jsonb;
  v_confirmed boolean;
begin
  if new.type <> 'MEDICATION_ADMINISTERED' then
    return new;
  end if;

  v_override := coalesce(new.payload_json->'high_risk_override', '{}'::jsonb);
  v_confirmed := coalesce((v_override->>'confirmed_twice')::boolean, false);

  if coalesce((new.payload_json->>'is_pediatric_override')::boolean, false) = true
     and v_confirmed = false then
    insert into watchdog_alerts (
      incident_id,
      patient_id,
      actor_id,
      alert_type,
      severity,
      message,
      payload_json,
      dedupe_key
    )
    select
      new.incident_id,
      new.patient_id,
      new.actor_id,
      'HIGH_RISK_CLINICAL_VIOLATION',
      'critical',
      'Pediatric medication administered with high-risk dosage override missing double confirmation.',
      jsonb_build_object(
        'event_id', new.id,
        'medication', new.payload_json->>'medication',
        'dosage', new.payload_json->>'dosage',
        'route', new.payload_json->>'route',
        'high_risk_override', v_override
      ),
      'pediatric-medication-' || new.id::text
    where not exists (
      select 1
      from watchdog_alerts wa
      where wa.incident_id = new.incident_id
        and wa.alert_type = 'HIGH_RISK_CLINICAL_VIOLATION'
        and wa.dedupe_key = 'pediatric-medication-' || new.id::text
    );
  elsif coalesce((new.payload_json->>'is_pediatric_override')::boolean, false) = true then
    insert into watchdog_alerts (
      incident_id,
      patient_id,
      actor_id,
      alert_type,
      severity,
      message,
      payload_json,
      dedupe_key
    )
    select
      new.incident_id,
      new.patient_id,
      new.actor_id,
      'HIGH_RISK_PEDIATRIC_MEDICATION_OVERRIDE',
      'warning',
      'Pediatric medication administered with double-confirmed high-risk override.',
      jsonb_build_object(
        'event_id', new.id,
        'medication', new.payload_json->>'medication',
        'dosage', new.payload_json->>'dosage',
        'route', new.payload_json->>'route',
        'high_risk_override', v_override
      ),
      'pediatric-medication-reviewed-' || new.id::text
    where not exists (
      select 1
      from watchdog_alerts wa
      where wa.incident_id = new.incident_id
        and wa.alert_type = 'HIGH_RISK_PEDIATRIC_MEDICATION_OVERRIDE'
        and wa.dedupe_key = 'pediatric-medication-reviewed-' || new.id::text
    );
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists audit_verify_pediatric_safety on events;
create trigger audit_verify_pediatric_safety
after insert on events
for each row
execute function trg_verify_pediatric_safety();

create or replace view vw_command_spatial_heatmap as
with active_critical_alerts as (
  select incident_id, patient_id, true as has_critical_alert
  from watchdog_alerts
  where resolved_at is null
    and severity = 'critical'
  group by incident_id, patient_id
)
select
  p.incident_id,
  coalesce(p.location_json->>'building', 'unknown') as building_id,
  coalesce(p.location_json->>'floor', 'unknown') as floor_id,
  count(p.id) as total_patients_on_site,
  count(p.id) filter (where p.current_triage = 'red') as count_red_triage,
  count(p.id) filter (where p.current_triage = 'yellow') as count_yellow_triage,
  count(p.id) filter (where p.current_triage = 'green') as count_green_triage,
  count(p.id) filter (where p.current_triage = 'black') as count_deceased,
  case
    when bool_or(coalesce(aca.has_critical_alert, false)) then 'high_danger'
    when count(p.id) filter (where p.current_triage in ('red','yellow')) > 0 then 'active'
    else 'stable'
  end as structural_alert_state
from patients p
left join active_critical_alerts aca
  on aca.incident_id = p.incident_id
 and aca.patient_id = p.id
where p.current_status not in ('handed_over', 'closed', 'self_evacuated', 'deceased')
group by p.incident_id, coalesce(p.location_json->>'building', 'unknown'), coalesce(p.location_json->>'floor', 'unknown');

create or replace view vw_command_incident_throughput_funnel as
with patient_lifecycle_milestones as (
  select
    patient_id,
    incident_id,
    min(local_timestamp) filter (where type in ('QUICK_PATIENT_CREATED','PATIENT_CREATED','PATIENT_IDENTIFIED')) as t_identified,
    min(local_timestamp) filter (where type = 'VITALS_RECORDED') as t_first_vitals,
    min(local_timestamp) filter (where type = 'TOURNIQUET_APPLIED') as t_first_intervention,
    min(local_timestamp) filter (where type = 'PATIENT_HANDED_OVER') as t_evacuated
  from events
  where patient_id is not null
    and type in ('QUICK_PATIENT_CREATED','PATIENT_CREATED','PATIENT_IDENTIFIED','VITALS_RECORDED','TOURNIQUET_APPLIED','PATIENT_HANDED_OVER')
  group by patient_id, incident_id
)
select
  p.incident_id,
  p.id as patient_id,
  p.visual_id,
  p.current_triage,
  p.current_status,
  p.needs_full_assessment as is_quick_patient_only,
  plm.t_identified,
  plm.t_first_vitals,
  plm.t_first_intervention,
  plm.t_evacuated,
  extract(epoch from (plm.t_first_vitals - plm.t_identified)) as seconds_to_first_vitals,
  extract(epoch from (plm.t_evacuated - plm.t_identified)) as total_evacuation_time_seconds,
  case when plm.t_first_vitals is not null then 1 else 0 end as milestone_assessed,
  case when plm.t_evacuated is not null then 1 else 0 end as milestone_evacuated,
  case
    when p.current_triage = 'red'
      and plm.t_first_vitals is null
      and plm.t_identified is not null
      and (now() - plm.t_identified) > interval '10 minutes'
    then true
    else false
  end as is_triage_breach_overdue
from patients p
left join patient_lifecycle_milestones plm
  on p.id = plm.patient_id
 and p.incident_id = plm.incident_id;


-- AAR generated reports
create table if not exists aar_context_notes (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  source_event_id uuid references events(id) on delete set null,
  patient_id uuid references patients(id) on delete set null,
  sector_id uuid references sectors(id) on delete set null,
  actor_id uuid references profiles(id),
  note_type text not null check (note_type in ('text','voice_memo','decision_rationale','sector_context')),
  note_text text,
  voice_memo_uri text,
  voice_memo_duration_seconds integer,
  created_at timestamptz not null default now()
);

create index if not exists idx_aar_context_notes_incident_time
on aar_context_notes(incident_id, created_at);

create or replace view vw_aar_live_timeline as
select
  e.incident_id,
  e.local_timestamp as timeline_at,
  'event' as item_type,
  e.type::text as item_subtype,
  e.id as source_event_id,
  e.patient_id,
  null::uuid as sector_id,
  e.actor_id,
  e.payload_json as payload_json,
  null::text as note_text,
  null::text as voice_memo_uri
from events e
union all
select
  n.incident_id,
  n.created_at as timeline_at,
  'context_note' as item_type,
  n.note_type as item_subtype,
  n.source_event_id,
  n.patient_id,
  n.sector_id,
  n.actor_id,
  '{}'::jsonb as payload_json,
  n.note_text,
  n.voice_memo_uri
from aar_context_notes n;

create table if not exists aar_reports (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  generated_by uuid references profiles(id),
  generated_at timestamptz not null default now(),
  report_json jsonb not null default '{}'::jsonb,
  locked boolean not null default true
);

-- Local PostgreSQL compatibility for Supabase roles.
do $$
begin
  create role authenticated;
exception when duplicate_object then null;
end $$;

-- Local PostgreSQL compatibility for Supabase auth.uid().
-- In Supabase this function already exists and this block does nothing.
create schema if not exists auth;
do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname = 'uid'
  ) then
    execute 'create function auth.uid() returns uuid language sql stable as ''select null::uuid''';
  end if;
end $$;


-- =========================================================
-- v1.1 SUPABASE ROW LEVEL SECURITY BASELINE
-- These policies are a direct-access security baseline. Service-role/backend jobs bypass RLS and must be used for dashboard aggregations/precomputed command state to avoid RLS-heavy joins during an MCI.
-- =========================================================

create schema if not exists app;

create or replace function app.current_user_role()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select role from profiles where id = auth.uid()
$$;

create or replace function app.is_command_role()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(app.current_user_role() in ('pc','cc','chamal','admin'), false)
$$;


create or replace function app.can_access_incident(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    app.current_user_role() in ('cc','chamal','admin')
    or exists (
      select 1
      from incident_memberships im
      where im.incident_id = p_incident_id
        and im.profile_id = auth.uid()
    ),
    false
  )
$$;

create or replace function app.can_write_incident_event(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    app.current_user_role() in ('pc','cc','chamal','admin')
    or exists (
      select 1
      from incident_memberships im
      where im.incident_id = p_incident_id
        and im.profile_id = auth.uid()
        and im.role_at_incident in ('medic','pc')
    ),
    false
  )
$$;

create or replace function app.can_write_clinical_event(role_in user_role)
returns boolean
language sql
immutable
as $$
  select role_in in ('medic','pc')
$$;

alter table profiles enable row level security;
alter table incidents enable row level security;
alter table incident_memberships enable row level security;
alter table sectors enable row level security;
alter table patients enable row level security;
alter table events enable row level security;
alter table supply_requests enable row level security;
alter table inventory_ledger enable row level security;
alter table watchdog_alerts enable row level security;
alter table conflict_log enable row level security;
alter table aar_reports enable row level security;
alter table aar_context_notes enable row level security;
alter table sync_ingestion_errors enable row level security;
alter table incident_command_state enable row level security;

drop policy if exists profiles_read_authenticated on profiles;
create policy profiles_read_authenticated on profiles for select to authenticated using (id = auth.uid() or app.current_user_role() in ('pc','cc','chamal','admin'));



drop policy if exists incident_memberships_read_scoped on incident_memberships;
create policy incident_memberships_read_scoped on incident_memberships for select to authenticated using (profile_id = auth.uid() or app.current_user_role() in ('pc','cc','chamal','admin'));

drop policy if exists incident_memberships_write_command on incident_memberships;
create policy incident_memberships_write_command on incident_memberships for all to authenticated using (app.current_user_role() in ('pc','cc','chamal','admin')) with check (app.current_user_role() in ('pc','cc','chamal','admin'));

drop policy if exists incidents_read_authenticated on incidents;
create policy incidents_read_authenticated on incidents for select to authenticated using (app.can_access_incident(id));

drop policy if exists incidents_command_write on incidents;
create policy incidents_command_write on incidents for all to authenticated using (app.current_user_role() in ('pc','cc','chamal','admin')) with check (app.current_user_role() in ('pc','cc','chamal','admin') or (status = 'draft' and draft_created_by = auth.uid() and app.current_user_role() = 'medic'));

drop policy if exists sectors_read_authenticated on sectors;
create policy sectors_read_authenticated on sectors for select to authenticated using (app.can_access_incident(incident_id));

drop policy if exists sectors_command_write on sectors;
create policy sectors_command_write on sectors for all to authenticated using (app.can_access_incident(incident_id) and app.current_user_role() in ('medic','pc','cc','chamal','admin')) with check (app.can_access_incident(incident_id) and app.current_user_role() in ('medic','pc','cc','chamal','admin'));

drop policy if exists patients_read_authenticated on patients;
create policy patients_read_authenticated on patients for select to authenticated using (app.can_access_incident(incident_id));

drop policy if exists patients_medic_pc_insert on patients;
create policy patients_medic_pc_insert on patients for insert to authenticated with check (app.can_access_incident(incident_id) and app.current_user_role() in ('medic','pc'));

drop policy if exists patients_medic_pc_update_projection on patients;
drop policy if exists patients_projection_update_scoped on patients;
create policy patients_projection_update_scoped on patients for update to authenticated using (app.can_access_incident(incident_id) and app.current_user_role() in ('medic','pc','cc','chamal','admin')) with check (app.can_access_incident(incident_id) and app.current_user_role() in ('medic','pc','cc','chamal','admin'));

drop policy if exists events_read_authenticated on events;
create policy events_read_authenticated on events for select to authenticated using (app.can_access_incident(incident_id));

drop policy if exists events_insert_by_role on events;
create policy events_insert_by_role on events for insert to authenticated with check (
  actor_id = auth.uid()
  and app.can_access_incident(incident_id)
  and (
    app.can_write_clinical_event(actor_role)
    or actor_role in ('logistics_officer','cc','chamal','admin')
  )
);

drop policy if exists supply_requests_read_authenticated on supply_requests;
create policy supply_requests_read_authenticated on supply_requests for select to authenticated using (app.can_access_incident(incident_id));

drop policy if exists supply_requests_write_ops on supply_requests;
create policy supply_requests_write_ops on supply_requests for all to authenticated using (app.can_access_incident(incident_id) and app.current_user_role() in ('medic','pc','logistics_officer','admin')) with check (app.can_access_incident(incident_id) and app.current_user_role() in ('medic','pc','logistics_officer','admin'));

drop policy if exists inventory_read_authenticated on inventory_ledger;
create policy inventory_read_authenticated on inventory_ledger for select to authenticated using (incident_id is null or app.can_access_incident(incident_id));

drop policy if exists inventory_write_ops on inventory_ledger;
create policy inventory_write_ops on inventory_ledger for insert to authenticated with check ((incident_id is null or app.can_access_incident(incident_id)) and app.current_user_role() in ('medic','pc','logistics_officer','admin'));

drop policy if exists watchdog_read_authenticated on watchdog_alerts;
create policy watchdog_read_authenticated on watchdog_alerts for select to authenticated using (app.can_access_incident(incident_id));

drop policy if exists watchdog_command_update on watchdog_alerts;
create policy watchdog_command_update on watchdog_alerts for update to authenticated using (app.can_access_incident(incident_id) and app.current_user_role() in ('pc','cc','chamal','admin')) with check (app.can_access_incident(incident_id) and app.current_user_role() in ('pc','cc','chamal','admin'));

drop policy if exists conflict_read_command on conflict_log;
create policy conflict_read_command on conflict_log for select to authenticated using (app.is_command_role() and app.can_access_incident(incident_id));

drop policy if exists aar_read_command on aar_reports;
create policy aar_read_command on aar_reports for select to authenticated using (app.is_command_role() and app.can_access_incident(incident_id));

drop policy if exists aar_write_command on aar_reports;
create policy aar_write_command on aar_reports for all to authenticated using (app.is_command_role() and app.can_access_incident(incident_id)) with check (app.is_command_role() and app.can_access_incident(incident_id));


drop policy if exists aar_context_notes_read_command on aar_context_notes;
create policy aar_context_notes_read_command on aar_context_notes for select to authenticated using (app.is_command_role() and app.can_access_incident(incident_id));

drop policy if exists aar_context_notes_write_command on aar_context_notes;
create policy aar_context_notes_write_command on aar_context_notes for insert to authenticated with check (app.is_command_role() and app.can_access_incident(incident_id));

drop policy if exists sync_ingestion_errors_read_command on sync_ingestion_errors;
create policy sync_ingestion_errors_read_command on sync_ingestion_errors for select to authenticated using (app.is_command_role()); -- ingestion errors may be incident_id-null poison envelopes; command-only





-- =========================================================
-- v1.1 DEAD MAN'S SWITCH ESCALATION
-- First-class watchdog creation for silent medics.
-- Intended to run from a scheduled backend/Supabase cron job.
-- =========================================================

create or replace function generate_dead_man_switch_alerts(threshold interval default interval '5 minutes')
returns integer as $$
declare
  inserted_count integer;
begin
  insert into watchdog_alerts (incident_id, actor_id, alert_type, severity, message, payload_json)
  select
    dp.incident_id,
    dp.actor_id,
    'DEAD_MAN_SWITCH',
    'critical',
    'Medic device silent for more than configured threshold. Escalate to Platoon Commander.',
    jsonb_build_object(
      'device_id', dp.device_id,
      'last_heartbeat_at', dp.last_heartbeat_at,
      'threshold', threshold::text,
      'escalate_to_role', 'pc'
    )
  from device_presence dp
  join profiles pr on pr.id = dp.actor_id
  where pr.role = 'medic'
    and dp.incident_id is not null
    and dp.last_heartbeat_at < now() - threshold
    and not exists (
      select 1 from watchdog_alerts wa
      where wa.incident_id = dp.incident_id
        and wa.actor_id = dp.actor_id
        and wa.alert_type = 'DEAD_MAN_SWITCH'
        and wa.resolved_at is null
    );

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$ language plpgsql;


-- Active tourniquets requiring reassessment.
create or replace view vw_active_tourniquet_reassessment_due as
select
  t.*,
  p.visual_id,
  p.current_triage,
  p.location_json
from tourniquets t
join patients p on p.id = t.patient_id
where t.is_active = true
  and coalesce(t.next_reassessment_due_at, t.reassessment_due_at) <= now();

create or replace function generate_tourniquet_reassessment_alerts(p_incident_id uuid)
returns integer as $$
declare
  inserted_count integer;
begin
  insert into watchdog_alerts (incident_id, patient_id, alert_type, severity, message, payload_json, dedupe_key)
  select
    t.incident_id,
    t.patient_id,
    'TOURNIQUET_REASSESSMENT_OVERDUE',
    'critical',
    'Active tourniquet requires reassessment based on clinical context.',
    jsonb_build_object(
      'tourniquet_id', t.id,
      'limb', t.limb,
      'clinical_context', t.clinical_context,
      'applied_at', t.applied_at,
      'next_reassessment_due_at', coalesce(t.next_reassessment_due_at, t.reassessment_due_at),
      'reassessment_interval_minutes', t.reassessment_interval_minutes
    ),
    'tourniquet-reassessment:' || t.id::text
  from tourniquets t
  where t.incident_id = p_incident_id
    and t.is_active = true
    and coalesce(t.next_reassessment_due_at, t.reassessment_due_at) <= now()
    and not exists (
      select 1 from watchdog_alerts wa
      where wa.incident_id = t.incident_id
        and wa.patient_id = t.patient_id
        and wa.alert_type = 'TOURNIQUET_REASSESSMENT_OVERDUE'
        and wa.resolved_at is null
        and wa.dedupe_key = 'tourniquet-reassessment:' || t.id::text
    );

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$$ language plpgsql;


-- =========================================================
-- v1.1 DEPENDENCY-AWARE SYNC INGESTION
-- Per-event processing is not blind partial success. Children depend on parents.
-- If a parent is rejected/quarantined, dependent events are quarantined as BLOCKED_DEPENDENCY
-- instead of creating orphaned clinical records.
-- =========================================================

create table if not exists sync_event_dependencies (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid,
  device_id text not null,
  local_event_id text not null,
  depends_on_device_id text not null,
  depends_on_local_event_id text not null,
  dependency_type text not null default 'requires_parent' check (dependency_type in ('requires_parent','supersedes','reassesses')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (device_id, local_event_id, depends_on_device_id, depends_on_local_event_id)
);

create index if not exists idx_sync_event_dependencies_child
on sync_event_dependencies(device_id, local_event_id);

create index if not exists idx_sync_event_dependencies_parent
on sync_event_dependencies(depends_on_device_id, depends_on_local_event_id);

alter table sync_ingestion_errors
  add column if not exists dependency_status text not null default 'none' check (dependency_status in ('none','blocked_dependency','parent_rejected','resolved')),
  add column if not exists parent_device_id text,
  add column if not exists parent_local_event_id text,
  add column if not exists retry_allowed boolean not null default false,
  add column if not exists reconciled_event_id uuid references events(id),
  add column if not exists reviewed_by uuid references profiles(id),
  add column if not exists reviewed_at timestamptz;

create index if not exists idx_sync_ingestion_errors_dependency
on sync_ingestion_errors(parent_device_id, parent_local_event_id)
where dependency_status in ('blocked_dependency','parent_rejected');


-- =========================================================
-- v1.1 DATA FRESHNESS + BATTERY-AWARE SYNC STATE
-- Mobile UI is local-first, so the user must know when local data is stale.
-- =========================================================

create table if not exists device_sync_state (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid references incidents(id) on delete cascade,
  actor_id uuid references profiles(id),
  device_id text not null,
  last_successful_push_at timestamptz,
  last_successful_pull_at timestamptz,
  last_pull_cursor bigint,
  unsynced_event_count integer not null default 0,
  battery_percent integer check (battery_percent between 0 and 100),
  power_mode text not null default 'normal' check (power_mode in ('normal','low_power','critical_only')),
  gps_enabled boolean not null default true,
  logistics_location_tracking_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  unique (incident_id, device_id)
);

create index if not exists idx_device_sync_state_staleness
on device_sync_state(incident_id, last_successful_pull_at);


-- =========================================================
-- v1.1 DYNAMIC TOURNIQUET CONTEXT
-- Tourniquet reassessment is driven by clinical context, not a universal office timer.
-- =========================================================

alter table tourniquets
  add column if not exists clinical_context text not null default 'unknown' check (clinical_context in ('arterial_bleed','amputation','crush_entrapment','venous_bleed','uncertain','unknown')),
  add column if not exists reassessment_interval_minutes integer not null default 60 check (reassessment_interval_minutes between 10 and 120),
  add column if not exists next_reassessment_due_at timestamptz,
  add column if not exists last_reassessment_event_id uuid references events(id),
  add column if not exists released_by_event_id uuid references events(id);

create index if not exists idx_tourniquets_next_reassessment
on tourniquets(next_reassessment_due_at)
where is_active = true;


-- =========================================================
-- v1.1 IDEMPOTENT, TIME-AWARE WATCHDOGS
-- Watchdogs process event-log projections chronologically. If an event in the same sync batch resolves
-- a pending risk, the alert is silenced before being emitted to the dashboard.
-- =========================================================

alter table watchdog_alerts
  add column if not exists dedupe_key text,
  add column if not exists source_event_id uuid references events(id),
  add column if not exists resolved_by_event_id uuid references events(id),
  add column if not exists suppressed_before_dashboard boolean not null default false;

create unique index if not exists uq_watchdog_active_dedupe
on watchdog_alerts(incident_id, alert_type, coalesce(patient_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(actor_id, '00000000-0000-0000-0000-000000000000'::uuid), dedupe_key)
where resolved_at is null and dedupe_key is not null;

create or replace function silence_resolved_watchdogs_for_event(p_event_id uuid)
returns void as $$
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
        'MISSING_FULL_ASSESSMENT'
      );
  end if;
end;
$$ language plpgsql;


-- v1.1 command snapshot access model:
-- Command dashboards should read this flat table only through backend/service-role APIs.
-- Direct client access is revoked; API-level permission check protects it.
alter table incident_command_state disable row level security;
revoke all on incident_command_state from anon, authenticated;


-- =========================================================
-- v1.1 HIGH-RISK OVERRIDE CONFIRMATIONS
-- UI must intervene before save where possible. Server still preserves received data,
-- but records whether the operator performed an emergency double-confirm.
-- =========================================================

create table if not exists high_risk_override_confirmations (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid references incidents(id) on delete cascade,
  patient_id uuid references patients(id) on delete cascade,
  event_id uuid references events(id) on delete cascade,
  actor_id uuid references profiles(id),
  override_type text not null,
  reason text not null,
  confirmed_twice boolean not null default false,
  confirmed_at timestamptz not null default now()
);

create index if not exists idx_high_risk_override_event
on high_risk_override_confirmations(event_id);
