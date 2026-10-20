-- Rolled-back RLS test for database/053 (docs/RLS_AUDIT_v1.md, 053 follow-up). Run in the SQL editor AFTER the
-- 053 statements in the same transaction, or after applying 053. It ends with an error on purpose so
-- nothing persists; the error text is the result. Uses the synthetic test accounts of the live project.
do $test$
declare
  PC  uuid := (select id from profiles where role = 'pc' and is_active order by created_at limit 1);
  RPC uuid := (select id from profiles where role = 'rpc' and is_active order by created_at limit 1);
  RCC uuid := (select id from profiles where role = 'rcc' and is_active order by created_at limit 1);
  CC  uuid := (select id from profiles where role = 'cc' and is_active order by created_at limit 1);
  ADM uuid := (select id from profiles where role = 'admin' and is_active order by created_at limit 1);
  M1  uuid := (select id from profiles where role = 'medic' and is_active order by created_at limit 1);
  M2  uuid := (select id from profiles where role = 'medic' and is_active order by created_at offset 1 limit 1);
  LOG uuid := (select id from profiles where role = 'logistics_officer' and is_active order by created_at limit 1);
  IA  uuid := '00000000-0000-0000-0000-0000000000a1';  -- TEST-INC-A (synthetic seed), has clinical events
  IB  uuid := (select id from incidents where status = 'active' order by opened_at limit 1);
  NEWI uuid := gen_random_uuid();
  PA uuid; PB uuid; PX uuid;
  r text := '';
  n bigint; n2 bigint; ok boolean; j jsonb;
