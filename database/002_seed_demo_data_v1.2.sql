-- C5 Sentinel-SAR Demo Seed Data v1.2

insert into profiles (id, display_name, role, unit_name, device_id, last_seen_at)
values
  ('00000000-0000-0000-0000-000000000001', 'Medic Cohen', 'medic', 'SAR Medical Company', 'device-cohen', now()),
  ('00000000-0000-0000-0000-000000000002', 'Medic Levi', 'medic', 'SAR Medical Company', 'device-levi', now() - interval '6 minutes'),
  ('00000000-0000-0000-0000-000000000003', 'PC Demo', 'pc', 'SAR Medical Company', 'device-pc', now()),
  ('00000000-0000-0000-0000-000000000004', 'Log-O Demo', 'logistics_officer', 'Logistics', 'device-logo', now()),
  ('00000000-0000-0000-0000-000000000005', 'CC Demo', 'cc', 'Command', 'device-cc', now()),
  ('00000000-0000-0000-0000-000000000006', 'Chamal Demo', 'chamal', 'Medical Command', 'device-chamal', now())
on conflict (id) do nothing;

insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, address, incident_type, status, opened_by)
values (
  '10000000-0000-0000-0000-000000000001',
  'INC-001',
  now() - interval '35 minutes',
  now() - interval '35 minutes',
  'Tel Aviv',
  'Tel Aviv Demo Site',
  'missile_strike_structural_collapse',
  'active',
  '00000000-0000-0000-0000-000000000005'
)
on conflict (id) do nothing;

insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
values
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','medic','00000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','medic','00000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000003','pc','00000000-0000-0000-0000-000000000005'),
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000004','logistics_officer','00000000-0000-0000-0000-000000000005'),
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000005','cc','00000000-0000-0000-0000-000000000005'),
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000006','chamal','00000000-0000-0000-0000-000000000005')
on conflict (incident_id, profile_id) do nothing;

insert into sectors (id, incident_id, building_no, floor, apartment, room, sector_label, building_status)
values
  ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','15A','3','7',null,'15A / Floor 3 / Apt 7','unstable'),
  ('20000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','15A','2',null,null,'15A / Floor 2','unstable'),
  ('20000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','15B','1',null,null,'15B / Floor 1','unknown')
on conflict (incident_id, building_no, floor, apartment, room) do nothing;

insert into patients (id, incident_id, sector_id, visual_id, t_injury, current_triage, algorithm_triage, access_status, current_status, is_pediatric, pediatric_age_years, needs_full_assessment, pulse_present, breathing_present, tourniquet_used, location_json, created_by)
values
  ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','P-001',now() - interval '35 minutes','red','red','trapped','treating',false,null,false,true,true,true,'{"building":"15A","floor":"3","apartment":"7"}','00000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','P-002',now() - interval '35 minutes','yellow','red','partial','observing',false,null,false,true,true,false,'{"building":"15A","floor":"2"}','00000000-0000-0000-0000-000000000001'),
  ('30000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003','P-003',now() - interval '35 minutes','green','green','free','observing',true,6,false,true,true,false,'{"building":"15B","floor":"1"}','00000000-0000-0000-0000-000000000001')
on conflict (incident_id, visual_id) do nothing;

insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp, synced_at)
values
  ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','medic','VITALS_RECORDED','{"hr":124,"rr":32,"bp":"Carotid","avpu":"Pain","spo2":91}','device-cohen','seed-p001-vitals-001',now() - interval '27 minutes',now()),
  ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','medic','TOURNIQUET_APPLIED','{"limb":"R-Leg","applied_at_minutes_ago":27}','device-cohen','seed-p001-tq-001',now() - interval '27 minutes',now()),
  ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','medic','VITALS_RECORDED','{"hr":96,"rr":22,"bp":"Radial","avpu":"Alert","spo2":97}','device-cohen','seed-p002-vitals-001',now() - interval '24 minutes',now()),
  ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','medic','MSTART_OVERRIDE','{"algorithm_value":"red","human_value":"yellow","reason":"Ambulatory, minor lacerations","description":"P-002 manual override from algorithmic RED to YELLOW"}','device-cohen','seed-p002-override-001',now() - interval '23 minutes',now()),
  ('10000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','medic','VITALS_RECORDED','{"hr":110,"rr":28,"bp":"Radial","avpu":"Alert","spo2":99}','device-cohen','seed-p003-vitals-001',now() - interval '20 minutes',now()),
  ('10000000-0000-0000-0000-000000000001',null,'00000000-0000-0000-0000-000000000002','medic','WATCHDOG_ALERT','{"alert_type":"DEAD_MAN_SWITCH","medic":"Medic Levi","last_seen_minutes_ago":6,"severity":"warning"}','device-system','seed-dms-levi-001',now(),now())
on conflict (device_id, local_event_id) do nothing;

