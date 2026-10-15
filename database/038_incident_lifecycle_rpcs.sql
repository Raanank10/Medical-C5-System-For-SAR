-- Real incident lifecycle: open (draft or official), list, join, confirm/reject/acknowledge a
-- draft. PR1 of the "app starts empty, data comes from the field" work - server side only, no
-- client change yet (index.html still targets the two hardcoded test incidents until PR2).
--
-- Why this is needed (gaps verified live 2026-10-14, not assumed):
-- 1. C5_SENTINEL_SAR_MVP_SPEC_v1.2.md sec 141/202-221 defines a medic-opened draft incident that
--    command later confirms, and incidents_insert RLS already lets a medic insert a
--    status='draft' row - but that medic then cannot read it or write a single event to it:
--    incidents_read and events_insert_by_role both go through app.can_access_incident(), which
--    for medic/paramedic/pc/logistics_officer requires an incident_memberships row, and
--    incident_memberships_insert only allows command roles. The draft path was dead on arrival.
-- 2. There is no way for a field device to discover which incidents exist without already
--    being a member of them (incidents_read is membership-scoped for field roles), so "pick an
--    open incident from a list and join it" had no server support at all.
-- 3. Nothing ever writes INCIDENT_DRAFT_CREATED / INCIDENT_OPENED / INCIDENT_CONFIRMED /
--    INCIDENT_DRAFT_REJECTED, even though the enum values, draft_incident_approval_outbox()
--    and vw_draft_incident_approval_queue all exist and expect them.
--
-- Design decisions (made with the repo owner 2026-10-03, see the PR description):
-- - Both paths: a medic/paramedic opens a DRAFT; a command or rescue-command role opens an
--   ACTIVE (official) incident directly. logistics_officer cannot open incidents.
-- - Joining: any active profile can list open incidents and join one; joining creates its own
--   membership row. This deliberately widens access: any active field account can now see the
--   minimal header fields of every open incident (list_open_incidents) and gain read/write
--   access to one by joining it. Accepted for a single-unit deployment; recorded in
--   docs/RLS_AUDIT_v1.md and docs/AUTH_AND_ROLE_MODEL.md.
-- - Draft resolution: confirm (draft -> active) and reject (draft -> closed, patients and full
--   history kept) now; merge is a later PR. Acknowledge only stops the approval banner blinking.
-- - Every lifecycle write is also appended to the immutable events log, so the AAR timeline and
--   the existing realtime outbox trigger see it. Joining is recorded on the membership row
--   itself (assigned_by, created_at) - there is no join event type, and adding one is not
--   worth an enum change for this PR.
--
-- Idempotency (offline-first clients retry): the client generates the incident id and the
-- (device_id, local_event_id) pair, so a retried open_incident() returns the existing row
-- instead of creating a duplicate, and a retried lifecycle event is a no-op on the existing
-- events unique key rather than an error.

