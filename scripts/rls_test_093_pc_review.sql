-- Rolled-back test for database/093 (PC review of a deteriorating casualty, WP-26).
-- Run in the Supabase SQL editor after 093 is applied. It ends with an error on purpose so nothing
-- persists; the error text is the result. Every item should show the expected value.
-- Uses the synthetic test accounts of the live project, looked up by role (two medics, a PC, a CC).
do $test$
declare
  M1 uuid := (select id from profiles where role = 'medic' and is_active order by created_at limit 1);
  M2 uuid := (select id from profiles where role = 'medic' and is_active order by created_at offset 1 limit 1);
  M3 uuid := (select id from profiles where role = 'medic' and is_active order by created_at offset 2 limit 1);
  PC uuid := (select id from profiles where role = 'pc' and is_active order by created_at limit 1);
  CC uuid := (select id from profiles where role = 'cc' and is_active order by created_at limit 1);
  X uuid := gen_random_uuid();   -- the incident
  Y uuid := gen_random_uuid();   -- another incident
  P1 uuid := gen_random_uuid();  -- red, deteriorating: both medics ask
  P2 uuid := gen_random_uuid();  -- yellow: one medic asks, closed with a bad outcome value
  PY uuid := gen_random_uuid();  -- a casualty of incident Y
  CA uuid;
  r text := ''; s text; n bigint; id1 uuid; id2 uuid; t0 timestamptz := now();
