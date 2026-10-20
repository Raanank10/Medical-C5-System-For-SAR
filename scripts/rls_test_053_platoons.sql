-- Rolled-back RLS test for database/053 (docs/RLS_AUDIT_v1.md, 053 follow-up). Run in the
-- Supabase SQL editor right after the 053 statements in the same run (before applying 053 for
-- real), or on its own after applying 053. It ends with an error on purpose so nothing persists;
-- the error text is the result. Every line should start with "ok" or show the expected count.
-- Uses the synthetic test accounts of the live project, looked up by role.
do $test$
declare
  PC   uuid := (select id from profiles where role = 'pc' and is_active order by created_at limit 1);
  RPC  uuid := (select id from profiles where role = 'rpc' and is_active order by created_at limit 1);
  RCC  uuid := (select id from profiles where role = 'rcc' and is_active order by created_at limit 1);
  CC   uuid := (select id from profiles where role = 'cc' and is_active order by created_at limit 1);
  PARA uuid := (select id from profiles where role = 'paramedic' and is_active order by created_at limit 1);
  M1   uuid := (select id from profiles where role = 'medic' and is_active order by created_at limit 1);
  M2   uuid := (select id from profiles where role = 'medic' and is_active order by created_at offset 1 limit 1);
  LOG  uuid := (select id from profiles where role = 'logistics_officer' and is_active order by created_at limit 1);
  IA   uuid := '00000000-0000-0000-0000-0000000000a1';  -- TEST-INC-A (synthetic seed), has clinical events
  IB   uuid := (select id from incidents where status = 'active' order by opened_at limit 1);
  NEWI uuid := gen_random_uuid();
  DRAFT uuid := gen_random_uuid();
  total bigint := (select count(*) from incidents);
  CA uuid; CB uuid; AMB uuid; A1 uuid; A2 uuid; B1 uuid;
  r text := ''; n bigint; n2 bigint; ok boolean; j jsonb;