begin
  -- Fixtures as the SQL editor (auth.uid() null).
  insert into platoons(name) values ('TEST-PLT-A') returning id into PA;
  insert into platoons(name) values ('TEST-PLT-B') returning id into PB;
  update profiles set platoon_id = PA where id in (PC, RPC, M1);
  update profiles set platoon_id = PB where id = M2;
  update incidents set platoon_id = PA where id = IA;
  update incidents set platoon_id = PB where id = IB;
  begin update profiles set platoon_id = PA where id = LOG; r := r || 'FAIL logistics placed; ';
  exception when others then r := r || 'ok logistics refused; '; end;

  -- RPC (platoon A)
  perform set_config('request.jwt.claims', json_build_object('sub', RPC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents; r := r || 'rpc incidents=' || n || '; ';
  select count(*) into n from incidents where id = IA; r := r || 'rpc sees IA=' || n || '; ';
  select count(*) into n from events where incident_id = IA; r := r || 'rpc IA events=' || n || '; ';
  select count(*) into n from events where type in ('VITALS_RECORDED','MEDICATION_ADMINISTERED','INTERVENTION_RECORDED','PATIENT_HANDED_OVER','QUICK_PATIENT_CREATED','NOTE_ADDED'); r := r || 'rpc clinical=' || n || '; ';
  select count(*) into n from vw_patient_latest_vitals; select count(*) into n2 from vw_patient_treatment_history; r := r || 'rpc views=' || n || '/' || n2 || '; ';
  select count(*) into n from patients; r := r || 'rpc patients=' || n || '; ';
  select count(*) into n from platoons; r := r || 'rpc platoons readable=' || n || '; ';
  select count(*) into n from profiles; r := r || 'rpc profiles=' || n || '; ';
  begin perform join_incident(IB); r := r || 'FAIL rpc joined IB; ';
  exception when others then r := r || 'ok rpc join IB refused; '; end;
  begin perform set_incident_platoon(IB, PA); r := r || 'FAIL rpc set platoon; ';
  exception when others then r := r || 'ok rpc set_incident_platoon refused; '; end;
  select open_incident(NEWI, 'TEST rpc site') into j; r := r || 'rpc opened platoon ok=' || ((j->>'platoon_id')::uuid = PA) || '; ';
  execute 'reset role';

  -- RCC (company-wide)
  perform set_config('request.jwt.claims', json_build_object('sub', RCC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents; r := r || 'rcc incidents=' || n || '; ';
  select count(*) into n from events; r := r || 'rcc events=' || n || '; ';
  select count(*) into n from events where type in ('VITALS_RECORDED','MEDICATION_ADMINISTERED','INTERVENTION_RECORDED','PATIENT_HANDED_OVER','QUICK_PATIENT_CREATED','NOTE_ADDED'); r := r || 'rcc clinical=' || n || '; ';
  select count(*) into n from events where type = 'BUILDING_STATUS_UPDATED'; r := r || 'rcc building events=' || n || '; ';
  execute 'reset role';

  -- PC (platoon A)
  perform set_config('request.jwt.claims', json_build_object('sub', PC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents; r := r || 'pc incidents=' || n || '; ';
  select count(*) into n from events where type in ('VITALS_RECORDED','MEDICATION_ADMINISTERED','INTERVENTION_RECORDED'); r := r || 'pc clinical=' || n || '; ';
  select count(*) into n from profiles; r := r || 'pc profiles=' || n || '; ';
  select count(*) into n from profiles where id = M2; r := r || 'pc sees M2=' || n || '; ';


  begin perform set_profile_platoon(M2, PA); r := r || 'FAIL pc roster; ';
  exception when others then r := r || 'ok pc roster refused; '; end;
  begin update incidents set platoon_id = PB where id = IA; r := r || 'FAIL pc moved IA; ';
  exception when others then r := r || 'ok pc move incident refused; '; end;
  begin perform create_platoon('TEST-PLT-PC'); r := r || 'FAIL pc created platoon; ';
  exception when others then r := r || 'ok pc create refused; '; end;
  begin insert into platoon_audit(action) values ('platoon_created'); r := r || 'FAIL pc wrote audit; ';
  exception when others then r := r || 'ok pc audit write refused; '; end;
  execute 'reset role';
  select app.pc_may_manage_membership(IA, M1, 'medic') into ok; r := r || 'pc may assign M1=' || ok || '; ';
  select app.pc_may_manage_membership(IA, M2, 'medic') into ok; r := r || 'pc may assign M2=' || ok || '; ';

  -- Medic M1 (platoon A, not a member of IA)
  perform set_config('request.jwt.claims', json_build_object('sub', M1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents where id = IA; r := r || 'medic sees IA=' || n || '; ';
  execute 'reset role';

  -- CC (company-level command)
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select (create_platoon('TEST-PLT-C')->>'id')::uuid into PX;
  perform set_profile_platoon(M2, PX);
  perform set_incident_platoon(IB, PX);
  perform update_platoon(PX, 'TEST-PLT-C2', null);
  begin perform create_platoon('test-plt-c2'); r := r || 'FAIL duplicate name; ';
  exception when others then r := r || 'ok duplicate name refused; '; end;
  begin perform set_profile_platoon(LOG, PX); r := r || 'FAIL cc placed logistics; ';
  exception when others then r := r || 'ok cc logistics refused; '; end;
  select count(*) into n from platoon_audit; r := r || 'cc audit rows=' || n || '; ';
  select count(*) into n from events where type in ('VITALS_RECORDED','MEDICATION_ADMINISTERED','INTERVENTION_RECORDED'); r := r || 'cc clinical=' || n || '; ';
  execute 'reset role';

  -- PC: after M2 moved to PX, still cannot see M2
  perform set_config('request.jwt.claims', json_build_object('sub', PC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents where id = IB; r := r || 'pc sees IB=' || n || '; ';
  begin perform update_platoon(PA, 'x', null); r := r || 'FAIL pc renamed; ';
  exception when others then r := r || 'ok pc rename refused; '; end;
  execute 'reset role';

  -- Role change out of a platoon role clears the platoon (SQL editor path).
  perform set_config('request.jwt.claims', '', true);
  update profiles set role = 'logistics_officer' where id = M1;
  select count(*) into n from profiles where id = M1 and platoon_id is null; r := r || 'role change cleared platoon=' || n || '; ';
  select count(*) into n from platoon_audit where target_profile_id = M1; r := r || 'M1 audit rows=' || n || '; ';
  begin update platoon_audit set detail = '{}'; r := r || 'FAIL audit mutable; ';
  exception when others then r := r || 'ok audit append-only; '; end;

  raise exception 'TEST RESULTS (rolled back): %', r;
end
$test$;
