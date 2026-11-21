-- PC review of a deteriorating casualty crosses devices (WP-26, docs/GAP_CLOSURE_PLAN.md, repo
-- owner 2026-11-19/21). Needs 052 (medical_resource_requests and its status flow).
--
-- Why. The medic's "בקש חוג"ד" wrote PC_REVIEW_REQUESTED_FOR_DETERIORATION on the medic's phone
-- only (event contract known_gaps, WP-5). A medic asking the PC to look at a worsening casualty was
-- lost whenever the PC was on another phone, which is always.
--
-- Shape (owner, option A): one more kind of row in 052's table, so the request reuses 052's read
-- policy (pc / cc / chamal / physician / admin of the incident, and the requester), its server-id
-- status updates from any phone and its newest-wins rule. Its own request_kind 'pc_review', so the
-- stored report (068 counts request_kind:status) and anything that counts reinforcement requests
-- keep the two apart.
--
-- What.
-- 1. request_kind 'pc_review' and three columns: review_outcome (what the PC decided),
--    snoozed_until and snooze_count (the PC's "I will come later", owner 2026-11-21).
-- 2. A second trigger on events, beside 052's (the 087 pattern; 052's function is not changed and
--    still ignores resourceType 'pc_review'):
--    - MEDICAL_REINFORCEMENT_REQUESTED with resourceType 'pc_review' from a medic / paramedic /
--      admin (role read from profiles, never from events.actor_role) creates the row. It must name
--      at least one patient of the same incident; anything else is dropped.
--    - MEDICAL_REINFORCEMENT_STATUS_UPDATED on a pc_review row: 052 applies the status (only
--      pc / cc / chamal / physician / admin, newest local_timestamp wins). This trigger runs after
--      052's (triggers fire in name order) and adds what 052 does not know, only when 052 accepted
--      the event (the row's last_event_id is this event): the outcome on 'resolved', the snooze
--      time on 'acknowledged'. Then it applies the same decision to the other open pc_review rows
--      for the same casualty (two medics asking about one casualty is one review for the PC).
-- Robustness (same as 044/050/052): bad payload values are dropped, never raised. A raise in an
-- AFTER INSERT trigger would roll back the event insert and lose the field record. The event
-- itself always stays in the append-only log.

-- 1. Schema.
do $$
declare
  v_name text;
begin
  for v_name in
    select conname from pg_constraint
    where conrelid = 'public.medical_resource_requests'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%request_kind%'
  loop
    execute format('alter table public.medical_resource_requests drop constraint %I', v_name);
  end loop;
end;
$$;
alter table medical_resource_requests
  add constraint medical_resource_requests_request_kind_check
  check (request_kind in ('reinforcement', 'death_certification', 'pc_review'));

alter table medical_resource_requests add column if not exists review_outcome text;
alter table medical_resource_requests add column if not exists snoozed_until timestamptz;
alter table medical_resource_requests add column if not exists snooze_count integer not null default 0;
alter table medical_resource_requests drop constraint if exists medical_resource_requests_review_outcome_check;
alter table medical_resource_requests add constraint medical_resource_requests_review_outcome_check
  check (review_outcome is null or review_outcome in ('priority_updated', 'priority_kept', 'senior_requested', 'evac_moved_up'));

comment on column medical_resource_requests.review_outcome is
  'pc_review only (WP-26): what the PC decided when closing the review. Also in the closing status_history entry.';
comment on column medical_resource_requests.snoozed_until is
  'pc_review only (WP-26): the PC put the review off until this time (status acknowledged). Null when not put off.';
comment on column medical_resource_requests.snooze_count is
  'pc_review only (WP-26): how many times the review was put off.';

-- 2. Projection.
create or replace function app.project_pc_review_request()
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
  v_status text;
  v_outcome text;
  v_until timestamptz;
  v_reasons jsonb := '[]'::jsonb;
  v_patients jsonb := '[]'::jsonb;
  v_item jsonb;
  v_text text;
  v_server_id uuid;
  v_req medical_resource_requests%rowtype;
  v_last int;
begin
  if new.incident_id is null then
    return new;
  end if;
  select p.role, p.display_name into v_role, v_name from profiles p where p.id = new.actor_id;
  if v_role is null then
    return new;
  end if;
  v_client_id := left(coalesce(new.payload_json->>'id', new.payload_json->>'request_id'), 80);

  -- Creation.
  if new.type::text = 'MEDICAL_REINFORCEMENT_REQUESTED' then
    if coalesce(new.payload_json->>'resourceType', '') <> 'pc_review' then
      return new;
    end if;
    if v_client_id is null or v_role::text not in ('medic', 'paramedic', 'admin') then
      return new;
    end if;
    if jsonb_typeof(new.payload_json->'linkedPatientIds') = 'array' then
      for v_item in select value from jsonb_array_elements(new.payload_json->'linkedPatientIds') limit 5 loop
        v_text := lower(v_item #>> '{}');
        continue when v_text is null or v_text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
        continue when not exists (select 1 from patients pt where pt.id = v_text::uuid and pt.incident_id = new.incident_id);
        v_patients := v_patients || to_jsonb(v_text);
      end loop;
    end if;
    if jsonb_array_length(v_patients) = 0 then
      return new; -- a review is always about a casualty of this incident
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
    insert into medical_resource_requests (
      incident_id, request_kind, resource_type, quantity, urgency, reason_codes, linked_patient_ids,
      site_id, target_location, free_text, auto_generated, status, status_history,
      requested_by, requested_by_name, requested_by_role, requested_at,
      status_updated_by, status_updated_by_name, status_updated_by_role, status_updated_at,
      origin_device_id, origin_client_request_id, created_event_id, last_event_id
    )
    values (
      new.incident_id, 'pc_review', 'pc_review', 1, v_urgency, v_reasons, v_patients,
      nullif(left(btrim(coalesce(new.payload_json->>'siteId', '')), 40), ''),
      nullif(left(btrim(coalesce(new.payload_json->>'targetLocation', '')), 200), ''),
      nullif(left(btrim(coalesce(new.payload_json->>'freeText', '')), 500), ''),
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

  -- MEDICAL_REINFORCEMENT_STATUS_UPDATED: 052 has already run.
  if coalesce(new.payload_json->>'server_request_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_server_id := (new.payload_json->>'server_request_id')::uuid;
    select * into v_req from medical_resource_requests
    where id = v_server_id and incident_id = new.incident_id;
  elsif v_client_id is not null then
    select * into v_req from medical_resource_requests
    where origin_device_id = new.device_id and origin_client_request_id = v_client_id
      and incident_id = new.incident_id;
  end if;
  if v_req.id is null or v_req.request_kind <> 'pc_review' then
    return new;
  end if;
  if v_req.last_event_id is distinct from new.id or v_role::text not in ('pc', 'cc', 'chamal', 'physician', 'admin') then
    return new; -- 052 refused it (role, or an older update), or it is the requester's own change
  end if;
  v_status := v_req.status;
  v_last := jsonb_array_length(v_req.status_history) - 1;

  if v_status = 'resolved' then
    v_outcome := new.payload_json->>'outcome';
    if v_outcome is null or v_outcome not in ('priority_updated', 'priority_kept', 'senior_requested', 'evac_moved_up') then
      v_outcome := null;
    end if;
    update medical_resource_requests
    set review_outcome = v_outcome,
        snoozed_until = null,
        status_history = case when v_last >= 0 and v_outcome is not null
          then jsonb_set(status_history, array[v_last::text, 'outcome'], to_jsonb(v_outcome))
          else status_history end
    where id = v_req.id;
  elsif v_status = 'acknowledged' then
    begin
      v_until := (new.payload_json->>'snoozed_until')::timestamptz;
    exception when others then
      v_until := null;
    end;
    -- A delay is between now and 30 minutes from the phone's time; anything else is a plain
    -- acknowledgement.
    if v_until is not null and (v_until <= new.local_timestamp or v_until > new.local_timestamp + interval '30 minutes') then
      v_until := null;
    end if;
    update medical_resource_requests
    set snoozed_until = v_until,
        snooze_count = snooze_count + case when v_until is null then 0 else 1 end,
        status_history = case when v_last >= 0 and v_until is not null
          then jsonb_set(status_history, array[v_last::text, 'snoozed_until'], to_jsonb(v_until))
          else status_history end
    where id = v_req.id;
  else
    update medical_resource_requests set snoozed_until = null where id = v_req.id and snoozed_until is not null;
  end if;

  -- The same decision for every other open review of the same casualty.
  if v_status in ('acknowledged', 'resolved') then
    update medical_resource_requests r
    set status = v_status,
        review_outcome = case when v_status = 'resolved' then v_outcome else r.review_outcome end,
        snoozed_until = case when v_status = 'acknowledged' then v_until else null end,
        snooze_count = r.snooze_count + case when v_status = 'acknowledged' and v_until is not null then 1 else 0 end,
        status_history = r.status_history || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'status', v_status, 'urgency', r.urgency, 'at', new.local_timestamp, 'by_name', v_name, 'by_role', v_role,
          'event_id', new.id, 'reason', 'same_patient_review', 'outcome', case when v_status = 'resolved' then v_outcome end,
          'snoozed_until', case when v_status = 'acknowledged' then v_until end))),
        status_updated_by = new.actor_id, status_updated_by_name = v_name, status_updated_by_role = v_role,
        status_updated_at = new.local_timestamp,
        last_event_id = new.id, version = r.version + 1
    where r.incident_id = new.incident_id
      and r.request_kind = 'pc_review'
      and r.id <> v_req.id
      and r.linked_patient_ids ?| array(select jsonb_array_elements_text(v_req.linked_patient_ids))
      and r.status not in ('arrived', 'resolved', 'cancelled', 'denied', 'closed', 'fulfilled')
      and r.status_updated_at <= new.local_timestamp;
  end if;
  return new;
end;
$function$;
revoke all on function app.project_pc_review_request() from public;
revoke execute on function app.project_pc_review_request() from anon, authenticated;

drop trigger if exists trg_project_pc_review_request on events;
create trigger trg_project_pc_review_request after insert on events
  for each row when (new.type::text in ('MEDICAL_REINFORCEMENT_REQUESTED', 'MEDICAL_REINFORCEMENT_STATUS_UPDATED'))
  execute function app.project_pc_review_request();
