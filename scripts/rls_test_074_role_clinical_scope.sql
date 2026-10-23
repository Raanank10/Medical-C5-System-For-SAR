-- Rolled-back RLS test for database/074 (docs/RLS_AUDIT_v1.md, 074 follow-up). Run in the
-- Supabase SQL editor after 074 is applied. It ends with an error on purpose so nothing persists;
-- the error text is the result. Every item should start with "ok" or show the expected value.
-- Uses the synthetic test accounts of the live project, looked up by role; every unit, site,
-- patient, event and ledger row it needs is created inside the block and rolled back.
do $test$
declare
  CC   uuid := (select id from profiles where role = 'cc' and is_active order by created_at limit 1);
  PC   uuid := (select id from profiles where role = 'pc' and is_active order by created_at limit 1);
  RCC  uuid := (select id from profiles where role = 'rcc' and is_active order by created_at limit 1);
  RPC  uuid := (select id from profiles where role = 'rpc' and is_active order by created_at limit 1);
  LOGO uuid := (select id from profiles where role = 'logistics_officer' and is_active order by created_at limit 1);
  M1   uuid := (select id from profiles where role = 'medic' and is_active order by created_at limit 1);
  M2   uuid := (select id from profiles where role = 'medic' and is_active order by created_at offset 1 limit 1);
  X uuid := gen_random_uuid();   -- site of company A, platoon A1
  Y uuid := gen_random_uuid();   -- site of company B
  P_RED uuid := gen_random_uuid(); P_TQ uuid := gen_random_uuid(); P_PEND uuid := gen_random_uuid(); P_Y uuid := gen_random_uuid();
  P_DEAD uuid := gen_random_uuid(); -- deceased with an active tourniquet: still last in the order
  CA uuid; CB uuid; A1 uuid; B1 uuid;
  -- Saved so the block can put them back (it rolls back anyway; this keeps the roster intact if
  -- someone ever removes the final raise).
  pc_co uuid; rcc_co uuid; rpc_pl uuid; m1_pl uuid; m1_co uuid;
  r text := ''; n bigint; ok boolean; s text;
  clin text[] := array['VITALS_RECORDED','PATIENT_TRIAGE_UPDATED','TOURNIQUET_APPLIED','SUPPLY_CONSUMED','INVENTORY_LEDGER_MOVEMENT','QUICK_PATIENT_CREATED'];