insert into inventory_items (sku, name, category, unit, is_life_saving)
values
  ('TQ','Tourniquet','hemorrhage','unit',true),
  ('BANDAGE','First-aid Bandage','hemorrhage','unit',true),
  ('COMBAT_GAUZE','Combat Gauze','hemorrhage','unit',true),
  ('FLUID_500','IV Fluids 500ml','circulation','bag',true),
  ('MORPHINE','Morphine','medication','mg',true),
  ('ACTIQ','Actiq / Fentanyl','medication','unit',true),
  ('AIRWAY','Airway Adjunct','airway','unit',true),
  ('THERMAL_BLANKET','Thermal Blanket','exposure','unit',false)
on conflict (sku) do nothing;

insert into supply_requests (id, incident_id, requester_id, supervisor_id, request_level, status, delivery_location_json, notes)
values (
  '40000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000003',
  'medic_to_pc',
  'requested',
  '{"building":"15A","floor":"3"}',
  'Medic Cohen request: Combat Gauze x2, Tourniquet x2'
)
on conflict (id) do nothing;

insert into supply_request_items (supply_request_id, item_id, quantity)
select '40000000-0000-0000-0000-000000000001', id, 2 from inventory_items where sku in ('COMBAT_GAUZE','TQ')
on conflict (supply_request_id, item_id) do nothing;


-- v1.1 Treatment catalog seed
insert into inventory_items (sku, name, category, unit, is_life_saving)
values
  ('COMBAT_GAUZE', 'Combat Gauze', 'hemorrhage', 'unit', true)
on conflict (sku) do nothing;

insert into treatment_catalog (code, display_name, category, event_type, requires_limb, requires_application_time, is_medication, requires_pediatric_weight, warns_on_reduced_avpu)
values
  ('TOURNIQUET', 'Tourniquet', 'hemorrhage', 'TOURNIQUET_APPLIED', true, true, false, false, false),
  ('PRESSURE_BANDAGE', 'Pressure Bandage', 'hemorrhage', 'INTERVENTION_RECORDED', false, false, false, false, false),
  ('COMBAT_GAUZE', 'Combat Gauze', 'hemorrhage', 'INTERVENTION_RECORDED', false, false, false, false, false),
  ('AIRWAY_INTERVENTION', 'Airway Intervention', 'airway', 'INTERVENTION_RECORDED', false, false, false, false, true),
  ('IV_ACCESS', 'IV Access', 'circulation', 'INTERVENTION_RECORDED', false, false, false, false, false),
  ('IV_FLUIDS', 'IV Fluids', 'circulation', 'INTERVENTION_RECORDED', false, false, false, false, false),
  ('MORPHINE', 'Morphine', 'medication', 'MEDICATION_ADMINISTERED', false, false, true, true, true),
  ('ACTIQ', 'Actiq / Fentanyl', 'medication', 'MEDICATION_ADMINISTERED', false, false, true, true, true),
  ('CPR', 'CPR', 'cpr', 'INTERVENTION_RECORDED', false, false, false, false, false),
  ('OTHER', 'Other', 'other', 'INTERVENTION_RECORDED', false, false, false, false, false)
on conflict (code) do nothing;

insert into treatment_inventory_items (treatment_code, item_id, quantity_per_treatment)
select 'TOURNIQUET', id, 1 from inventory_items where sku = 'TQ'
on conflict (treatment_code, item_id) do nothing;

insert into treatment_inventory_items (treatment_code, item_id, quantity_per_treatment)
select 'PRESSURE_BANDAGE', id, 1 from inventory_items where sku = 'BANDAGE'
on conflict (treatment_code, item_id) do nothing;

insert into treatment_inventory_items (treatment_code, item_id, quantity_per_treatment)
select 'COMBAT_GAUZE', id, 1 from inventory_items where sku = 'COMBAT_GAUZE'
on conflict (treatment_code, item_id) do nothing;

insert into treatment_inventory_items (treatment_code, item_id, quantity_per_treatment)
select 'IV_FLUIDS', id, 1 from inventory_items where sku = 'FLUID_500'
on conflict (treatment_code, item_id) do nothing;

insert into treatment_inventory_items (treatment_code, item_id, quantity_per_treatment)
select 'MORPHINE', id, 5 from inventory_items where sku = 'MORPHINE'
on conflict (treatment_code, item_id) do nothing;

insert into treatment_inventory_items (treatment_code, item_id, quantity_per_treatment)
select 'ACTIQ', id, 1 from inventory_items where sku = 'ACTIQ'
on conflict (treatment_code, item_id) do nothing;

-- Demo treatment events: P-001 tourniquet is seeded once above as seed-p001-tq-001.


