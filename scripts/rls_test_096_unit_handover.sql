-- Rolled-back test for database/096 (CC moves a site to another company / reinforces it, WP-27).
-- Run in the Supabase SQL editor after 095 and 096 are applied. It ends with an error on purpose so
-- nothing persists; the error text is the result: every line should read "ok", and the last line
-- counts the failures (want 0).
-- Uses the synthetic test accounts of the live project, looked up by role. The live project has one
-- PC, so the physician account stands in for company B's PC inside the transaction (its role is
-- changed and rolled back with everything else).
do $test$
declare
  CC  uuid := (select id from profiles where role = 'cc' and is_active order by created_at limit 1);
  PCA uuid := (select id from profiles where role = 'pc' and is_active order by created_at limit 1);
  PCB uuid := (select id from profiles where role = 'physician' and is_active order by created_at limit 1);
  MA  uuid := (select id from profiles where role = 'medic' and is_active order by created_at limit 1);
  MA2 uuid := (select id from profiles where role = 'medic' and is_active order by created_at offset 1 limit 1);
  MB  uuid := (select id from profiles where role = 'medic' and is_active order by created_at offset 2 limit 1);
  RCCA uuid := (select id from profiles where role = 'rcc' and is_active order by created_at limit 1);
  RPCA uuid := (select id from profiles where role = 'rpc' and is_active order by created_at limit 1);
  CA uuid; CB uuid; PA1 uuid;
  X uuid := gen_random_uuid();   -- site handed over from A to B
  Y uuid := gen_random_uuid();   -- site A keeps, B reinforces
  P1 uuid := gen_random_uuid();
  t0 timestamptz := now() - interval '20 minutes';
  t_ho timestamptz;
  r text := ''; fails int := 0; n bigint; s text; ok boolean; j jsonb;
