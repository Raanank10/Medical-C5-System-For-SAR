-- Rolled-back test for database/086 and 087 (extraction needs a medic; rescue calls a medic).
-- Run in the Supabase SQL editor after both are applied. It ends with an error on purpose so
-- nothing persists; the error text is the result. Every item should show the expected value.
-- Uses the synthetic test accounts of the live project, looked up by role.
do $test$
declare
  RCC uuid := (select id from profiles where role = 'rcc' and is_active order by created_at limit 1);
  PC  uuid := (select id from profiles where role = 'pc' and is_active order by created_at limit 1);
  M1  uuid := (select id from profiles where role = 'medic' and is_active order by created_at limit 1);
  X uuid := gen_random_uuid();
  P_SORTED uuid := gen_random_uuid();   -- red, trapped, incident 30 min old: rescue may extract
  P_UNSORT uuid := gen_random_uuid();   -- pending, trapped: a medic checks first
  P_LONG   uuid := gen_random_uuid();   -- green, trapped, in incident Y (90 min old): medic present
  Y uuid := gen_random_uuid();
  CA uuid; A1 uuid;
  r text := ''; s text; n bigint;
begin
  insert into companies(name, kind) values ('TEST86-CO', 'rescue') returning id into CA;
  insert into platoons(company_id, name) values (CA, 'A1') returning id into A1;
  update profiles set company_id = CA, platoon_id = null where id in (RCC, PC);
  update profiles set platoon_id = A1, company_id = null where id = M1;
  insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, status, opened_at, company_id, platoon_id) values
    (X, 'TEST86-X', now() - interval '30 minutes', now(), 'TEST86 X', 'active', now() - interval '30 minutes', CA, A1),
    (Y, 'TEST86-Y', now() - interval '90 minutes', now(), 'TEST86 Y', 'active', now() - interval '90 minutes', CA, A1);
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values (X, M1, 'medic', PC), (Y, M1, 'medic', PC);
  insert into patients (id, incident_id, visual_id, t_injury, current_triage, current_status, access_status, created_by) values
    (P_SORTED, X, 'T86-SORTED', now(), 'red',     'identified', 'trapped', M1),
    (P_UNSORT, X, 'T86-UNSORT', now(), 'pending', 'identified', 'trapped', M1),
    (P_LONG,   Y, 'T86-LONG',   now(), 'green',   'identified', 'blocked', M1);

  insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, P_SORTED, RCC, 'rcc', 'PATIENT_EXTRACTED', '{}', 'test86-dev', 'test86-1', now()),
    (X, P_UNSORT, RCC, 'rcc', 'PATIENT_EXTRACTED', '{}', 'test86-dev', 'test86-2', now()),
    (Y, P_LONG,   RCC, 'rcc', 'PATIENT_EXTRACTED', '{}', 'test86-dev', 'test86-3', now());
  select access_status::text || '/' || current_status::text into s from patients where id = P_SORTED;
  r := r || 'sorted, 30 min -> ' || s || ' (want free/evacuating); ';
  select access_status::text || '/' || current_status::text into s from patients where id = P_UNSORT;
  r := r || 'unsorted -> ' || s || ' (want trapped/identified); ';
  select access_status::text || '/' || current_status::text into s from patients where id = P_LONG;
  r := r || '90 min, no access -> ' || s || ' (want blocked/identified); ';

  -- 087: the RCC calls a medic; a medic of the incident reads it, a PC closes it.
  insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, null, RCC, 'rcc', 'MEDICAL_REINFORCEMENT_REQUESTED',
     jsonb_build_object('id', 'REQ-T86', 'resourceType', 'extraction_medic', 'urgency', 'high', 'reasonCodes', jsonb_build_array('unsorted_trapped'),
                        'linkedPatientIds', jsonb_build_array(P_UNSORT::text), 'targetLocation', 'T86-UNSORT'), 'test86-dev', 'test86-4', now()),
    (X, null, RCC, 'rcc', 'MEDICAL_REINFORCEMENT_REQUESTED',
     jsonb_build_object('id', 'REQ-T86-B', 'resourceType', 'paramedic'), 'test86-dev', 'test86-5', now());
  select count(*) into n from medical_resource_requests where incident_id = X and resource_type = 'extraction_medic' and requested_by_role::text = 'rcc';
  r := r || 'rcc extraction request rows=' || n || ' (want 1); ';
  select count(*) into n from medical_resource_requests where incident_id = X and resource_type = 'paramedic';
  r := r || 'rcc other resource rows=' || n || ' (want 0); ';

  perform set_config('request.jwt.claims', json_build_object('sub', M1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from medical_resource_requests where incident_id = X;
  r := r || 'medic reads calls=' || n || ' (want 1); ';
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  -- Option A: the medic marks the casualty extracted (access free): the call resolves itself.
  insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, P_UNSORT, M1, 'medic', 'PATIENT_ACCESS_UPDATED', '{"trap_status":"not_trapped","access_status":"free","source":"access_sync"}', 'test86-dev', 'test86-6', now() + interval '1 second');
  select status into s from medical_resource_requests where incident_id = X and resource_type = 'extraction_medic';
  r := r || 'extracted -> call ' || s || ' (want resolved); ';
  -- A call the RCC no longer needs: the requester cancels it.
  insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (Y, null, RCC, 'rcc', 'MEDICAL_REINFORCEMENT_REQUESTED',
     jsonb_build_object('id', 'REQ-T86-C', 'resourceType', 'extraction_medic', 'linkedPatientIds', jsonb_build_array(P_LONG::text)), 'test86-dev', 'test86-7', now()),
    (Y, null, RCC, 'rcc', 'MEDICAL_REINFORCEMENT_STATUS_UPDATED', '{"id":"REQ-T86-C","status":"cancelled"}', 'test86-dev', 'test86-8', now() + interval '1 second');
  select status into s from medical_resource_requests where incident_id = Y and resource_type = 'extraction_medic';
  r := r || 'requester cancels own -> ' || s || ' (want cancelled); ';

  -- No restore needed: the exception below rolls back every change, profiles included.
  raise exception 'TEST86-87 RESULT: %', r;
end
$test$;