-- ---------------------------------------------------------------------------------------------
-- Internal helper: append one lifecycle event. Not callable by clients.
-- ---------------------------------------------------------------------------------------------
create or replace function app.append_incident_lifecycle_event(
  p_incident_id uuid,
  p_type event_type,
  p_payload jsonb,
  p_device_id text,
  p_local_event_id text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into events (incident_id, patient_id, actor_id, actor_role, type, payload_json,
                      device_id, local_event_id, local_timestamp)
  values (p_incident_id, null, auth.uid(), app.current_user_role(), p_type,
          coalesce(p_payload, '{}'::jsonb),
          coalesce(nullif(p_device_id, ''), 'server-rpc'),
          coalesce(nullif(p_local_event_id, ''), 'rpc-' || gen_random_uuid()::text),
          now())
  on conflict (device_id, local_event_id) do nothing;
end;
$$;

revoke execute on function app.append_incident_lifecycle_event(uuid, event_type, jsonb, text, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- open_incident
-- ---------------------------------------------------------------------------------------------
create or replace function open_incident(
  p_incident_id uuid,
  p_location_name text,
  p_address text default null,
  p_incident_type text default null,
  p_t_zero timestamptz default null,
  p_device_id text default null,
  p_local_event_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role := app.current_user_role();
  v_uid uuid := auth.uid();
  v_status incident_status;
  v_t_zero timestamptz := coalesce(p_t_zero, now());
  v_existing incidents;
  v_visual_id text;
begin
  if v_role is null then
    raise exception 'no active profile' using errcode = '42501';
  end if;
  if v_role in ('medic','paramedic') then
    v_status := 'draft';
  elsif v_role in ('pc','cc','chamal','admin','physician','rpc','rcc') then
    v_status := 'active';
  else
    raise exception 'role % cannot open an incident', v_role using errcode = '42501';
  end if;
  if p_incident_id is null then
    raise exception 'p_incident_id is required (client-generated, for idempotent retry)' using errcode = '22023';
  end if;
  if coalesce(btrim(p_location_name), '') = '' then
    raise exception 'p_location_name is required' using errcode = '22023';
  end if;
  if v_t_zero > now() + interval '5 minutes' then
    raise exception 't_zero cannot be in the future' using errcode = '22023';
  end if;

  select * into v_existing from incidents where id = p_incident_id;
  if found then
    -- Idempotent retry by the same opener; anyone else reusing an id is an error.
    if v_uid in (v_existing.draft_created_by, v_existing.opened_by) then
      return jsonb_build_object('id', v_existing.id, 'visual_id', v_existing.visual_id,
                                'status', v_existing.status, 'created', false);
    end if;
    raise exception 'incident id % already exists', p_incident_id using errcode = '23505';
  end if;

  v_visual_id := 'INC-' || to_char(now() at time zone 'utc', 'YYMMDD') || '-' ||
                 upper(substr(replace(p_incident_id::text, '-', ''), 1, 6));

  insert into incidents (id, visual_id, t_zero, t_injury_default, location_name, address,
                         incident_type, status, draft_created_by, opened_by, opened_at)
  values (p_incident_id, v_visual_id, v_t_zero, v_t_zero, btrim(p_location_name),
          nullif(btrim(p_address), ''), nullif(btrim(p_incident_type), ''), v_status,
          case when v_status = 'draft' then v_uid end,
          case when v_status = 'active' then v_uid end,
          now());

  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  values (p_incident_id, v_uid, v_role, v_uid)
  on conflict (incident_id, profile_id) do nothing;

  perform app.append_incident_lifecycle_event(
    p_incident_id,
    case when v_status = 'draft' then 'INCIDENT_DRAFT_CREATED'::event_type else 'INCIDENT_OPENED'::event_type end,
    jsonb_build_object('visual_id', v_visual_id, 'location_name', btrim(p_location_name),
                       'incident_type', p_incident_type, 't_zero', v_t_zero, 'status', v_status),
    p_device_id, p_local_event_id);

  -- Seed the command snapshot now, so get_incident_command_state() returns a real row (with
  -- status) for a brand-new incident before its first clinical event arrives.
  perform refresh_incident_command_state(p_incident_id);

  return jsonb_build_object('id', p_incident_id, 'visual_id', v_visual_id,
                            'status', v_status, 'created', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- list_open_incidents: minimal header fields only, for the incident picker / CC overview.
-- ---------------------------------------------------------------------------------------------
create or replace function list_open_incidents()
returns table (
  id uuid,
  visual_id text,
  location_name text,
  address text,
  incident_type text,
  status incident_status,
  t_zero timestamptz,
  opened_at timestamptz,
  opened_by_name text,
  draft_acknowledged_at timestamptz,
  patient_count bigint,
  is_member boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if app.current_user_role() is null then
    raise exception 'no active profile' using errcode = '42501';
  end if;
  return query
  select i.id, i.visual_id, i.location_name, i.address, i.incident_type, i.status,
         i.t_zero, i.opened_at,
         coalesce(op.display_name, dc.display_name),
         i.draft_acknowledged_at,
         (select count(*) from patients p where p.incident_id = i.id),
         exists (select 1 from incident_memberships m
                 where m.incident_id = i.id and m.profile_id = auth.uid())
  from incidents i
  left join profiles op on op.id = i.opened_by
  left join profiles dc on dc.id = i.draft_created_by
  where i.status in ('draft','staging','active')
  order by (i.status = 'draft') desc, i.opened_at desc;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- join_incident
-- ---------------------------------------------------------------------------------------------
create or replace function join_incident(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role := app.current_user_role();
  v_status incident_status;
begin
  if v_role is null then
    raise exception 'no active profile' using errcode = '42501';
  end if;
  select status into v_status from incidents where id = p_incident_id;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_status not in ('draft','staging','active') then
    raise exception 'incident % is %, not open for joining', p_incident_id, v_status using errcode = '42501';
  end if;
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  values (p_incident_id, auth.uid(), v_role, auth.uid())
  on conflict (incident_id, profile_id) do nothing;
  return jsonb_build_object('id', p_incident_id, 'status', v_status, 'role_at_incident', v_role);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- confirm_draft / reject_draft / acknowledge_draft - command roles only (app.is_command_role():
-- pc, cc, chamal, admin, physician), matching spec sec 147-149's "confirm draft incident" row.
-- ---------------------------------------------------------------------------------------------
create or replace function confirm_draft(
  p_incident_id uuid,
  p_device_id text default null,
  p_local_event_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role user_role := app.current_user_role();
  v_inc incidents;
begin
  if not app.is_command_role() then
    raise exception 'only command roles can confirm a draft incident' using errcode = '42501';
  end if;
  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_inc.status = 'active' and v_inc.confirmed_by is not null then
    return jsonb_build_object('id', p_incident_id, 'status', v_inc.status, 'changed', false);
  end if;
  if v_inc.status <> 'draft' then
    raise exception 'incident % is %, not a draft', p_incident_id, v_inc.status using errcode = '42501';
  end if;

  update incidents
  set status = 'active',
      confirmed_by = auth.uid(),
      confirmed_at = now(),
      draft_resolved_at = now(),
      opened_by = coalesce(opened_by, auth.uid()),
      metadata = metadata || jsonb_build_object('draft_resolution', 'confirmed'),
      updated_at = now(),
      version = version + 1
  where id = p_incident_id;

  -- The confirming commander takes ownership, so a pc (membership-scoped) can keep working it.
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  values (p_incident_id, auth.uid(), v_role, auth.uid())
  on conflict (incident_id, profile_id) do nothing;

  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_CONFIRMED',
    jsonb_build_object('visual_id', v_inc.visual_id, 'draft_created_by', v_inc.draft_created_by),
    p_device_id, p_local_event_id);

  return jsonb_build_object('id', p_incident_id, 'status', 'active', 'changed', true);
end;
$$;

create or replace function reject_draft(
  p_incident_id uuid,
  p_reason text default null,
  p_device_id text default null,
  p_local_event_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inc incidents;
begin
  if not app.is_command_role() then
    raise exception 'only command roles can reject a draft incident' using errcode = '42501';
  end if;
  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_inc.status = 'closed' and v_inc.metadata->>'draft_resolution' = 'rejected' then
    return jsonb_build_object('id', p_incident_id, 'status', v_inc.status, 'changed', false);
  end if;
  if v_inc.status <> 'draft' then
    raise exception 'incident % is %, not a draft', p_incident_id, v_inc.status using errcode = '42501';
  end if;

  -- Closed, not deleted: patients, events and the draft's own history all stay.
  update incidents
  set status = 'closed',
      closed_by = auth.uid(),
      closed_at = now(),
      draft_resolved_at = now(),
      metadata = metadata || jsonb_build_object('draft_resolution', 'rejected',
                                                'rejection_reason', nullif(btrim(p_reason), '')),
      updated_at = now(),
      version = version + 1
  where id = p_incident_id;

  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_DRAFT_REJECTED',
    jsonb_build_object('visual_id', v_inc.visual_id, 'reason', nullif(btrim(p_reason), ''),
                       'draft_created_by', v_inc.draft_created_by),
    p_device_id, p_local_event_id);

  return jsonb_build_object('id', p_incident_id, 'status', 'closed', 'changed', true);
end;
$$;

create or replace function acknowledge_draft(p_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inc incidents;
begin
  if not app.is_command_role() then
    raise exception 'only command roles can acknowledge a draft incident' using errcode = '42501';
  end if;
  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_inc.status <> 'draft' then
    raise exception 'incident % is %, not a draft', p_incident_id, v_inc.status using errcode = '42501';
  end if;
  if v_inc.draft_acknowledged_at is null then
    update incidents
    set draft_acknowledged_by = auth.uid(),
        draft_acknowledged_at = now(),
        updated_at = now(),
        version = version + 1
    where id = p_incident_id;
  end if;
  return jsonb_build_object('id', p_incident_id, 'acknowledged', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Fix: a rejected draft must not clear its patients' "pending incident approval" flag.
-- 001's trigger cleared it on ANY draft -> non-draft transition, which would have made a
-- rejected draft's patients look approved. Now only draft -> active/staging counts.
-- ---------------------------------------------------------------------------------------------
create or replace function clear_patient_pending_on_incident_confirmation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status = 'draft' and new.status in ('active','staging') then
    update patients
    set pending_incident_approval = false,
        updated_at = now(),
        version = version + 1
    where incident_id = new.id;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Grants: authenticated only (same pattern as 014/033). The functions do their own role checks.
-- ---------------------------------------------------------------------------------------------
revoke execute on function open_incident(uuid, text, text, text, timestamptz, text, text) from public, anon;
grant execute on function open_incident(uuid, text, text, text, timestamptz, text, text) to authenticated;
revoke execute on function list_open_incidents() from public, anon;
grant execute on function list_open_incidents() to authenticated;
revoke execute on function join_incident(uuid) from public, anon;
grant execute on function join_incident(uuid) to authenticated;
revoke execute on function confirm_draft(uuid, text, text) from public, anon;
grant execute on function confirm_draft(uuid, text, text) to authenticated;
revoke execute on function reject_draft(uuid, text, text, text) from public, anon;
grant execute on function reject_draft(uuid, text, text, text) to authenticated;
revoke execute on function acknowledge_draft(uuid) from public, anon;
grant execute on function acknowledge_draft(uuid) to authenticated;
revoke execute on function clear_patient_pending_on_incident_confirmation() from public, anon, authenticated;