begin
  -- Each check: (label, got, want). now() is fixed for the whole transaction, so records meant to be
  -- "after the change" use clock_timestamp().
  create temp table if not exists _c(label text, got text, want text) on commit drop;
  grant all on _c to authenticated;

  insert into companies(name) values ('TEST96-A') returning id into CA;
  insert into companies(name) values ('TEST96-B') returning id into CB;
  insert into platoons(company_id, name) values (CA, 'TEST96-A1') returning id into PA1;
  update profiles set role = 'pc' where id = PCB;
  update profiles set company_id = CA, platoon_id = null where id in (PCA, MA, MA2, RCCA);
  update profiles set company_id = null, platoon_id = PA1 where id = RPCA;
  update profiles set company_id = CB, platoon_id = null where id in (PCB, MB);
  insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, status, opened_at, company_id, platoon_id) values
    (X, 'TEST96-X', t0, t0, 'TEST96 X', 'active', t0, CA, PA1),
    (Y, 'TEST96-Y', t0, t0, 'TEST96 Y', 'active', t0, CA, null);
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values
    (X, PCA, 'pc', PCA), (X, MA, 'medic', PCA), (Y, PCA, 'pc', PCA), (Y, MA, 'medic', PCA);
  insert into patients (id, incident_id, visual_id, t_injury, created_by) values (P1, X, 'T96-P1', t0, MA);

  -- ---- Before any change
  perform set_config('request.jwt.claims', json_build_object('sub', MA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
    values (X, MA, 'medic', 'NOTE_ADDED', 'dev-ma', 't96-1', now());
    insert into _c values ('A medic writes before', 'yes', 'yes');
  exception when others then insert into _c values ('A medic writes before', 'no: ' || sqlerrm, 'yes'); end;
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', PCB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents where id = X;
  insert into _c values ('B PC sees X before', n::text, '0');
  execute 'reset role';

  -- ---- Only cc/chamal/admin may hand over; a reason is required
  foreach s in array array[PCA::text, RCCA::text] loop
    perform set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    begin
      perform public.handover_incident_unit(X, CB, 'test');
      insert into _c values ('handover refused for ' || (select role::text from profiles where id = s::uuid), 'allowed', 'refused');
    exception when insufficient_privilege then insert into _c values ('handover refused for ' || (select role::text from profiles where id = s::uuid), 'refused', 'refused'); end;
    execute 'reset role';
  end loop;

  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.handover_incident_unit(X, CB, '  ');
    insert into _c values ('handover without reason', 'allowed', 'refused');
  exception when others then insert into _c values ('handover without reason', 'refused', 'refused'); end;
  j := public.handover_incident_unit(X, CB, 'A to rest', 'dev-cc', 't96-ho');
  t_ho := (j->>'read_only_since')::timestamptz;
  insert into _c values ('A memberships made read-only', j->>'memberships_read_only', '2');
  begin
    perform public.handover_incident_unit(X, CB, 'again');
    insert into _c values ('handover to the same company again', 'allowed', 'refused');
  exception when others then insert into _c values ('handover to the same company again', 'refused', 'refused'); end;
  execute 'reset role';

  select coalesce(company_id = CB, false)::text || '/' || (platoon_id is null)::text into s from incidents where id = X;
  insert into _c values ('X company B, platoon cleared', s, 'true/true');
  select count(*) into n from events where incident_id = X and type = 'INCIDENT_UNIT_HANDED_OVER';
  insert into _c values ('handover event written', n::text, '1');
  select count(*) into n from unit_audit where target_incident_id = X and actor_id = CC and action in ('incident_unit_handed_over','incident_unit_changed');
  insert into _c values ('unit_audit rows (handed_over + changed)', n::text, '2');

  -- ---- Old medic A: reads, cannot write now, records from before still accepted
  perform set_config('request.jwt.claims', json_build_object('sub', MA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from patients where incident_id = X;
  insert into _c values ('A medic reads patients', n::text, '1');
  select count(*) into n from events where incident_id = X;
  insert into _c values ('A medic pulls events', (n > 0)::text, 'true');
  begin
    insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
    values (X, MA, 'medic', 'NOTE_ADDED', 'dev-ma', 't96-2', clock_timestamp() + interval '1 second');
    insert into _c values ('A medic new record refused', 'accepted', 'refused');
  exception when insufficient_privilege then insert into _c values ('A medic new record refused', 'refused', 'refused'); end;
  begin
    insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
    values (X, MA, 'medic', 'NOTE_ADDED', 'dev-ma', 't96-3', t_ho - interval '2 minutes');
    insert into _c values ('A medic offline record from before accepted', 'accepted', 'accepted');
  exception when others then insert into _c values ('A medic offline record from before accepted', 'refused: ' || sqlerrm, 'accepted'); end;
  begin
    insert into patients (id, incident_id, visual_id, t_injury, created_by) values (gen_random_uuid(), X, 'T96-LATE', t_ho - interval '1 minute', MA);
    insert into _c values ('A medic offline patient from before accepted', 'accepted', 'accepted');
  exception when others then insert into _c values ('A medic offline patient from before accepted', 'refused: ' || sqlerrm, 'accepted'); end;
  begin
    insert into patients (id, incident_id, visual_id, t_injury, created_by) values (gen_random_uuid(), X, 'T96-NEW', clock_timestamp() + interval '1 second', MA);
    insert into _c values ('A medic new patient refused', 'accepted', 'refused');
  exception when insufficient_privilege then insert into _c values ('A medic new patient refused', 'refused', 'refused'); end;
  j := public.get_incident_unit_links(X);
  insert into _c values ('A medic access label', j->>'my_access', 'read_only');
  select count(*) into n from public.list_open_incidents() where id = X and read_only;
  insert into _c values ('A medic list shows X read-only', n::text, '1');
  execute 'reset role';

  -- ---- Old PC A: reads, no writes, cannot assign
  perform set_config('request.jwt.claims', json_build_object('sub', PCA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from incidents where id = X;
  insert into _c values ('A PC sees X', n::text, '1');
  select count(*) into n from public.list_open_incidents() where id = X and read_only and not is_member;
  insert into _c values ('A PC list: read-only, not a member', n::text, '1');
  update incidents set location_name = 'changed' where id = X;
  get diagnostics n = row_count;
  insert into _c values ('A PC updates X', n::text, '0');
  begin
    insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values (X, MA2, 'medic', PCA);
    insert into _c values ('A PC assigns his medic to X', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('A PC assigns his medic to X', 'refused', 'refused'); end;
  begin
    insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
    values (X, PCA, 'pc', 'NOTE_ADDED', 'dev-pca', 't96-4', clock_timestamp() + interval '1 second');
    insert into _c values ('A PC new record refused', 'accepted', 'refused');
  exception when insufficient_privilege then insert into _c values ('A PC new record refused', 'refused', 'refused'); end;
  select count(*) into n from public.list_incident_unit_notices();
  insert into _c values ('A PC gets no notice', n::text, '0');
  execute 'reset role';

  -- ---- A's rescue chain: read-only too
  foreach s in array array[RCCA::text, RPCA::text] loop
    perform set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    insert into _c values ('A rescue chain view/full (' || (select role::text from profiles where id = s::uuid) || ')',
      app.can_view_incident(X)::text || '/' || app.can_access_incident(X)::text, 'true/false');
    execute 'reset role';
  end loop;

  -- ---- New PC B: full, told once, assigns his medic
  perform set_config('request.jwt.claims', json_build_object('sub', PCB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select app.can_access_incident(X)::text into s;
  insert into _c values ('B PC full access', s, 'true');
  select string_agg(kind, ',') into s from public.list_incident_unit_notices() where incident_id = X;
  insert into _c values ('B PC notice', coalesce(s, '-'), 'handover');
  perform public.acknowledge_incident_unit_notice((select link_id from public.list_incident_unit_notices() where incident_id = X limit 1));
  select count(*) into n from public.list_incident_unit_notices() where incident_id = X;
  insert into _c values ('B PC notice gone after ack', n::text, '0');
  begin
    insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values (X, MB, 'medic', PCB);
    insert into _c values ('B PC assigns his medic', 'allowed', 'allowed');
  exception when others then insert into _c values ('B PC assigns his medic', 'refused: ' || sqlerrm, 'allowed'); end;
  begin
    insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values (X, MA2, 'medic', PCB);
    insert into _c values ('B PC assigns A''s medic', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('B PC assigns A''s medic', 'refused', 'refused'); end;
  execute 'reset role';

  perform set_config('request.jwt.claims', json_build_object('sub', MB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
    values (X, MB, 'medic', 'NOTE_ADDED', 'dev-mb', 't96-5', clock_timestamp() + interval '1 second');
    insert into _c values ('B medic writes', 'yes', 'yes');
  exception when others then insert into _c values ('B medic writes', 'no: ' || sqlerrm, 'yes'); end;
  execute 'reset role';

  -- ---- CC ends A's access
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  j := public.end_incident_unit_access(X, CA, 'dev-cc', 't96-end');
  insert into _c values ('A members ended', j->>'members_ended', '2');
  execute 'reset role';
  foreach s in array array[MA::text, PCA::text, RCCA::text, RPCA::text] loop
    perform set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    select count(*) into n from incidents where id = X;
    insert into _c values ('after end: sees X (' || (select role::text from profiles where id = s::uuid) || ')', n::text, '0');
    execute 'reset role';
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', MA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
    values (X, MA, 'medic', 'NOTE_ADDED', 'dev-ma', 't96-6', t_ho - interval '3 minutes');
    insert into _c values ('after end: record from before still accepted', 'accepted', 'accepted');
  exception when others then insert into _c values ('after end: record from before still accepted', 'refused: ' || sqlerrm, 'accepted'); end;
  execute 'reset role';

  -- ---- Reinforce Y with B; A stays
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  j := public.reinforce_incident_unit(Y, CB, 'more hands', 'dev-cc', 't96-rf');
  insert into _c values ('reinforce adds B PC', j->>'pcs_added', '1');
  begin
    perform public.reinforce_incident_unit(Y, CB, 'again');
    insert into _c values ('reinforce twice', 'allowed', 'refused');
  exception when others then insert into _c values ('reinforce twice', 'refused', 'refused'); end;
  begin
    perform public.reinforce_incident_unit(Y, CA, 'own company');
    insert into _c values ('reinforce with the site''s own company', 'allowed', 'refused');
  exception when others then insert into _c values ('reinforce with the site''s own company', 'refused', 'refused'); end;
  execute 'reset role';
  select (company_id = CA)::text into s from incidents where id = Y;
  insert into _c values ('Y stays company A', s, 'true');

  perform set_config('request.jwt.claims', json_build_object('sub', PCB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select string_agg(kind, ',') into s from public.list_incident_unit_notices() where incident_id = Y;
  insert into _c values ('B PC reinforce notice', coalesce(s, '-'), 'reinforce');
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values (Y, MB, 'medic', PCB);
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', PCA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select app.can_access_incident(Y)::text into s;
  insert into _c values ('A PC still full on Y', s, 'true');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', MB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
    values (Y, MB, 'medic', 'NOTE_ADDED', 'dev-mb', 't96-7', clock_timestamp() + interval '1 second');
    insert into _c values ('B medic writes on Y', 'yes', 'yes');
  exception when others then insert into _c values ('B medic writes on Y', 'no: ' || sqlerrm, 'yes'); end;
  execute 'reset role';

  -- ---- Release B: read-only
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  j := public.release_incident_unit(Y, CB, 'done', 'dev-cc', 't96-rl');
  insert into _c values ('release: B memberships read-only', j->>'memberships_read_only', '2');
  execute 'reset role';
  foreach s in array array[PCB::text, MB::text] loop
    perform set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    insert into _c values ('after release: view/full (' || (select role::text from profiles where id = s::uuid) || ')',
      app.can_view_incident(Y)::text || '/' || app.can_access_incident(Y)::text, 'true/false');
    execute 'reset role';
  end loop;

  -- ---- Hand Y to B: B comes back full, A read-only
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  j := public.handover_incident_unit(Y, CB, 'B takes it', 'dev-cc', 't96-ho2');
  insert into _c values ('Y handover restores B memberships', j->>'memberships_restored', '2');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', MB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into _c values ('B medic full on Y again', app.can_access_incident(Y)::text, 'true');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', PCA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into _c values ('A PC read-only on Y', app.can_view_incident(Y)::text || '/' || app.can_access_incident(Y)::text, 'true/false');
  execute 'reset role';

  -- ---- Physician (unit manager, not cc) may not hand over
  update profiles set role = 'physician' where id = PCB;
  perform set_config('request.jwt.claims', json_build_object('sub', PCB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.reinforce_incident_unit(X, CA, 'x');
    insert into _c values ('physician refused', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('physician refused', 'refused', 'refused'); end;
  execute 'reset role';

  select string_agg(case when got = want then 'ok   ' else 'FAIL ' end || label || ': got ' || got || ', want ' || want, E'\n'),
         count(*) filter (where got is distinct from want)
    into r, fails from _c;
  raise exception E'096 test (rolled back)\n%\nfailures: %', r, fails;
end
$test$;
