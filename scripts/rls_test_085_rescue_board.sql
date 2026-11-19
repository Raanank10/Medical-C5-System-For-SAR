-- Rolled-back test for database/085 (RCC panel, V2.99.76). Run in the Supabase SQL editor after
-- 085 is applied. It ends with an error on purpose so nothing persists; the error text is the
-- result. Run live on 2026-11-19 right after 085 was applied: every item as wanted.
-- Every item should start with "ok" or show the expected value.
-- Uses the synthetic test accounts of the live project, looked up by role; every unit, site,
-- patient and event it needs is created inside the block and rolled back.
do $test$
declare
  RCC  uuid := (select id from profiles where role = 'rcc' and is_active order by created_at limit 1);
  PC   uuid := (select id from profiles where role = 'pc' and is_active order by created_at limit 1);
  M1   uuid := (select id from profiles where role = 'medic' and is_active order by created_at limit 1);
  X uuid := gen_random_uuid();
  P_STILL uuid := gen_random_uuid();  -- trapped now
  P_FREED uuid := gen_random_uuid();  -- was trapped (event), freed, at the evacuation point
  P_PART  uuid := gen_random_uuid();  -- partially trapped now
  P_NEVER uuid := gen_random_uuid();  -- never trapped, on the way to the evacuation point
  P_HOSP  uuid := gen_random_uuid();  -- was trapped (event), handed over
  P_BLOCK uuid := gen_random_uuid();  -- "אין גישה" now
  P_FR    uuid := gen_random_uuid();  -- reported trapped by a first responder (access unknown)
  CA uuid; A1 uuid;
  r text := ''; n bigint; s text; j jsonb;
