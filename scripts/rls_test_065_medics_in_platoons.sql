-- Rolled-back RLS test for database/065 (docs/RLS_AUDIT_v1.md, 065 follow-up). Run in the
-- Supabase SQL editor after 065 is applied. It ends with an error on purpose so nothing persists;
-- the error text is the result. Every item should start with "ok" or show the expected value.
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
  SITE uuid := gen_random_uuid();
  CA uuid; CB uuid; AMB uuid; A1 uuid; A2 uuid; B1 uuid;
  r text := ''; n bigint; ok boolean; v uuid;
begin
  -- Fixtures as the SQL editor (auth.uid() null)
  insert into companies(name, kind) values ('TEST65-CO-A', 'rescue') returning id into CA;
  insert into companies(name, kind) values ('TEST65-CO-B', 'rescue') returning id into CB;
  insert into companies(name, kind) values ('TEST65-AMB', 'ambulance') returning id into AMB;
  insert into platoons(company_id, name) values (CA, 'A1') returning id into A1;
  insert into platoons(company_id, name) values (CA, 'A2') returning id into A2;
  insert into platoons(company_id, name) values (CB, 'B1') returning id into B1;
  update profiles set company_id = CA where id = PC;
  insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, status, opened_at, platoon_id)
    values (SITE, 'TEST65-A2', now(), now(), 'TEST65 A2 site', 'active', now(), A2);

  -- Placement rules
  update profiles set platoon_id = A1 where id = M1;
  select count(*) into n from profiles where id = M1 and platoon_id = A1 and company_id is null; r := r || 'medic placed in platoon=' || n || '; ';
  update profiles set platoon_id = B1 where id = M2;
  update profiles set company_id = AMB where id = PARA;
  select count(*) into n from profiles where id = PARA and company_id = AMB; r := r || 'paramedic in ambulance=' || n || '; ';
  begin update profiles set company_id = CA where id = M1; r := r || 'FAIL medic in platoon and company; ';
  exception when others then r := r || 'ok platoon+company refused; '; end;
  begin update profiles set platoon_id = A1, company_id = null where id = PC; r := r || 'FAIL pc in platoon; ';
  exception when others then r := r || 'ok pc in platoon refused; '; end;
  begin update profiles set platoon_id = A1 where id = RCC; r := r || 'FAIL rcc in platoon; ';
  exception when others then r := r || 'ok rcc in platoon refused; '; end;

  -- pc (company A): reads and may assign a medic attached to A1, into a site of platoon A2
  perform set_config('request.jwt.claims', json_build_object('sub', PC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from profiles where id = M1; r := r || 'pc reads A1 medic=' || n || ' (want 1); ';
  select count(*) into n from profiles where id = M2; r := r || 'pc reads B1 medic=' || n || ' (want 0); ';
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
    values (SITE, M1, 'medic', PC);
  select count(*) into n from incident_memberships where incident_id = SITE and profile_id = M1; r := r || 'pc assigned A1 medic to A2 site=' || n || '; ';
  begin
    insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values (SITE, M2, 'medic', PC);
    r := r || 'FAIL pc assigned B1 medic; ';
  exception when others then r := r || 'ok pc assign B1 medic refused; '; end;
  begin perform set_profile_unit(M2, null, A1); r := r || 'FAIL pc roster; ';
  exception when others then r := r || 'ok pc roster refused; '; end;
  execute 'reset role';

  -- medic attached to A1: still only assigned sites (it was just assigned SITE)
  perform set_config('request.jwt.claims', json_build_object('sub', M2, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents where id = SITE; r := r || 'B1 medic sees A2 site=' || n || ' (want 0); ';
  execute 'reset role';

  -- cc: places medics through the RPC
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  perform set_profile_unit(M2, null, A2);
  select count(*) into n from profiles where id = M2 and platoon_id = A2; r := r || 'cc placed medic in A2=' || n || '; ';
  begin perform set_profile_unit(M2, CA, A2); r := r || 'FAIL cc platoon+company; ';
  exception when others then r := r || 'ok cc platoon+company refused; '; end;
  begin perform set_profile_unit(PC, null, A1); r := r || 'FAIL cc pc in platoon; ';
  exception when others then r := r || 'ok cc pc in platoon refused; '; end;
  execute 'reset role';

  -- Role changes keep what still fits (SQL editor path)
  perform set_config('request.jwt.claims', '', true);
  update profiles set role = 'pc' where id = M2;
  select count(*) into n from profiles where id = M2 and company_id = CA and platoon_id is null; r := r || 'A2 medic -> pc keeps company A=' || n || '; ';
  update profiles set role = 'rpc' where id = M1;
  select count(*) into n from profiles where id = M1 and platoon_id = A1 and company_id is null; r := r || 'A1 medic -> rpc keeps A1=' || n || '; ';
  update profiles set role = 'logistics_officer' where id = PARA;
  select count(*) into n from profiles where id = PARA and company_id is null and platoon_id is null; r := r || 'paramedic -> logistics clears unit=' || n || '; ';
  select count(*) into n from unit_audit where target_profile_id in (M1, M2, PARA); r := r || 'audit rows=' || n || '; ';

  raise exception 'TEST 065 RESULTS (rolled back): %', r;
end
$test$;
