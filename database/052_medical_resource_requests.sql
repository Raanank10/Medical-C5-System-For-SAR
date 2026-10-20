-- Medical reinforcement and death-certification requests cross devices (WP-5,
-- docs/GAP_CLOSURE_PLAN.md, V2.99.38). Depends on 051's enum values.
--
-- Before this file a request for a doctor, paramedic, extra medics, an evacuation or a death
-- certification lived only in the requesting phone's local reinforcementRequests array. A
-- physician never saw a death-certification request made on a medic's phone, and a CC never saw a
-- PC's request for a paramedic.
--
-- Same two pieces as supply requests (033/034) and the pre-evacuation report (050):
-- - medical_resource_requests: one row per request, written only by the trigger below.
-- - project_medical_resource_request(): AFTER INSERT trigger on events.
--
-- Visibility (D3, decided by the repo owner 2026-10-20): pc / cc / chamal / physician / admin of
-- the incident see every request; whoever made a request always sees their own. Physicians are in
-- the command set, so every physician with access to the incident sees death-certification
-- requests. Read through RLS on the table (as 050), not an RPC.
--
-- Who may write (role read from profiles by actor_id, never from events.actor_role, which the
-- client supplies; same rule as 044/050):
-- - create: medic, paramedic, pc, cc, chamal, physician, admin (AUTH_MATRIX "Request medical
--   reinforcement"; sync-log enforces the same list).
-- - status update: pc, cc, chamal, physician, admin. The original requester may also cancel
--   their own request (a medic withdrawing "suspected deceased") or change its urgency (the
--   medic's phone raises an open death-certification request when a second black casualty
--   appears at the same site).
-- Status updates are matched by the server id (payload_json.server_request_id) when the sending
-- device has pulled the row, which works from any device (the 034 lesson). Otherwise by the
-- creating device plus its local request id, which only matches on the device that created it.
-- Newest local_timestamp wins, so a late-syncing older offline update cannot undo a newer one.
--
-- PATIENT_DEATH_CONFIRMED (physician only, database/026/027) resolves the open death-certification
-- requests linked to that patient, so the request does not stay open after the physician acted.
--
-- Robustness (same as 044/050): bad payload values are dropped or defaulted, never raised. A raise
-- in an AFTER INSERT trigger would roll back the event insert and lose the field record. The event
-- itself always stays in the append-only log.

create table if not exists medical_resource_requests (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  request_kind text not null check (request_kind in ('reinforcement','death_certification')),
  resource_type text not null,
  quantity integer not null default 1,
  urgency text not null default 'high' check (urgency in ('immediate','high','routine')),
  reason_codes jsonb not null default '[]'::jsonb,
  linked_patient_ids jsonb not null default '[]'::jsonb,
  site_id text,
  target_location text,
  free_text text,
  auto_generated boolean not null default false,
  status text not null default 'pending',
  status_history jsonb not null default '[]'::jsonb,
  requested_by uuid references profiles(id) on delete set null,
  requested_by_name text,
  requested_by_role user_role,
  requested_at timestamptz not null,
  status_updated_by uuid references profiles(id) on delete set null,
  status_updated_by_name text,
  status_updated_by_role user_role,
  status_updated_at timestamptz not null,
  origin_device_id text not null,
  origin_client_request_id text not null,
  created_event_id uuid references events(id) on delete set null,
  last_event_id uuid references events(id) on delete set null,
  version integer not null default 1,
  unique (origin_device_id, origin_client_request_id)
);

create index if not exists idx_medical_resource_requests_incident
on medical_resource_requests(incident_id, requested_at desc);

comment on table medical_resource_requests is
  'Requests for medical reinforcement (medic, paramedic, doctor, evacuation, equipment) and for physician death certification, per incident. Written only by project_medical_resource_request() from events (database/052).';
comment on column medical_resource_requests.status_updated_at is
  'local_timestamp of the event that last changed status or urgency (newest wins), not server time.';
comment on column medical_resource_requests.status_history is
  'Array of {status, urgency, at, by_name, by_role, event_id}, appended by the trigger. The event log stays the authoritative history.';

alter table medical_resource_requests enable row level security;

drop policy if exists medical_resource_requests_read on medical_resource_requests;
create policy medical_resource_requests_read on medical_resource_requests for select to authenticated
  using (
    app.can_access_incident(incident_id)
    and (
      app.current_user_role() in ('pc','cc','chamal','physician','admin')
      or requested_by = auth.uid()
    )
  );
-- No insert / update / delete policy: only the security definer trigger below writes it.

create or replace function public.project_medical_resource_request()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role user_role;
  v_name text;
  v_resource text;
  v_kind text;
  v_urgency text;
  v_status text;
  v_reasons jsonb := '[]'::jsonb;
  v_patients jsonb := '[]'::jsonb;
  v_item jsonb;
  v_text text;
  v_client_id text;
  v_server_id uuid;
  v_req medical_resource_requests%rowtype;
  v_quantity integer;
begin
  if new.incident_id is null or new.type not in (
    'MEDICAL_REINFORCEMENT_REQUESTED', 'DOCTOR_DEATH_CERTIFICATION_REQUESTED',
    'MEDICAL_REINFORCEMENT_STATUS_UPDATED', 'PATIENT_DEATH_CONFIRMED'
  ) then
    return new;
  end if;

  select p.role, p.display_name into v_role, v_name from profiles p where p.id = new.actor_id;
  if v_role is null then
    return new;
  end if;

  -- A physician's death confirmation closes the death-certification requests for that patient.
  if new.type = 'PATIENT_DEATH_CONFIRMED' then
    if new.patient_id is not null and v_role in ('physician','admin') then
      update medical_resource_requests
      set status = 'resolved',
          status_history = status_history || jsonb_build_array(jsonb_build_object(
            'status', 'resolved', 'at', new.local_timestamp, 'by_name', v_name, 'by_role', v_role,
            'event_id', new.id, 'reason', 'death_confirmed')),
          status_updated_by = new.actor_id, status_updated_by_name = v_name, status_updated_by_role = v_role,
          status_updated_at = greatest(status_updated_at, new.local_timestamp),
          last_event_id = new.id, version = version + 1
      where incident_id = new.incident_id
        and request_kind = 'death_certification'
        and linked_patient_ids ? new.patient_id::text
        and status not in ('arrived','resolved','cancelled','denied','closed');
    end if;
    return new;
  end if;

  v_client_id := left(coalesce(new.payload_json->>'id', new.payload_json->>'request_id'), 80);

  if new.type in ('MEDICAL_REINFORCEMENT_REQUESTED', 'DOCTOR_DEATH_CERTIFICATION_REQUESTED') then
    if v_client_id is null or v_role not in ('medic','paramedic','pc','cc','chamal','physician','admin') then
      return new;
    end if;
    v_resource := new.payload_json->>'resourceType';
    if new.type = 'DOCTOR_DEATH_CERTIFICATION_REQUESTED' then
      v_resource := 'doctor_death_cert';
    end if;
    if v_resource is null or v_resource not in (
      'one_medic','two_medics','paramedic','doctor_treatment','doctor_death_cert','urgent_evac',
      'routine_evac','evac_coordination','cat_tourniquets','hemostatic_gauze','airway_equipment',
      'iv_fluids','hypothermia_blankets','medical_equipment'
    ) then
      return new;
    end if;
    v_kind := case when v_resource = 'doctor_death_cert' then 'death_certification' else 'reinforcement' end;
    v_urgency := new.payload_json->>'urgency';
    if v_urgency is null or v_urgency not in ('immediate','high','routine') then
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
    v_quantity := case when coalesce(new.payload_json->>'quantity','') ~ '^[0-9]{1,2}$'
      then greatest(1, (new.payload_json->>'quantity')::integer) else 1 end;

    insert into medical_resource_requests (
      incident_id, request_kind, resource_type, quantity, urgency, reason_codes, linked_patient_ids,
      site_id, target_location, free_text, auto_generated, status, status_history,
      requested_by, requested_by_name, requested_by_role, requested_at,
      status_updated_by, status_updated_by_name, status_updated_by_role, status_updated_at,
      origin_device_id, origin_client_request_id, created_event_id, last_event_id
    )
    values (
      new.incident_id, v_kind, v_resource, v_quantity, v_urgency, v_reasons, v_patients,
      nullif(left(btrim(coalesce(new.payload_json->>'siteId','')), 40), ''),
      nullif(left(btrim(coalesce(new.payload_json->>'targetLocation','')), 200), ''),
      nullif(left(btrim(coalesce(new.payload_json->>'freeText','')), 500), ''),
      coalesce((new.payload_json->>'autoGenerated') = 'true', false),
      'pending',
      jsonb_build_array(jsonb_build_object('status', 'pending', 'urgency', v_urgency, 'at', new.local_timestamp,
        'by_name', v_name, 'by_role', v_role, 'event_id', new.id)),
      new.actor_id, v_name, v_role, new.local_timestamp,
      new.actor_id, v_name, v_role, new.local_timestamp,
      new.device_id, v_client_id, new.id, new.id
    )
    on conflict (origin_device_id, origin_client_request_id) do nothing;
    return new;
  end if;

  -- MEDICAL_REINFORCEMENT_STATUS_UPDATED
  v_status := new.payload_json->>'status';
  if v_status is not null and v_status not in (
    'pending','acknowledged','assigned','en_route','arrived','denied','cancelled','resolved','fulfilled','closed'
  ) then
    v_status := null;
  end if;
  v_urgency := new.payload_json->>'urgency';
  if v_urgency is not null and v_urgency not in ('immediate','high','routine') then
    v_urgency := null;
  end if;
  if v_status is null and v_urgency is null then
    return new;
  end if;

  if coalesce(new.payload_json->>'server_request_id','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_server_id := (new.payload_json->>'server_request_id')::uuid;
    select * into v_req from medical_resource_requests
    where id = v_server_id and incident_id = new.incident_id;
  elsif v_client_id is not null then
    select * into v_req from medical_resource_requests
    where origin_device_id = new.device_id and origin_client_request_id = v_client_id
      and incident_id = new.incident_id;
  end if;
  if v_req.id is null then
    return new; -- creation not seen yet, or another incident's request
  end if;

  if not (
    v_role in ('pc','cc','chamal','physician','admin')
    or (v_req.requested_by = new.actor_id and coalesce(v_status, 'cancelled') = 'cancelled')
  ) then
    return new;
  end if;

  update medical_resource_requests
  set status = coalesce(v_status, status),
      urgency = coalesce(v_urgency, urgency),
      status_history = status_history || jsonb_build_array(jsonb_build_object(
        'status', coalesce(v_status, status), 'urgency', coalesce(v_urgency, urgency),
        'at', new.local_timestamp, 'by_name', v_name, 'by_role', v_role, 'event_id', new.id)),
      status_updated_by = new.actor_id, status_updated_by_name = v_name, status_updated_by_role = v_role,
      status_updated_at = new.local_timestamp,
      last_event_id = new.id, version = version + 1
  where id = v_req.id
    and status_updated_at <= new.local_timestamp;
  return new;
end;
$function$;

revoke all on function public.project_medical_resource_request() from public;
revoke execute on function public.project_medical_resource_request() from anon, authenticated;

drop trigger if exists trg_project_medical_resource_request on events;
create trigger trg_project_medical_resource_request
after insert on events
for each row execute function public.project_medical_resource_request();