begin
  -- Fixtures as the SQL editor (auth.uid() null): rescue companies A and B, an ambulance team.
  insert into companies(name, kind) values ('TEST-CO-A', 'rescue') returning id into CA;
  insert into companies(name, kind) values ('TEST-CO-B', 'rescue') returning id into CB;
  insert into companies(name, kind) values ('TEST-AMB', 'ambulance') returning id into AMB;
  insert into platoons(company_id, name) values (CA, 'A1') returning id into A1;
  insert into platoons(company_id, name) values (CA, 'A2') returning id into A2;
  insert into platoons(company_id, name) values (CB, 'B1') returning id into B1;
  update profiles set platoon_id = A1 where id = RPC;
  update profiles set company_id = CA where id in (PC, RCC, M1);
  update profiles set company_id = CB where id = M2;
  update profiles set company_id = AMB where id = PARA;
  update incidents set platoon_id = A1 where id = IA;
  update incidents set company_id = CB where id = IB;
  select count(*) into n from incidents where id = IA and company_id = CA; r := r || 'site company follows platoon=' || n || '; ';
  begin update profiles set company_id = CA where id = LOG; r := r || 'FAIL logistics placed; ';
  exception when others then r := r || 'ok logistics refused; '; end;
  begin update profiles set company_id = AMB where id = RCC; r := r || 'FAIL rcc in ambulance; ';
  exception when others then r := r || 'ok rcc in ambulance refused; '; end;
  begin update profiles set platoon_id = A1 where id = PC; r := r || 'FAIL pc in platoon; ';
  exception when others then r := r || 'ok pc in platoon refused; '; end;

  -- rpc (platoon A1, no membership)
  perform set_config('request.jwt.claims', json_build_object('sub', RPC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents; r := r || 'rpc incidents=' || n || ' (want 1); ';
  select count(*) into n from events where type in ('VITALS_RECORDED','MEDICATION_ADMINISTERED','INTERVENTION_RECORDED','PATIENT_HANDED_OVER','QUICK_PATIENT_CREATED','NOTE_ADDED'); r := r || 'rpc clinical=' || n || ' (want 0); ';
  select count(*) into n from vw_patient_latest_vitals; select count(*) into n2 from vw_patient_treatment_history; r := r || 'rpc views=' || n || '/' || n2 || ' (want 0/0); ';
  select count(*) into n from events where incident_id = IA; r := r || 'rpc tactical events=' || n || '; ';
  begin perform join_incident(IB); r := r || 'FAIL rpc joined B; ';
  exception when others then r := r || 'ok rpc join B refused; '; end;
  begin perform set_incident_unit(IA, CA, A2); r := r || 'FAIL rpc moved site; ';
  exception when others then r := r || 'ok rpc move refused; '; end;
  select open_incident(NEWI, 'TEST rpc site') into j; r := r || 'rpc site in A1=' || ((j->>'platoon_id')::uuid = A1) || '; ';
  execute 'reset role';

  -- rcc (company A)
  perform set_config('request.jwt.claims', json_build_object('sub', RCC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents where id in (IA, IB); r := r || 'rcc sees A-site, not B=' || n || ' (want 1); ';
  select count(*) into n from events where type in ('VITALS_RECORDED','MEDICATION_ADMINISTERED','INTERVENTION_RECORDED','PATIENT_HANDED_OVER'); r := r || 'rcc clinical=' || n || ' (want 0); ';
  perform set_incident_unit(IA, CA, A2); select count(*) into n from incidents where id = IA and platoon_id = A2; r := r || 'rcc moved site A1->A2=' || n || '; ';
  begin perform set_incident_unit(IB, CA, A1); r := r || 'FAIL rcc took B site; ';
  exception when others then r := r || 'ok rcc take B site refused; '; end;
  begin perform create_platoon(CA, 'A9'); r := r || 'FAIL rcc created platoon; ';
  exception when others then r := r || 'ok rcc create refused; '; end;
  execute 'reset role';

  -- rpc after the move: A1's rpc no longer sees the site
  perform set_config('request.jwt.claims', json_build_object('sub', RPC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents where id = IA; r := r || 'A1 rpc after move=' || n || ' (want 0); ';
  execute 'reset role';

  -- pc (company A)
  perform set_config('request.jwt.claims', json_build_object('sub', PC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents where id in (IA, IB, NEWI); r := r || 'pc sees company A sites=' || n || ' (want 2); ';
  select count(*) into n from events where type in ('VITALS_RECORDED','MEDICATION_ADMINISTERED','INTERVENTION_RECORDED'); r := r || 'pc clinical=' || n || ' (want >0); ';
  select count(*) into n from profiles where id in (M1, RCC, RPC); r := r || 'pc reads own company=' || n || ' (want 3); ';
  select count(*) into n from profiles where id in (M2, PARA); r := r || 'pc reads others=' || n || ' (want 0); ';
  begin perform set_profile_unit(M2, CA, null); r := r || 'FAIL pc roster; ';
  exception when others then r := r || 'ok pc roster refused; '; end;
  begin update incidents set company_id = CB where id = IA; r := r || 'FAIL pc moved site; ';
  exception when others then r := r || 'ok pc move refused; '; end;
  begin insert into unit_audit(action) values ('company_created'); r := r || 'FAIL pc wrote audit; ';
  exception when others then r := r || 'ok pc audit write refused; '; end;
  execute 'reset role';
  select app.pc_may_manage_membership(IA, M1, 'medic') into ok; r := r || 'pc may assign own medic=' || ok || '; ';
  select app.pc_may_manage_membership(IA, M2, 'medic') into ok; r := r || 'pc may assign B medic=' || ok || ' (want false); ';

  -- medic of company A drafts; the draft is company A's, so pc A sees and confirms it
  perform set_config('request.jwt.claims', json_build_object('sub', M1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select open_incident(DRAFT, 'TEST medic draft') into j; r := r || 'draft in A=' || ((j->>'company_id')::uuid = CA) || '; ';
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', PC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from list_open_incidents() l where l.id = DRAFT; r := r || 'pc lists draft=' || n || '; ';
  perform confirm_draft(DRAFT); select count(*) into n from incidents where id = DRAFT and status = 'active'; r := r || 'pc confirmed=' || n || '; ';
  begin update incidents set company_id = CB where id = DRAFT; r := r || 'FAIL pc moved platoon-less site; ';
  exception when others then r := r || 'ok pc move platoon-less site refused; '; end;
  execute 'reset role';

  -- medic of company B: no site of company A without assignment
  perform set_config('request.jwt.claims', json_build_object('sub', M2, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents where id = IA; r := r || 'B medic sees A site=' || n || ' (want 0); ';
  execute 'reset role';

  -- paramedic (ambulance): every site
  perform set_config('request.jwt.claims', json_build_object('sub', PARA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents; r := r || 'paramedic incidents=' || n || ' of ' || (total + 2) || '; ';
  execute 'reset role';

  -- cc: manages units; duplicate names and wrong placements refused
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents; r := r || 'cc incidents=' || n || ' of ' || (total + 2) || '; ';
  perform create_platoon(CB, 'B2');
  begin perform create_platoon(CB, 'b2'); r := r || 'FAIL duplicate platoon; ';
  exception when others then r := r || 'ok duplicate platoon refused; '; end;
  begin perform create_platoon(AMB, 'X'); r := r || 'FAIL platoon in ambulance; ';
  exception when others then r := r || 'ok platoon in ambulance refused; '; end;
  begin perform set_profile_unit(RPC, CA, null); r := r || 'FAIL rpc in company; ';
  exception when others then r := r || 'ok rpc needs a platoon; '; end;
  perform set_profile_unit(M2, CA, null);
  perform set_incident_unit(IB, CA, A1); select count(*) into n from incidents where id = IB and company_id = CA; r := r || 'cc moved B site to A=' || n || '; ';
  perform set_platoon_commander(M2, PC); select count(*) into n from profiles where id = M2 and company_id = CA; r := r || '045 wrapper=' || n || '; ';
  select count(*) into n from unit_audit; r := r || 'cc reads audit rows=' || n || '; ';
  execute 'reset role';

  -- With database/042: an admin's role change clears a unit that no longer fits; both audits record it
  if to_regprocedure('public.admin_set_user_role(uuid,user_role)') is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', (select id from profiles where role = 'admin' and is_active order by created_at limit 1), 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    perform admin_set_user_role(RCC, 'logistics_officer');
    execute 'reset role';
    select count(*) into n from profiles where id = RCC and company_id is null; r := r || '042 role change cleared unit=' || n || '; ';
    select count(*) into n from admin_user_audit where target_user_id = RCC and action = 'role_changed'; select count(*) into n2 from unit_audit where target_profile_id = RCC and new_company_id is null and old_company_id = CA;
    r := r || '042 audit/053 audit=' || n || '/' || n2 || '; ';
  else
    r := r || '(042 not applied: skipped 042 check); ';
  end if;

  -- Role change keeps what still fits, clears the rest (SQL editor path)
  perform set_config('request.jwt.claims', '', true);
  update profiles set role = 'paramedic' where id = M1;
  select count(*) into n from profiles where id = M1 and company_id = CA; r := r || 'medic->paramedic keeps company=' || n || '; ';
  update profiles set role = 'pc' where id = RPC;
  select count(*) into n from profiles where id = RPC and platoon_id is null and company_id is null; r := r || 'rpc->pc clears platoon=' || n || '; ';
  begin update unit_audit set detail = '{}'; r := r || 'FAIL audit mutable; ';
  exception when others then r := r || 'ok audit append-only; '; end;

  raise exception 'TEST 053 RESULTS (rolled back): %', r;
end
$test$;