begin
  insert into companies(name, kind) values ('TEST93-CO', 'ambulance') returning id into CA;
  update profiles set company_id = CA where id in (PC);
  insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, status, opened_at, company_id) values
    (X, 'TEST93-X', t0, t0, 'TEST93 X', 'active', t0, CA),
    (Y, 'TEST93-Y', t0, t0, 'TEST93 Y', 'active', t0, null);
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by) values
    (X, M1, 'medic', PC), (X, M2, 'medic', PC), (X, M3, 'medic', PC), (Y, M1, 'medic', PC);
  insert into patients (id, incident_id, visual_id, t_injury, current_triage, current_status, created_by) values
    (P1, X, 'T93-P1', t0, 'red', 'identified', M1),
    (P2, X, 'T93-P2', t0, 'yellow', 'identified', M1),
    (PY, Y, 'T93-PY', t0, 'yellow', 'identified', M1);

  -- Creation: a medic's request for a casualty of the incident; nothing else makes a row.
  insert into events (incident_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, M1, 'medic', 'MEDICAL_REINFORCEMENT_REQUESTED', jsonb_build_object('id', 'REQ-T93-1', 'resourceType', 'pc_review', 'urgency', 'immediate',
       'reasonCodes', jsonb_build_array('red_worsening'), 'linkedPatientIds', jsonb_build_array(P1::text), 'freeText', 'SpO2 96->89'), 'dev-m1', 't93-1', t0),
    (X, M1, 'medic', 'MEDICAL_REINFORCEMENT_REQUESTED', jsonb_build_object('id', 'REQ-T93-BAD1', 'resourceType', 'pc_review', 'linkedPatientIds', jsonb_build_array(PY::text)), 'dev-m1', 't93-2', t0),
    (X, M1, 'medic', 'MEDICAL_REINFORCEMENT_REQUESTED', jsonb_build_object('id', 'REQ-T93-BAD2', 'resourceType', 'pc_review'), 'dev-m1', 't93-3', t0),
    (X, PC, 'pc', 'MEDICAL_REINFORCEMENT_REQUESTED', jsonb_build_object('id', 'REQ-T93-BAD3', 'resourceType', 'pc_review', 'linkedPatientIds', jsonb_build_array(P1::text)), 'dev-pc', 't93-4', t0),
    (X, M2, 'medic', 'MEDICAL_REINFORCEMENT_REQUESTED', jsonb_build_object('id', 'REQ-T93-2', 'resourceType', 'pc_review', 'urgency', 'high',
       'reasonCodes', jsonb_build_array('manual'), 'linkedPatientIds', jsonb_build_array(P1::text)), 'dev-m2', 't93-5', t0 + interval '10 seconds'),
    (X, M1, 'medic', 'MEDICAL_REINFORCEMENT_REQUESTED', jsonb_build_object('id', 'REQ-T93-3', 'resourceType', 'pc_review',
       'reasonCodes', jsonb_build_array('deterioration'), 'linkedPatientIds', jsonb_build_array(P2::text)), 'dev-m1', 't93-6', t0),
    (X, M1, 'medic', 'MEDICAL_REINFORCEMENT_REQUESTED', jsonb_build_object('id', 'REQ-T93-PARA', 'resourceType', 'paramedic', 'linkedPatientIds', jsonb_build_array(P1::text)), 'dev-m1', 't93-7', t0);
  select count(*) into n from medical_resource_requests where incident_id = X and request_kind = 'pc_review';
  r := r || 'pc_review rows=' || n || ' (want 3); ';
  select string_agg(origin_client_request_id, ',' order by origin_client_request_id) into s from medical_resource_requests where incident_id = X and request_kind = 'pc_review';
  r := r || 'ids=' || s || ' (want REQ-T93-1,REQ-T93-2,REQ-T93-3); ';
  select id, urgency || '/' || resource_type || '/' || (linked_patient_ids->>0 = P1::text)::text || '/' || (reason_codes->>0) into id1, s
    from medical_resource_requests where origin_client_request_id = 'REQ-T93-1';
  r := r || 'first row=' || s || ' (want immediate/pc_review/true/red_worsening); ';
  select id into id2 from medical_resource_requests where origin_client_request_id = 'REQ-T93-2';
  select count(*) into n from medical_resource_requests where incident_id = X and resource_type = 'paramedic' and request_kind = 'reinforcement';
  r := r || 'paramedic still via 052=' || n || ' (want 1); ';

  -- Who reads what (052's policy): command all, a medic only their own, another medic none.
  perform set_config('request.jwt.claims', json_build_object('sub', M1, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from medical_resource_requests where incident_id = X and request_kind = 'pc_review';
  r := r || 'medic1 reads=' || n || ' (want 2); ';
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', M3, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from medical_resource_requests where incident_id = X and request_kind = 'pc_review';
  r := r || 'medic3 reads=' || n || ' (want 0); ';
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', PC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from medical_resource_requests where incident_id = X and request_kind = 'pc_review';
  r := r || 'pc reads=' || n || ' (want 3); ';
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', CC, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  select count(*) into n from medical_resource_requests where incident_id = X and request_kind = 'pc_review';
  r := r || 'cc reads=' || n || ' (want 3); ';
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);

  -- The requester may not close it, but may raise its urgency.
  insert into events (incident_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, M2, 'medic', 'MEDICAL_REINFORCEMENT_STATUS_UPDATED', jsonb_build_object('server_request_id', id2, 'status', 'resolved', 'outcome', 'priority_kept'), 'dev-m2', 't93-8', t0 + interval '20 seconds'),
    (X, M2, 'medic', 'MEDICAL_REINFORCEMENT_STATUS_UPDATED', jsonb_build_object('server_request_id', id2, 'urgency', 'immediate'), 'dev-m2', 't93-9', t0 + interval '21 seconds');
  select status || '/' || coalesce(review_outcome, '-') || '/' || urgency into s from medical_resource_requests where id = id2;
  r := r || 'medic resolves own -> ' || s || ' (want pending/-/immediate); ';

  -- PC puts it off 5 minutes: both reviews of P1 wait, P2's does not.
  insert into events (incident_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, PC, 'pc', 'MEDICAL_REINFORCEMENT_STATUS_UPDATED', jsonb_build_object('server_request_id', id1, 'status', 'acknowledged',
       'snoozed_until', to_char((t0 + interval '6 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'reason', 'pc_review_snoozed'), 'dev-pc', 't93-10', t0 + interval '1 minute');
  select status || '/' || (snoozed_until is not null)::text || '/' || snooze_count into s from medical_resource_requests where id = id1;
  r := r || 'pc snooze -> ' || s || ' (want acknowledged/true/1); ';
  select status || '/' || (snoozed_until is not null)::text || '/' || snooze_count || '/' || (status_history->-1->>'reason') into s from medical_resource_requests where id = id2;
  r := r || 'same patient follows -> ' || s || ' (want acknowledged/true/1/same_patient_review); ';
  select status into s from medical_resource_requests where origin_client_request_id = 'REQ-T93-3';
  r := r || 'other patient -> ' || s || ' (want pending); ';
  -- A delay longer than 30 minutes is a plain acknowledgement.
  insert into events (incident_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, PC, 'pc', 'MEDICAL_REINFORCEMENT_STATUS_UPDATED', jsonb_build_object('id', 'x', 'server_request_id', id1, 'status', 'acknowledged',
       'snoozed_until', to_char((t0 + interval '3 hours') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), 'dev-pc', 't93-11', t0 + interval '2 minutes');
  select (snoozed_until is null)::text || '/' || snooze_count into s from medical_resource_requests where id = id1;
  r := r || '3 h delay -> ' || s || ' (want true/1); ';

  -- PC closes it with an outcome: both reviews of P1 close with it.
  insert into events (incident_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, PC, 'pc', 'MEDICAL_REINFORCEMENT_STATUS_UPDATED', jsonb_build_object('server_request_id', id1, 'status', 'resolved', 'outcome', 'evac_moved_up'), 'dev-pc', 't93-12', t0 + interval '4 minutes');
  select status || '/' || coalesce(review_outcome, '-') || '/' || (status_history->-1->>'outcome') || '/' || (snoozed_until is null)::text into s from medical_resource_requests where id = id1;
  r := r || 'pc closes -> ' || s || ' (want resolved/evac_moved_up/evac_moved_up/true); ';
  select status || '/' || coalesce(review_outcome, '-') into s from medical_resource_requests where id = id2;
  r := r || 'same patient closes -> ' || s || ' (want resolved/evac_moved_up); ';
  -- An older offline update arriving late changes nothing.
  insert into events (incident_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, CC, 'cc', 'MEDICAL_REINFORCEMENT_STATUS_UPDATED', jsonb_build_object('server_request_id', id1, 'status', 'acknowledged',
       'snoozed_until', to_char((t0 + interval '8 minutes') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')), 'dev-cc', 't93-13', t0 + interval '3 minutes');
  select status || '/' || coalesce(review_outcome, '-') || '/' || snooze_count into s from medical_resource_requests where id = id1;
  r := r || 'late older update -> ' || s || ' (want resolved/evac_moved_up/1); ';

  -- A CC closes P2's with an outcome the server does not know: closed, no outcome.
  insert into events (incident_id, actor_id, actor_role, type, payload_json, device_id, local_event_id, local_timestamp) values
    (X, CC, 'cc', 'MEDICAL_REINFORCEMENT_STATUS_UPDATED', jsonb_build_object('id', 'REQ-T93-3', 'server_request_id',
       (select id from medical_resource_requests where origin_client_request_id = 'REQ-T93-3'), 'status', 'resolved', 'outcome', '<b>x</b>'), 'dev-cc', 't93-14', t0 + interval '5 minutes');
  select status || '/' || coalesce(review_outcome, '-') into s from medical_resource_requests where origin_client_request_id = 'REQ-T93-3';
  r := r || 'unknown outcome -> ' || s || ' (want resolved/-); ';

  -- Every event stays in the log, refused ones included.
  select count(*) into n from events where incident_id = X and local_event_id like 't93-%';
  r := r || 'events kept=' || n || ' (want 14); ';

  -- No restore needed: the exception below rolls back every change, profiles included.
  raise exception 'TEST93 RESULT: %', r;
end
$test$;