begin
  select company_id into pc_co from profiles where id = PC;
  select company_id into rcc_co from profiles where id = RCC;
  select platoon_id into rpc_pl from profiles where id = RPC;
  select platoon_id, company_id into m1_pl, m1_co from profiles where id = M1;

  -- Fixtures as the SQL editor (auth.uid() null)
  insert into companies(name, kind) values ('TEST74-CO-A', 'rescue') returning id into CA;
  insert into companies(name, kind) values ('TEST74-CO-B', 'rescue') returning id into CB;
  insert into platoons(company_id, name) values (CA, 'A1') returning id into A1;
  insert into platoons(company_id, name) values (CB, 'B1') returning id into B1;
  update profiles set company_id = CA, platoon_id = null where id in (PC, RCC);
  update profiles set platoon_id = A1, company_id = null where id in (RPC, M1);
  insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, status, opened_at, company_id, platoon_id)
    values (X, 'TEST74-X', now(), now(), 'TEST74 X', 'active', now(), CA, A1),
           (Y, 'TEST74-Y', now(), now(), 'TEST74 Y', 'active', now(), CB, B1);
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values (X, M1, 'medic', CC);
  insert into patients (id, incident_id, visual_id, t_injury, current_triage, current_status, access_status, pulse_present, breathing_present, created_by)
    values (P_RED,  X, 'T74-RED',  now(), 'red',     'identified', 'trapped', true, true, M1),
           (P_TQ,   X, 'T74-TQ',   now(), 'green',   'identified', 'free',    true, true, M1),
           (P_PEND, X, 'T74-PEND', now(), 'pending', 'identified', 'free',    null, null, M1),
           (P_DEAD, X, 'T74-DEAD', now(), 'black',   'deceased',   'free',    null, null, M1),
           (P_Y,    Y, 'T74-Y',    now(), 'red',     'identified', 'free',    true, true, M1);
  insert into tourniquets (incident_id, patient_id, limb, applied_at) values (X, P_TQ, 'left_arm', now() - interval '90 minutes'),
    (X, P_DEAD, 'right_leg', now() - interval '110 minutes');
  insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, P_RED, M1, 'medic', 'VITALS_RECORDED', '{"avpu":"U","rr":34}', 'test73-dev', 'test73-1', now()),
    (X, P_RED, M1, 'medic', 'PATIENT_LOCATION_UPDATED', '{"location":{"zone":"B2"}}', 'test73-dev', 'test73-2', now()),
    (X, null,  M1, 'medic', 'SUPPLY_REQUEST_CREATED', '{}', 'test73-dev', 'test73-3', now()),
    (X, P_RED, M1, 'medic', 'SUPPLY_CONSUMED', '{"item_type":"tourniquets","patient_id":"x"}', 'test73-dev', 'test73-4', now());
  insert into inventory_ledger_v12 (incident_id, actor_id, item_type, movement_type, quantity_delta, device_id, local_event_id, patient_id, stock_owner, stock_after, occurred_at)
    values (X, M1, 'tourniquets', 'treatment_consumed', -1, 'test73-dev', 'test73-5', P_RED, 'medic_bag', 3, now());

  -- medic of the site: unchanged, reads every patient and the clinical events
  perform set_config('request.jwt.claims', json_build_object('sub', M1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from patients where incident_id = X; r := r || 'medic patients X=' || n || ' (want 4); ';
  select count(*) into n from events where incident_id = X and type = 'VITALS_RECORDED'; r := r || 'medic vitals X=' || n || ' (want 1); ';
  select count(*) into n from tourniquets where incident_id = X; r := r || 'medic tourniquets X=' || n || ' (want 2); ';
  execute 'reset role';

  -- pc of company A: unchanged
  perform set_config('request.jwt.claims', json_build_object('sub', PC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from patients where incident_id = X; r := r || 'pc patients X=' || n || ' (want 4); ';
  select count(*) into n from patients where incident_id = Y; r := r || 'pc patients Y=' || n || ' (want 0); ';
  begin perform get_rescue_patient_board(X); r := r || 'FAIL pc read the rescue board; ';
  exception when others then r := r || 'ok pc rescue board refused; '; end;
  execute 'reset role';

  -- rpc of platoon A1: tactical only
  perform set_config('request.jwt.claims', json_build_object('sub', RPC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents where id = X; r := r || 'rpc sees site X=' || n || ' (want 1); ';
  select count(*) into n from patients where incident_id = X; r := r || 'rpc patients rows X=' || n || ' (want 0); ';
  select count(*) into n from tourniquets where incident_id = X; r := r || 'rpc tourniquets X=' || n || ' (want 0); ';
  select count(*) into n from events where incident_id = X and type::text = any (clin); r := r || 'rpc clinical events X=' || n || ' (want 0); ';
  select count(*) into n from events where incident_id = X and type in ('PATIENT_LOCATION_UPDATED','SUPPLY_REQUEST_CREATED'); r := r || 'rpc location+supply-request events X=' || n || ' (want 2); ';
  select count(*) into n from vw_patient_latest_vitals where patient_id in (P_RED, P_TQ, P_PEND); r := r || 'rpc vitals view X=' || n || ' (want 0); ';
  select count(*) into n from get_rescue_patient_board(X); r := r || 'rpc board X=' || n || ' (want 4); ';
  select string_agg(visual_id || ':' || priority || ':' || evac_order, ',' order by evac_order) into s from get_rescue_patient_board(X);
  r := r || 'rpc board order=' || s || ' (want T74-TQ:urgent:1,T74-RED:urgent:2,T74-PEND:pending:3,T74-DEAD:not_urgent:4); ';
  begin perform get_rescue_patient_board(Y); r := r || 'FAIL rpc read site Y board; ';
  exception when others then r := r || 'ok rpc board Y refused; '; end;
  begin perform get_incident_command_state(X); r := r || 'FAIL rpc read command state; ';
  exception when others then r := r || 'ok rpc command state refused; '; end;
  execute 'reset role';

  -- rcc of company A: same tactical board
  perform set_config('request.jwt.claims', json_build_object('sub', RCC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from patients where incident_id = X; r := r || 'rcc patients rows X=' || n || ' (want 0); ';
  select count(*) into n from get_rescue_patient_board(X); r := r || 'rcc board X=' || n || ' (want 4); ';
  execute 'reset role';

  -- logistics: may join any open site, then reads bags and supply requests only
  perform set_config('request.jwt.claims', json_build_object('sub', LOGO, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform join_incident(X); r := r || 'logistics joined X; ';
  select count(*) into n from patients where incident_id = X; r := r || 'logistics patients X=' || n || ' (want 0); ';
  select count(*) into n from tourniquets where incident_id = X; r := r || 'logistics tourniquets X=' || n || ' (want 0); ';
  select count(*) into n from events where incident_id = X and type::text = any (clin); r := r || 'logistics clinical/patient-linked events X=' || n || ' (want 0); ';
  select count(*) into n from events where incident_id = X and type = 'SUPPLY_REQUEST_CREATED'; r := r || 'logistics supply-request events X=' || n || ' (want 1); ';
  select count(*) into n from inventory_ledger_v12 where incident_id = X; r := r || 'logistics ledger table X=' || n || ' (want 0); ';
  select count(*) into n from get_incident_stock_movements(X); r := r || 'logistics stock movements X=' || n || ' (want 1); ';
  select not exists (select 1 from information_schema.routines rt join information_schema.parameters pa on pa.specific_name = rt.specific_name
                     where rt.routine_name = 'get_incident_stock_movements' and pa.parameter_name = 'patient_id') into ok;
  r := r || case when ok then 'ok stock movements carry no patient; ' else 'FAIL stock movements carry patient_id; ' end;
  begin perform get_rescue_patient_board(X); r := r || 'FAIL logistics read the rescue board; ';
  exception when others then r := r || 'ok logistics rescue board refused; '; end;
  begin perform get_incident_command_state(X); r := r || 'FAIL logistics read command state; ';
  exception when others then r := r || 'ok logistics command state refused; '; end;
  execute 'reset role';

  -- medic of another unit: nothing
  perform set_config('request.jwt.claims', json_build_object('sub', M2, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from patients where incident_id = X; r := r || 'other medic patients X=' || n || ' (want 0); ';
  execute 'reset role';

  -- cc: unchanged
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from patients where incident_id in (X, Y); r := r || 'cc patients X+Y=' || n || ' (want 5); ';
  perform get_incident_command_state(X); r := r || 'ok cc command state; ';
  execute 'reset role';

  update profiles set company_id = pc_co where id = PC;
  update profiles set company_id = rcc_co where id = RCC;
  update profiles set platoon_id = rpc_pl where id = RPC;
  update profiles set platoon_id = m1_pl, company_id = m1_co where id = M1;
  raise exception 'TEST74 RESULT: %', r;
end
$test$;