begin
  insert into companies(name, kind) values ('TEST85-CO', 'rescue') returning id into CA;
  insert into platoons(company_id, name) values (CA, 'A1') returning id into A1;
  update profiles set company_id = CA, platoon_id = null where id in (RCC, PC);
  update profiles set platoon_id = A1, company_id = null where id = M1;
  insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, status, opened_at, company_id, platoon_id)
    values (X, 'TEST85-X', now(), now(), 'TEST85 X', 'active', now(), CA, A1);
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values (X, M1, 'medic', PC);
  insert into patients (id, incident_id, visual_id, t_injury, current_triage, current_status, access_status, created_by)
    values (P_STILL, X, 'T85-STILL', now(), 'red',    'identified', 'trapped', M1),
           (P_FREED, X, 'T85-FREED', now(), 'yellow', 'evacuating', 'free',    M1),
           (P_PART,  X, 'T85-PART',  now(), 'pending', 'identified', 'partial', M1),
           (P_NEVER, X, 'T85-NEVER', now(), 'green',  'evacuating', 'free',    M1),
           (P_HOSP,  X, 'T85-HOSP',  now(), 'red',    'handed_over','free',    M1),
           (P_BLOCK, X, 'T85-BLOCK', now(), 'pending', 'identified', 'blocked', M1),
           (P_FR,    X, 'T85-FR',    now(), 'pending', 'identified', 'unknown', RCC);
  update patients set evac_point_arrived_at = now() where id = P_FREED;
  insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, P_FREED, M1, 'medic', 'PATIENT_ACCESS_UPDATED', '{"trap_status":"trapped","access_status":"trapped"}', 'test85-dev', 'test85-1', now() - interval '30 minutes'),
    (X, P_FREED, M1, 'medic', 'PATIENT_ACCESS_UPDATED', '{"trap_status":"not_trapped","access_status":"free"}', 'test85-dev', 'test85-2', now() - interval '10 minutes'),
    (X, P_HOSP,  M1, 'medic', 'PATIENT_ACCESS_UPDATED', '{"access_status":"partial"}', 'test85-dev', 'test85-3', now() - interval '40 minutes'),
    (X, P_FR,    RCC, 'rcc',  'FIRST_RESPONDER_REPORT', '{"visual_id":"T85-FR","trapped":true}', 'test85-dev', 'test85-4', now() - interval '20 minutes');
  -- The access trigger projects these events onto patients.access_status; put the final values back.
  update patients set access_status = 'free' where id in (P_FREED, P_HOSP);

  select access_status::text into s from patients where id = P_FR; r := r || 'first responder trapped -> ' || s || ' (want trapped); ';

  -- rcc of the company: the board carries was_trapped and evac_point_arrived_at
  perform set_config('request.jwt.claims', json_build_object('sub', RCC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from get_rescue_patient_board(X); r := r || 'rcc board X=' || n || ' (want 7); ';
  select string_agg(visual_id || ':' || was_trapped::text, ',' order by visual_id) into s from get_rescue_patient_board(X);
  r := r || 'was_trapped ' || s || ' (want BLOCK:true,FR:true,FREED:true,HOSP:true,NEVER:false,PART:true,STILL:true); ';
  select string_agg(visual_id || ':' || (evac_point_arrived_at is not null)::text, ',' order by visual_id) into s
    from get_rescue_patient_board(X) where evac_state = 'evacuating';
  r := r || 'at point ' || s || ' (want FREED:true,NEVER:false); ';
  select count(*) into n from get_rescue_patient_board(X) where evac_state = 'evacuated' and evac_point_arrived_at is not null;
  r := r || 'arrival hidden after evacuation=' || n || ' (want 0); ';
  begin perform app.rescue_patient_was_trapped(P_STILL, 'trapped'); r := r || 'FAIL rcc called the helper directly; ';
  exception when others then r := r || 'ok helper not callable; '; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  -- the stored report's rescue section
  j := app.build_incident_aar(X)->'rescue';
  r := r || 'report rescue ' || coalesce(j::text, 'null')
         || ' (want total 7, ever_trapped 6, extracted 2, trapped_at_close 4, at_evac_point_at_close 1, evacuated 1); ';
  r := r || case when app.build_incident_aar(X) ? 'external_reports' then 'ok 069 section kept; ' else 'FAIL 069 section lost; ' end;

  -- Last, as it changes the counts above: a blocked status sent by a phone is projected by 041's cast.
  insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, P_NEVER, M1, 'medic', 'PATIENT_ACCESS_UPDATED', '{"trap_status":"access_blocked","access_status":"blocked","source":"access_sync"}', 'test85-dev', 'test85-5', now());
  select access_status::text into s from patients where id = P_NEVER; r := r || 'access_sync blocked -> ' || s || ' (want blocked); ';

  -- "חולץ": PATIENT_EXTRACTED from the RCC frees the casualty and sends it to the evacuation point.
  insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, P_STILL, RCC, 'rcc', 'PATIENT_EXTRACTED', '{"trap_status":"not_trapped","access_status":"free","next":"evac_point"}', 'test85-dev', 'test85-6', now());
  select access_status::text || '/' || current_status::text || '/' || coalesce(evac_point_arrived_at::text, 'no arrival') || '/' || coalesce(status_set_by_role::text, '-')
    into s from patients where id = P_STILL;
  r := r || 'extracted -> ' || s || ' (want free/evacuating/no arrival/rcc); ';
  -- Already at the evacuation point: only the access changes, the arrival stays.
  insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, P_FREED, RCC, 'rcc', 'PATIENT_EXTRACTED', '{}', 'test85-dev', 'test85-7', now());
  select current_status::text || '/' || (evac_point_arrived_at is not null)::text into s from patients where id = P_FREED;
  r := r || 'extracted at the point -> ' || s || ' (want evacuating/true); ';
  -- A medic's PATIENT_EXTRACTED (sync-log never lets it through; a direct insert) changes nothing.
  insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, P_PART, M1, 'medic', 'PATIENT_EXTRACTED', '{}', 'test85-dev', 'test85-8', now());
  select access_status::text || '/' || current_status::text into s from patients where id = P_PART;
  r := r || 'medic extraction ignored -> ' || s || ' (want partial/identified); ';

  -- No restore needed: the exception below rolls back every change, profiles included.
  raise exception 'TEST85 RESULT: %', r;
end
$test$;
