-- Rolled-back test for database/096 and 097 (CC moves a site to another company / reinforces it, WP-27;
-- relief before read-only, owner 2026-11-22).
-- Run after 095, 096 and 097 are applied, through the Supabase connector's execute_sql (not pasted into
-- the SQL editor from a phone: a long paste was cut off once, database/090). It ends with an error on purpose so
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
  LG uuid := (select id from profiles where role = 'logistics_officer' and is_active order by created_at limit 1);
  ADM uuid := (select id from profiles where role = 'admin' and is_active order by created_at limit 1);
  Z uuid := gen_random_uuid();   -- target of a merge
  CA uuid; CB uuid; PA1 uuid;
  X uuid := gen_random_uuid();   -- site handed over from A to B
  Y uuid := gen_random_uuid();   -- site A keeps, B reinforces
  P1 uuid := gen_random_uuid();
  t0 timestamptz := now() - interval '20 minutes';
  t_ho timestamptz;
  r text := ''; fails int := 0; n bigint; s text; ok boolean; j jsonb; j_id uuid;
begin
  -- Each check: (label, got, want). now() is fixed for the whole transaction, so records meant to be
  -- "after the change" use clock_timestamp().
  create temp table if not exists _c(label text, got text, want text);  -- rolled back with the rest
  grant all on _c to authenticated;
  -- Live, `authenticated` cannot name the app schema (policies reach it without a name lookup), so
  -- the checks call the helpers through these wrappers; they vanish with the rolled-back transaction.
  create function pg_temp.t96_access(p uuid) returns boolean language sql stable security definer
    as 'select app.can_access_incident(p)';
  create function pg_temp.t96_view(p uuid) returns boolean language sql stable security definer
    as 'select app.can_view_incident(p)';

  insert into companies(name) values ('TEST96-A') returning id into CA;
  insert into companies(name) values ('TEST96-B') returning id into CB;
  insert into platoons(company_id, name) values (CA, 'TEST96-A1') returning id into PA1;
  update profiles set role = 'pc' where id = PCB;
  -- A logistics officer is never placed in a company (live app.guard_profile_unit); he reaches a
  -- site as a member only.
  update profiles set company_id = CA, platoon_id = null where id in (PCA, MA, MA2, RCCA);
  update profiles set company_id = null, platoon_id = PA1 where id = RPCA;
  update profiles set company_id = CB, platoon_id = null where id in (PCB, MB);
  insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, status, opened_at, company_id, platoon_id) values
    (X, 'TEST96-X', t0, t0, 'TEST96 X', 'active', t0, CA, PA1),
    (Y, 'TEST96-Y', t0, t0, 'TEST96 Y', 'active', t0, CA, null);
  update incidents set opened_by = MA where id = X;
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values
    (X, PCA, 'pc', PCA), (X, MA, 'medic', PCA), (Y, PCA, 'pc', PCA), (Y, MA, 'medic', PCA), (X, LG, 'logistics_officer', PCA);
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
  t_ho := (j->>'changed_at')::timestamptz;
  insert into _c values ('A medical staff wait for relief (PC + medic)', j->>'relief_pending', '2');
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

  -- ---- A medic before his relief: still writes
  perform set_config('request.jwt.claims', json_build_object('sub', MA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
    values (X, MA, 'medic', 'NOTE_ADDED', 'dev-ma', 't96-2a', clock_timestamp());
    insert into _c values ('A medic writes until relieved', 'yes', 'yes');
  exception when others then insert into _c values ('A medic writes until relieved', 'no: ' || sqlerrm, 'yes'); end;
  j := public.get_incident_unit_links(X);
  insert into _c values ('A medic access label before relief', j->>'my_access', 'relief_pending');
  execute 'reset role';

  -- Who is told someone still waits: the site's PC (now B) and the CC, not A's medic.
  perform set_config('request.jwt.claims', json_build_object('sub', PCB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.list_pending_reliefs() where incident_id = X;
  insert into _c values ('B PC (site PC) sees who waits for relief', n::text, '2');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.list_pending_reliefs() where incident_id = X;
  insert into _c values ('CC sees who waits for relief', n::text, '2');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', MA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.list_pending_reliefs();
  insert into _c values ('a medic gets no relief list', n::text, '0');
  execute 'reset role';

  -- Only he, his PC or the CC confirm his relief.
  perform set_config('request.jwt.claims', json_build_object('sub', PCB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.confirm_incident_relief(X, MA);
    insert into _c values ('B PC confirms A medic''s relief', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('B PC confirms A medic''s relief', 'refused', 'refused'); end;
  execute 'reset role';

  -- A's PC (kept as a member, waiting for relief himself) confirms for his medic.
  perform set_config('request.jwt.claims', json_build_object('sub', PCA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  j := public.get_incident_unit_links(X);
  insert into _c values ('A PC sees his people waiting', jsonb_array_length(j->'relief_pending')::text, '2');
  j := public.confirm_incident_relief(X, MA, 'dev-pca', 't96-rel-ma');
  t_ho := (j->>'read_only_since')::timestamptz;
  begin
    perform public.confirm_incident_relief(X, MA);
    insert into _c values ('relief confirmed twice', 'allowed', 'refused');
  exception when others then insert into _c values ('relief confirmed twice', 'refused', 'refused'); end;
  -- The flag of confirm_incident_relief is cleared after its write (same transaction).
  insert into _c values ('flag cleared after confirm_incident_relief', coalesce(current_setting('app.membership_relief_via_rpc', true), ''), '');
  execute 'reset role';
  select count(*) into n from events where incident_id = X and type = 'INCIDENT_UNIT_RELIEF_CONFIRMED';
  insert into _c values ('relief event written', n::text, '1');

  -- ---- A medic after relief: reads, cannot write now, records from before still accepted
  perform set_config('request.jwt.claims', json_build_object('sub', MA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from patients where incident_id = X;
  insert into _c values ('A medic reads patients', n::text, '1');
  select count(*) into n from events where incident_id = X;
  insert into _c values ('A medic pulls events', (n > 0)::text, 'true');
  begin
    insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
    values (X, MA, 'medic', 'NOTE_ADDED', 'dev-ma', 't96-2', clock_timestamp() + interval '1 second');
    insert into _c values ('A medic new record refused after relief', 'accepted', 'refused');
  exception when insufficient_privilege then insert into _c values ('A medic new record refused after relief', 'refused', 'refused'); end;
  begin
    insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
    values (X, MA, 'medic', 'NOTE_ADDED', 'dev-ma', 't96-3', t_ho - interval '2 minutes');
    insert into _c values ('A medic offline record from before relief accepted', 'accepted', 'accepted');
  exception when others then insert into _c values ('A medic offline record from before relief accepted', 'refused: ' || sqlerrm, 'accepted'); end;
  begin
    insert into patients (id, incident_id, visual_id, t_injury, created_by) values (gen_random_uuid(), X, 'T96-LATE', t_ho - interval '1 minute', MA);
    insert into _c values ('A medic offline patient from before relief accepted', 'accepted', 'accepted');
  exception when others then insert into _c values ('A medic offline patient from before relief accepted', 'refused: ' || sqlerrm, 'accepted'); end;
  begin
    insert into patients (id, incident_id, visual_id, t_injury, created_by) values (gen_random_uuid(), X, 'T96-NEW', clock_timestamp() + interval '1 second', MA);
    insert into _c values ('A medic new patient refused', 'accepted', 'refused');
  exception when insufficient_privilege then insert into _c values ('A medic new patient refused', 'refused', 'refused'); end;
  j := public.get_incident_unit_links(X);
  insert into _c values ('A medic access label after relief', j->>'my_access', 'read_only');
  begin
    perform public.update_patient_identity(P1, 'x', 'x');
    insert into _c values ('A medic after relief changes patient identity', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('A medic after relief changes patient identity', 'refused', 'refused'); end;
  begin
    perform public.cancel_incident_false_alarm(X, 'x');
    insert into _c values ('A medic (opener) cancels the handed-over site', 'allowed', 'refused');
  exception when insufficient_privilege then
    insert into _c values ('A medic (opener) cancels the handed-over site', case when sqlerrm like 'no write access%' then 'refused' else 'refused for another reason: ' || sqlerrm end, 'refused'); end;
  select count(*) into n from public.list_open_incidents() where id = X and read_only;
  insert into _c values ('A medic list shows X read-only', n::text, '1');
  execute 'reset role';

  -- ---- A's PC, still waiting for relief: writes, but assigns nobody new
  perform set_config('request.jwt.claims', json_build_object('sub', PCA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.list_open_incidents() where id = X and not read_only;
  insert into _c values ('A PC list: full while waiting', n::text, '1');
  begin
    insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
    values (X, PCA, 'pc', 'NOTE_ADDED', 'dev-pca', 't96-4', clock_timestamp());
    insert into _c values ('A PC writes while waiting', 'yes', 'yes');
  exception when others then insert into _c values ('A PC writes while waiting', 'no: ' || sqlerrm, 'yes'); end;
  begin
    insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values (X, MA2, 'medic', PCA);
    insert into _c values ('A PC assigns another medic while waiting', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('A PC assigns another medic while waiting', 'refused', 'refused'); end;
  select count(*) into n from public.list_incident_unit_notices();
  insert into _c values ('A PC gets no notice', n::text, '0');
  execute 'reset role';

  -- ---- Logistics (owner 2026-11-26: part of the company and its sites, never relieved)
  perform set_config('request.jwt.claims', json_build_object('sub', LG, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from public.list_open_incidents() where id = Y and read_only;
  insert into _c values ('logistics: a site he is not on is not marked read-only', n::text, '0');
  insert into _c values ('logistics of A on the handed-over site: still full', pg_temp.t96_access(X)::text, 'true');
  execute 'reset role';
  select (relief_pending_since is null and read_only_since is null)::text into s from incident_memberships where incident_id = X and profile_id = LG;
  insert into _c values ('logistics of A: never waits for relief', s, 'true');

  -- ---- A's rescue chain: read-only at once
  foreach s in array array[RCCA::text, RPCA::text] loop
    perform set_config('request.jwt.claims', json_build_object('sub', s, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    insert into _c values ('A rescue chain view/full (' || (select role::text from profiles where id = s::uuid) || ')',
      pg_temp.t96_view(X)::text || '/' || pg_temp.t96_access(X)::text, 'true/false');
    execute 'reset role';
  end loop;

  -- ---- New PC B: full, told once, assigns his medic
  perform set_config('request.jwt.claims', json_build_object('sub', PCB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select pg_temp.t96_access(X)::text into s;
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

  -- ---- Admin ends A's access (admin runs every 096 function; owner 2026-11-26)
  perform set_config('request.jwt.claims', json_build_object('sub', ADM, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  j := public.end_incident_unit_access(X, CA, 'dev-adm', 't96-end');
  insert into _c values ('flag cleared after end_incident_unit_access', coalesce(current_setting('app.membership_relief_via_rpc', true), ''), '');
  insert into _c values ('A members ended (PC still waiting is relieved too)', j->>'members_ended', '2');
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
    values (X, MA, 'medic', 'NOTE_ADDED', 'dev-ma', 't96-6', t_ho - interval '3 minutes') returning id into j_id; -- read back, as sync-log does
    insert into _c values ('after end: record from before still accepted', 'accepted', 'accepted');
    -- sync-log's dependency check: the author still finds his own earlier record.
    select count(*) into n from events where device_id = 'dev-ma' and local_event_id = 't96-3';
    insert into _c values ('after end: author finds his own earlier record (dependency check)', n::text, '1');
    select count(*) into n from events where incident_id = X and actor_id is distinct from MA;
    insert into _c values ('after end: nobody else''s records readable', n::text, '0');
  begin
    perform public.get_incident_aar_reports(X);
    insert into _c values ('after end: stored reports refused', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('after end: stored reports refused', 'refused', 'refused'); end;
  exception when others then insert into _c values ('after end: record from before still accepted', 'refused: ' || sqlerrm, 'accepted'); end;
  execute 'reset role';

  -- ---- Reinforce Y with B; A stays
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  j := public.reinforce_incident_unit(Y, CB, 'more hands', 'dev-cc', 't96-rf');
  insert into _c values ('flag cleared after reinforce_incident_unit', coalesce(current_setting('app.membership_relief_via_rpc', true), ''), '');
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
  select pg_temp.t96_access(Y)::text into s;
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

  -- ---- Admin releases B: read-only
  perform set_config('request.jwt.claims', json_build_object('sub', ADM, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  j := public.release_incident_unit(Y, CB, 'done', 'dev-cc', 't96-rl');
  insert into _c values ('flag cleared after release_incident_unit', coalesce(current_setting('app.membership_relief_via_rpc', true), ''), '');
  insert into _c values ('release: B PC and medic wait for relief', j->>'relief_pending', '2');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', MB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into _c values ('after release, before relief: B medic full', pg_temp.t96_access(Y)::text, 'true');
  perform public.confirm_incident_relief(Y, null, 'dev-mb', 't96-rel-mb');
  insert into _c values ('B medic relieved himself: view/full', pg_temp.t96_view(Y)::text || '/' || pg_temp.t96_access(Y)::text, 'true/false');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', PCB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into _c values ('B PC not relieved yet: full', pg_temp.t96_access(Y)::text, 'true');
  execute 'reset role';

  -- ---- Closed site: a relieved member does not read his own records back (068 hides patient data)
  -- Live, incidents close only through close_incident() (app.guard_incident_close); the test uses its flag.
  perform set_config('app.incident_close_via_rpc', 'on', true);
  update incidents set status = 'closed', closed_at = now() where id = Y;
  perform set_config('app.incident_close_via_rpc', '', true);
  perform set_config('request.jwt.claims', json_build_object('sub', MB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from events where incident_id = Y;
  insert into _c values ('closed site: relieved member reads no records back', n::text, '0');
  execute 'reset role';
  perform set_config('app.incident_close_via_rpc', 'on', true);
  update incidents set status = 'active', closed_at = null where id = Y;
  perform set_config('app.incident_close_via_rpc', '', true);

  -- ---- A relabelled membership does not escape relief (review 2026-11-26): MA's Y row says logistics.
  update incident_memberships set role_at_incident = 'logistics_officer' where incident_id = Y and profile_id = MA;

  -- ---- Admin hands Y to B: B comes back full, A read-only
  perform set_config('request.jwt.claims', json_build_object('sub', ADM, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  j := public.handover_incident_unit(Y, CB, 'B takes it', 'dev-cc', 't96-ho2');
  insert into _c values ('flag cleared after handover_incident_unit', coalesce(current_setting('app.membership_relief_via_rpc', true), ''), '');
  insert into _c values ('Y handover restores B memberships', j->>'memberships_restored', '2');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', MB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into _c values ('B medic full on Y again', pg_temp.t96_access(Y)::text, 'true');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', PCA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  insert into _c values ('A PC on Y after handover: waits for relief', (public.get_incident_unit_links(Y))->>'my_access', 'relief_pending');
  execute 'reset role';
  select (relief_pending_since is not null)::text into s from incident_memberships where incident_id = Y and profile_id = MA;
  insert into _c values ('relabelled medic still waits for relief', s, 'true');

  -- ---- Relief fields (owner 2026-11-26): only the CC, chamal or admin edit them directly; a PC who
  -- re-assigns his own medic gives him full access back.
  update incident_memberships set read_only_since = now() - interval '5 minutes', access_ended_at = now()
  where incident_id = Y and profile_id = MB;                        -- MB ended on Y (as postgres)
  perform set_config('request.jwt.claims', json_build_object('sub', PCB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update incident_memberships set access_ended_at = null where incident_id = Y and profile_id = MB;
    insert into _c values ('PC edits a relief field directly', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('PC edits a relief field directly', case when sqlerrm like '%relief fields%' then 'refused' else 'refused elsewhere: ' || sqlerrm end, 'refused'); end;
  -- Same shape as the app's assign upsert (index.html, assign flow): it always sends a fresh created_at.
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by, created_at) values (Y, MB, 'medic', PCB, clock_timestamp())
  on conflict (incident_id, profile_id) do update set assigned_by = excluded.assigned_by, role_at_incident = excluded.role_at_incident, created_at = excluded.created_at;
  execute 'reset role';
  select (read_only_since is null and access_ended_at is null)::text into s from incident_memberships where incident_id = Y and profile_id = MB;
  insert into _c values ('PC re-assigns his ended medic: access back', s, 'true');
  select count(*) into n from unit_audit where target_incident_id = Y and target_profile_id = MB and detail->>'kind' = 'access_restored_by_assignment' and detail ? 'before';
  insert into _c values ('PC re-assign written to unit_audit', n::text, '1');
  -- A's PC on the site his company handed over cannot restore his medic (policy: not his site any more).
  perform set_config('request.jwt.claims', json_build_object('sub', PCA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values (X, MA, 'medic', PCA)
    on conflict (incident_id, profile_id) do update set assigned_by = excluded.assigned_by;
    insert into _c values ('A PC restores his medic on the handed-over site', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('A PC restores his medic on the handed-over site', 'refused', 'refused'); end;
  execute 'reset role';
  -- Admin has every right the CC has (owner 2026-11-26, "admin should have all permissions").
  update incident_memberships set read_only_since = now() - interval '5 minutes' where incident_id = Y and profile_id = MB;
  perform set_config('request.jwt.claims', json_build_object('sub', ADM, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update incident_memberships set access_ended_at = now() where incident_id = Y and profile_id = MB;
    insert into _c values ('admin edits a relief field directly', 'allowed', 'allowed');
  exception when others then insert into _c values ('admin edits a relief field directly', 'refused: ' || sqlerrm, 'allowed'); end;
  execute 'reset role';
  select count(*) into n from unit_audit where target_incident_id = Y and target_profile_id = MB and detail->>'kind' = 'relief_fields_edited'
    and detail->>'by_role' = 'admin' and detail->'before'->>'access_ended_at' is null and detail->'after'->>'access_ended_at' is not null;
  insert into _c values ('admin direct edit audited with before and after', n::text, '1');
  perform set_config('request.jwt.claims', json_build_object('sub', ADM, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update incident_memberships set assigned_by = ADM, created_at = clock_timestamp() where incident_id = Y and profile_id = MB;
    insert into _c values ('admin re-assigns a relieved medic', 'allowed', 'allowed');
  exception when others then insert into _c values ('admin re-assigns a relieved medic', 'refused: ' || sqlerrm, 'allowed'); end;
  begin
    insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by, read_only_since) values (Y, MA2, 'medic', ADM, now());
    insert into _c values ('admin inserts a membership with relief fields', 'allowed', 'allowed');
  exception when others then insert into _c values ('admin inserts a membership with relief fields', 'refused: ' || sqlerrm, 'allowed'); end;
  execute 'reset role';
  select (read_only_since is null and access_ended_at is null)::text into s from incident_memberships where incident_id = Y and profile_id = MB;
  insert into _c values ('admin re-assign: access back', s, 'true');
  select count(*) into n from unit_audit where target_incident_id = Y and target_profile_id = MA2 and detail->>'kind' = 'relief_fields_set'
    and detail->'before' = 'null'::jsonb and detail->'after'->>'read_only_since' is not null;
  insert into _c values ('admin insert with relief fields audited with after', n::text, '1');
  -- Chamal removes the row admin just inserted (a role swap stands in for a chamal account).
  update profiles set role = 'chamal' where id = RCCA;
  perform set_config('request.jwt.claims', json_build_object('sub', RCCA, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    delete from incident_memberships where incident_id = Y and profile_id = MA2;
    get diagnostics n = row_count;
    insert into _c values ('chamal removes a membership with relief fields', n::text, '1');
  exception when others then insert into _c values ('chamal removes a membership with relief fields', 'refused: ' || sqlerrm, '1'); end;
  execute 'reset role';
  update profiles set role = 'rcc' where id = RCCA;
  select count(*) into n from unit_audit where target_incident_id = Y and target_profile_id = MA2 and detail->>'kind' = 'membership_with_relief_removed'
    and detail->>'by_role' = 'chamal' and detail->'before'->>'read_only_since' is not null;
  insert into _c values ('chamal removal audited with before', n::text, '1');
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  update incident_memberships set relieved_by = CC where incident_id = Y and profile_id = MB;
  get diagnostics n = row_count;
  insert into _c values ('CC edits a relief field directly', n::text, '1');
  select count(*) into n from unit_audit where target_incident_id = Y and target_profile_id = MB and detail->>'kind' = 'relief_fields_edited' and detail->>'by_role' = 'cc';
  insert into _c values ('CC direct edit written to unit_audit', n::text, '1');
  execute 'reset role';
  update incident_memberships set relieved_by = null where incident_id = Y and profile_id = MB;

  -- ---- Physician (unit manager, not cc) may not move or reinforce a site (reinforce tried here)
  update profiles set role = 'physician' where id = PCB;
  perform set_config('request.jwt.claims', json_build_object('sub', PCB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    perform public.reinforce_incident_unit(X, CA, 'x');
    insert into _c values ('physician refused', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('physician refused', 'refused', 'refused'); end;
  begin
    update incident_memberships set read_only_since = now() where incident_id = Y and profile_id = MB;
    insert into _c values ('physician edits a relief field directly', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('physician edits a relief field directly', case when sqlerrm like '%relief fields%' then 'refused' else 'refused elsewhere: ' || sqlerrm end, 'refused'); end;
  execute 'reset role';
  -- A key change is a delete plus an insert (review 2026-11-26): moving a relieved row away and adding
  -- the medic back without relief fields must not work.
  update incident_memberships set read_only_since = now() - interval '5 minutes' where incident_id = Y and profile_id = MB;
  perform set_config('request.jwt.claims', json_build_object('sub', PCB, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update incident_memberships set profile_id = MA2 where incident_id = Y and profile_id = MB;
    insert into _c values ('physician moves a relieved row to another person', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('physician moves a relieved row to another person', case when sqlerrm like '%move a membership%' then 'refused' else 'refused elsewhere: ' || sqlerrm end, 'refused'); end;
  begin
    update incident_memberships set incident_id = X where incident_id = Y and profile_id = MB;
    insert into _c values ('physician moves a relieved row to another site', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('physician moves a relieved row to another site', case when sqlerrm like '%move a membership%' then 'refused' else 'refused elsewhere: ' || sqlerrm end, 'refused'); end;
  begin
    delete from incident_memberships where incident_id = Y and profile_id = MB;
    insert into _c values ('physician removes a relieved membership', 'allowed', 'refused');
  exception when insufficient_privilege then insert into _c values ('physician removes a relieved membership', case when sqlerrm like '%relief fields%' then 'refused' else 'refused elsewhere: ' || sqlerrm end, 'refused'); end;
  execute 'reset role';
  update incident_memberships set read_only_since = null where incident_id = Y and profile_id = MB;

  -- ---- Merge: a read-only or ended member of the duplicate gets no access to the target, a wait for
  -- relief moves with the person. Needs the full live schema, so it runs only where merge can run.
  if to_regclass('public.tourniquets') is not null then
    insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, status, opened_at, company_id)
    values (Z, 'TEST96-Z', t0, t0, 'TEST96 Z', 'active', t0, CB);
    update incident_memberships set relief_pending_since = now() where incident_id = Y and profile_id = PCA and read_only_since is null;
    -- MA is then only ended (on X); PCA is on both: ended on X, waiting for relief on Y. X is merged
    -- first, so PCA's ended copy reaches Z first and his full Y membership must win (database/097).
    delete from incident_memberships where incident_id = Y and profile_id = MA;
    perform set_config('request.jwt.claims', json_build_object('sub', ADM, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    perform public.merge_incident(X, Z, 'duplicate', 'dev-adm', 't96-merge');
    perform public.merge_incident(Y, Z, 'duplicate', 'dev-cc', 't96-merge2');
    insert into _c values ('flag cleared after merge_incident', coalesce(current_setting('app.membership_relief_via_rpc', true), ''), '');
    execute 'reset role';
    select count(*) into n from incident_memberships where incident_id = Z and profile_id = MA and access_ended_at is not null and read_only_since is not null;
    insert into _c values ('merge: ended member copied for late records only', n::text, '1');
    perform set_config('request.jwt.claims', json_build_object('sub', MA, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
    insert into _c values ('merge: ended member does not see the target', pg_temp.t96_view(Z)::text, 'false');
    begin
      insert into events (incident_id, actor_id, actor_role, type, device_id, local_event_id, local_timestamp)
      values (Z, MA, 'medic', 'NOTE_ADDED', 'dev-ma', 't96-merge-late', t_ho - interval '4 minutes') returning id into j_id;
      insert into _c values ('merge: record from before relief accepted at the target', 'accepted', 'accepted');
    exception when others then insert into _c values ('merge: record from before relief accepted at the target', 'refused: ' || sqlerrm, 'accepted'); end;
    execute 'reset role';
    select count(*) into n from incident_memberships where incident_id = Z and profile_id = PCA and relief_pending_since is not null and read_only_since is null;
    insert into _c values ('merge: wait for relief moves with the person, also over an ended copy (097)', n::text, '1');
  end if;

  select string_agg(case when got = want then 'ok   ' else 'FAIL ' end || label || ': got ' || got || ', want ' || want, E'\n'),
         count(*) filter (where got is distinct from want)
    into r, fails from _c;
  raise exception E'096 test (rolled back)\n%\nfailures: %', r, fails;
end
$test$;
