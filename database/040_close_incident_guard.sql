-- Incident close guard: an incident cannot be closed while patients on it have not been handed
-- over, unless medical command overrides with a recorded reason.
--
-- Gap found 2026-10-15 (asked by the repo owner, verified live, not assumed):
-- - The only close action in the app (rescue-chain "סגור אירוע", rescueToggleIncidentClosed())
--   changed a local flag and logged INCIDENT_CLOSE_TOGGLED, with no patient check at all.
-- - On the server nothing reacts to INCIDENT_CLOSE_TOGGLED / INCIDENT_CLOSED, so the real
--   incidents.status never changed; and incidents_update RLS lets pc/cc/chamal/admin/physician/
--   rpc/rcc set status='closed' directly, again with no patient check.
--
-- Design decisions (made with the repo owner 2026-10-15):
-- - Who may close: rescue command (rpc/rcc, who own the close button per
--   ROLE_COMMAND_MODEL_v2.8.md) plus medical command (pc/cc/chamal/physician) and admin.
-- - Patients still open block the close. Medical command (pc/cc/chamal/physician) and admin may
--   override with a mandatory reason; rescue command may not. The override, the reason and the
--   list of patients still open at that moment are written to the event log and to
--   incidents.metadata.
-- - "Open" means current_status is anything except handed_over, closed, self_evacuated or
--   deceased. 'evacuating' counts as open: the patient has not been handed over yet.
-- - Enforced on the server: a BEFORE UPDATE trigger rejects any transition to 'closed' that does
--   not come through close_incident() or reject_draft(), so the guard cannot be bypassed with a
--   direct table update. Service-role / migration updates (no auth.uid()) are not affected.

-- ---------------------------------------------------------------------------------------------
-- Trigger: only the two RPCs below may move an incident to 'closed' for a signed-in user.
-- ---------------------------------------------------------------------------------------------
create or replace function app.guard_incident_close()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'closed' and old.status is distinct from 'closed'
     and auth.uid() is not null
     and coalesce(current_setting('app.incident_close_via_rpc', true), '') <> 'on' then
    raise exception 'incidents can only be closed through close_incident() (patient hand-over check)'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_incident_close on incidents;
create trigger trg_guard_incident_close
before update of status on incidents
for each row execute function app.guard_incident_close();

revoke execute on function app.guard_incident_close() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- close_incident
-- ---------------------------------------------------------------------------------------------
create or replace function close_incident(
  p_incident_id uuid,
  p_override_reason text default null,
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
  v_open jsonb;
  v_open_count int;
  v_reason text := nullif(btrim(coalesce(p_override_reason, '')), '');
  v_can_override boolean;
begin
  if v_role is null or v_role not in ('pc','cc','chamal','admin','physician','rpc','rcc') then
    raise exception 'role % cannot close an incident', v_role using errcode = '42501';
  end if;
  if not app.can_access_incident(p_incident_id) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  v_can_override := v_role in ('pc','cc','chamal','admin','physician');

  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_inc.status = 'closed' then
    return jsonb_build_object('closed', true, 'changed', false);
  end if;
  if v_inc.status = 'draft' then
    raise exception 'incident % is a draft: confirm or reject it instead of closing', p_incident_id using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'visual_id', p.visual_id,
                                               'triage', p.current_triage, 'status', p.current_status)
                            order by p.visual_id), '[]'::jsonb),
         count(*)
    into v_open, v_open_count
  from patients p
  where p.incident_id = p_incident_id
    and p.current_status not in ('handed_over','closed','self_evacuated','deceased');

  if v_open_count > 0 and (v_reason is null or not v_can_override) then
    return jsonb_build_object('closed', false, 'open_patient_count', v_open_count,
                              'open_patients', v_open, 'can_override', v_can_override,
                              'reason_required', v_can_override);
  end if;

  perform set_config('app.incident_close_via_rpc', 'on', true);
  update incidents
  set status = 'closed',
      closed_by = auth.uid(),
      closed_at = now(),
      metadata = metadata || case when v_open_count > 0
        then jsonb_build_object('close_override', jsonb_build_object(
               'reason', v_reason, 'by', auth.uid(), 'role', v_role, 'at', now(),
               'open_patient_count', v_open_count, 'open_patients', v_open))
        else '{}'::jsonb end,
      updated_at = now(),
      version = version + 1
  where id = p_incident_id;
  perform set_config('app.incident_close_via_rpc', '', true);

  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_CLOSED',
    jsonb_build_object('visual_id', v_inc.visual_id, 'open_patient_count', v_open_count,
                       'open_patients', v_open, 'override_reason', v_reason),
    p_device_id, p_local_event_id);

  return jsonb_build_object('closed', true, 'changed', true, 'override', v_open_count > 0,
                            'open_patient_count', v_open_count);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- reopen_incident (same roles). A rejected draft stays closed: it was never a confirmed incident.
-- ---------------------------------------------------------------------------------------------
create or replace function reopen_incident(
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
  if v_role is null or v_role not in ('pc','cc','chamal','admin','physician','rpc','rcc') then
    raise exception 'role % cannot reopen an incident', v_role using errcode = '42501';
  end if;
  if not app.can_access_incident(p_incident_id) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  select * into v_inc from incidents where id = p_incident_id for update;
  if not found then
    raise exception 'incident % not found', p_incident_id using errcode = 'P0002';
  end if;
  if v_inc.status <> 'closed' then
    return jsonb_build_object('status', v_inc.status, 'changed', false);
  end if;
  if v_inc.metadata->>'draft_resolution' = 'rejected' then
    raise exception 'incident % is a rejected draft and cannot be reopened', p_incident_id using errcode = '42501';
  end if;
  update incidents
  set status = 'active',
      metadata = metadata || jsonb_build_object('reopened_at', now(), 'reopened_by', auth.uid()),
      updated_at = now(),
      version = version + 1
  where id = p_incident_id;
  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_REOPENED',
    jsonb_build_object('visual_id', v_inc.visual_id), p_device_id, p_local_event_id);
  return jsonb_build_object('status', 'active', 'changed', true);
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- reject_draft (038) closes a rejected draft, so it must pass the guard too. Same body as 038
-- plus the two set_config lines around the update.
-- ---------------------------------------------------------------------------------------------
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

  perform set_config('app.incident_close_via_rpc', 'on', true);
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
  perform set_config('app.incident_close_via_rpc', '', true);

  perform app.append_incident_lifecycle_event(p_incident_id, 'INCIDENT_DRAFT_REJECTED',
    jsonb_build_object('visual_id', v_inc.visual_id, 'reason', nullif(btrim(p_reason), ''),
                       'draft_created_by', v_inc.draft_created_by),
    p_device_id, p_local_event_id);

  return jsonb_build_object('id', p_incident_id, 'status', 'closed', 'changed', true);
end;
$$;

revoke execute on function close_incident(uuid, text, text, text) from public, anon;
grant execute on function close_incident(uuid, text, text, text) to authenticated;
revoke execute on function reopen_incident(uuid, text, text) from public, anon;
grant execute on function reopen_incident(uuid, text, text) to authenticated;
revoke execute on function reject_draft(uuid, text, text, text) from public, anon;
grant execute on function reject_draft(uuid, text, text, text) to authenticated;
