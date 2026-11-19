-- "בקש חובש לבדיקה": the rescue chain asks for a medic before an extraction (repo owner,
-- 2026-11-19). Needs 052 (medical_resource_requests) and 085/086 (the extraction rule).
--
-- Why. 086 keeps the RPC / RCC from extracting a trapped casualty no medic has sorted, or one
-- trapped for 60 minutes or more (crush syndrome: a medic is present and records it). The rescuer
-- needs a way to call that medic from the app. 052 only lets medical and command roles create a
-- request, and only for its fixed list of resources.
--
-- What.
-- 1. A second trigger on events, beside 052's: MEDICAL_REINFORCEMENT_REQUESTED from an rpc / rcc
--    (role read from profiles, never from events.actor_role) with resourceType 'extraction_medic'
--    creates the request row exactly as 052 does (same validation, same columns, same idempotency
--    on device + client id). 052's function is not changed: it still ignores rpc / rcc creations,
--    and nobody else may create 'extraction_medic'. Status updates go through 052 unchanged: the
--    PC / CC acknowledge, assign and close it, and the requesting RPC / RCC may cancel their own.
-- 2. The incident's medics and paramedics read open and closed 'extraction_medic' requests (052
--    lets only command roles and the requester read), so the call reaches the medics' phones.
-- sync-log lets rpc / rcc send MEDICAL_REINFORCEMENT_REQUESTED and _STATUS_UPDATED.

create or replace function app.project_rescue_extraction_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_role user_role;
  v_name text;
  v_client_id text;
  v_urgency text;
  v_reasons jsonb := '[]'::jsonb;
  v_patients jsonb := '[]'::jsonb;
  v_item jsonb;
  v_text text;
begin
  if new.incident_id is null or new.type::text <> 'MEDICAL_REINFORCEMENT_REQUESTED'
     or coalesce(new.payload_json->>'resourceType', '') <> 'extraction_medic' then
    return new;
  end if;
  select p.role, p.display_name into v_role, v_name from profiles p where p.id = new.actor_id;
  if v_role is null or v_role::text not in ('rpc', 'rcc') then
    return new; -- 052 handles (and refuses) every other role
  end if;
  v_client_id := left(coalesce(new.payload_json->>'id', new.payload_json->>'request_id'), 80);
  if v_client_id is null then
    return new;
  end if;
  v_urgency := new.payload_json->>'urgency';
  if v_urgency is null or v_urgency not in ('immediate', 'high', 'routine') then
    v_urgency := 'high';
  end if;
  if jsonb_typeof(new.payload_json->'reasonCodes') = 'array' then
    for v_item in select value from jsonb_array_elements(new.payload_json->'reasonCodes') limit 12 loop
      v_text := v_item #>> '{}';
      continue when v_text is null or v_text !~ '^[a-z_]{1,40}$';
      v_reasons := v_reasons || to_jsonb(v_text);
    end loop;
  end if;
  if jsonb_typeof(new.payload_json->'linkedPatientIds') = 'array' then
    for v_item in select value from jsonb_array_elements(new.payload_json->'linkedPatientIds') limit 20 loop
      v_text := lower(v_item #>> '{}');
      continue when v_text is null or v_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
      v_patients := v_patients || to_jsonb(v_text);
    end loop;
  end if;

  insert into medical_resource_requests (
    incident_id, request_kind, resource_type, quantity, urgency, reason_codes, linked_patient_ids,
    site_id, target_location, free_text, auto_generated, status, status_history,
    requested_by, requested_by_name, requested_by_role, requested_at,
    status_updated_by, status_updated_by_name, status_updated_by_role, status_updated_at,
    origin_device_id, origin_client_request_id, created_event_id, last_event_id
  )
  values (
    new.incident_id, 'reinforcement', 'extraction_medic', 1, v_urgency, v_reasons, v_patients,
    nullif(left(btrim(coalesce(new.payload_json->>'siteId', '')), 40), ''),
    nullif(left(btrim(coalesce(new.payload_json->>'targetLocation', '')), 200), ''),
    nullif(left(btrim(coalesce(new.payload_json->>'freeText', '')), 500), ''),
    false,
    'pending',
    jsonb_build_array(jsonb_build_object('status', 'pending', 'urgency', v_urgency, 'at', new.local_timestamp,
      'by_name', v_name, 'by_role', v_role, 'event_id', new.id)),
    new.actor_id, v_name, v_role, new.local_timestamp,
    new.actor_id, v_name, v_role, new.local_timestamp,
    new.device_id, v_client_id, new.id, new.id
  )
  on conflict (origin_device_id, origin_client_request_id) do nothing;
  return new;
end;
$function$;
revoke execute on function app.project_rescue_extraction_request() from public, anon, authenticated;
drop trigger if exists trg_project_rescue_extraction_request on events;
create trigger trg_project_rescue_extraction_request after insert on events
  for each row when (new.type::text = 'MEDICAL_REINFORCEMENT_REQUESTED')
  execute function app.project_rescue_extraction_request();

-- The incident's medics see the calls (052's read policy stays as it is; policies are OR-ed).
drop policy if exists medical_resource_requests_read_extraction_medic on medical_resource_requests;
create policy medical_resource_requests_read_extraction_medic on medical_resource_requests for select to authenticated
  using (
    resource_type = 'extraction_medic'
    and app.current_user_role() in ('medic', 'paramedic')
    and app.can_access_incident(incident_id)
  );