-- v1.1 Platoon Stock demo inventory
-- PC manually initializes Platoon Stock during staging / demo setup.
insert into inventory_ledger (
  incident_id,
  owner_id,
  owner_type,
  owner_label,
  item_id,
  quantity_change,
  location_at_time,
  reason,
  transfer_group_id,
  transfer_kind,
  authorized_by,
  device_id,
  local_ledger_id,
  local_timestamp,
  synced_at,
  notes
)
select
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000003',
  'platoon_stock',
  'Platoon Stock',
  ii.id,
  case
    when ii.sku = 'TQ' then 8
    when ii.sku = 'COMBAT_GAUZE' then 10
    when ii.sku = 'BANDAGE' then 12
    when ii.sku = 'FLUID_500' then 6
    when ii.sku = 'MORPHINE' then 40
    when ii.sku = 'ACTIQ' then 4
    else 0
  end,
  '{"building":"staging","floor":"ground","owner":"PC Demo"}'::jsonb,
  'INITIAL_STOCK',
  gen_random_uuid(),
  'INITIAL_FILL',
  '00000000-0000-0000-0000-000000000003',
  'device-pc',
  'seed-platoon-stock-' || ii.sku,
  now() - interval '40 minutes',
  now(),
  'Initial manual fill of Platoon Stock by PC'
from inventory_items ii
where ii.sku in ('TQ','COMBAT_GAUZE','BANDAGE','FLUID_500','MORPHINE','ACTIQ')
on conflict (device_id, local_ledger_id) do nothing;

-- Demo medic personal bag stock.
insert into inventory_ledger (
  incident_id,
  owner_id,
  owner_type,
  owner_label,
  item_id,
  quantity_change,
  location_at_time,
  reason,
  transfer_group_id,
  transfer_kind,
  authorized_by,
  device_id,
  local_ledger_id,
  local_timestamp,
  synced_at,
  notes
)
select
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001',
  'medic_bag',
  'Medic Cohen Bag',
  ii.id,
  case
    when ii.sku = 'TQ' then 2
    when ii.sku = 'COMBAT_GAUZE' then 1
    when ii.sku = 'BANDAGE' then 2
    else 0
  end,
  '{"building":"15A","floor":"3","apartment":"7"}'::jsonb,
  'INITIAL_STOCK',
  gen_random_uuid(),
  'INITIAL_FILL',
  '00000000-0000-0000-0000-000000000003',
  'device-cohen',
  'seed-medic-cohen-bag-' || ii.sku,
  now() - interval '38 minutes',
  now(),
  'Initial Medic Cohen personal bag stock'
from inventory_items ii
where ii.sku in ('TQ','COMBAT_GAUZE','BANDAGE')
on conflict (device_id, local_ledger_id) do nothing;

-- Demo request remains Medic -> PC using default request_level.


-- v1.1 Demo Draft Incident Pending Approval
insert into incidents (
  id, visual_id, t_zero, t_injury_default, location_name, address, incident_type,
  status, draft_created_by, metadata
)
values (
  '10000000-0000-0000-0000-000000000099',
  'INC-DRAFT-001',
  now() - interval '5 minutes',
  now() - interval '5 minutes',
  'Draft Building 15C',
  'Tel Aviv',
  'collapse',
  'draft',
  '00000000-0000-0000-0000-000000000001',
  '{"approval_required":true,"blinking_banner":true}'::jsonb
)
on conflict (id) do nothing;

insert into patients (
  id, incident_id, visual_id, t_injury, current_triage, access_status, current_status,
  needs_full_assessment, pending_incident_approval, pulse_present, breathing_present,
  tourniquet_used, location_json, created_by
)
values (
  '30000000-0000-0000-0000-000000000099',
  '10000000-0000-0000-0000-000000000099',
  'P-001',
  now() - interval '5 minutes',
  'pending',
  'unknown',
  'identified',
  true,
  true,
  true,
  true,
  false,
  '{"building":"15C","floor":"1"}'::jsonb,
  '00000000-0000-0000-0000-000000000001'
)
on conflict (incident_id, visual_id) do nothing;

insert into events (
  incident_id, patient_id, actor_id, actor_role, type, payload_json,
  device_id, local_event_id, local_timestamp, synced_at
)
values (
  '10000000-0000-0000-0000-000000000099',
  '30000000-0000-0000-0000-000000000099',
  '00000000-0000-0000-0000-000000000001',
  'medic',
  'QUICK_PATIENT_CREATED',
  '{"draft_incident":true,"pending_incident_approval":true,"sync_priority":"immediate","pulse_present":true,"breathing_present":true}'::jsonb,
  'demo-device-cohen',
  'draft-patient-001',
  now() - interval '4 minutes',
  now() - interval '4 minutes'
)
on conflict (device_id, local_event_id) do nothing;


-- seed-v1.1-device-sync
insert into device_sync_state (incident_id, actor_id, device_id, last_successful_push_at, last_successful_pull_at, last_pull_cursor, unsynced_event_count, battery_percent, power_mode)
values
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','demo-device-cohen', now() - interval '15 seconds', now() - interval '15 seconds', 1, 0, 78, 'normal'),
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','demo-device-levi', now() - interval '6 minutes', now() - interval '6 minutes', 1, 0, 42, 'normal')
on conflict (incident_id, device_id) do nothing;

select refresh_incident_command_state('10000000-0000-0000-0000-000000000001');
