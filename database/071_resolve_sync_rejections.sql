-- Sync rejections can be closed (feature map gap N7, P1). Owner decisions 2026-10-22: everyone
-- who sees the "אירועים חסומים" panel may close one (pc, cc, chamal, physician, admin); the
-- nightly privacy job that deletes a closed rejection's stored copy (raw_payload) stays as it is,
-- and the close dialog warns first; the 36 rejections already open are closed by the owner from
-- the panel, not by this file.
--
-- Before this, sync_ingestion_errors had a read policy only: 36 rejections had piled up since
-- August, none ever closed, including the 9 sweep patients lost on 2026-10-20 (WP-17). The table
-- already had the columns (resolved_at, resolved_by, resolution_notes, reviewed_by,
-- reviewed_at, reconciled_event_id); nothing wrote them.
--
-- 1. Automatic close: when an event with the same device_id + local_event_id is later accepted
--    (the phone resent it, e.g. "שלח שוב לשרת" after a fix), its open rejections are closed with
--    reconciled_event_id = the accepted event. Runs in an AFTER INSERT trigger and never raises:
--    a failure here must not roll back the accepted event.
-- 2. resolve_sync_ingestion_error(id, reason, note): closes one rejection by hand. Reasons:
--    resent (sent again another way), duplicate (the record is already on the server),
--    test_data (test or training data), not_recoverable (lost; a note is required), other (a
--    note is required). Only pc, cc, chamal, physician, admin who can still read the incident's
--    patients (app.can_read_incident_patients: after a close, admin only); a rejection with no
--    incident, admin only. Already closed: returned unchanged. The row keeps who closed it,
--    when and why; the nightly job then deletes raw_payload and logs it in retention_actions,
--    as for every closed rejection.
-- Clients still cannot write the table directly (no insert/update/delete policy).

-- ---------------------------------------------------------------------------------------------
-- 1. Automatic close when the rejected record is accepted later
-- ---------------------------------------------------------------------------------------------
create or replace function app.close_sync_rejections_on_accept()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    update sync_ingestion_errors
    set resolved_at = now(),
        reconciled_event_id = new.id,
        resolution_notes = 'auto: accepted on a later push (event ' || new.id || ')'
    where device_id = new.device_id
      and local_event_id = new.local_event_id
      and resolved_at is null;
  exception when others then
    null; -- never block the accepted event
  end;
  return new;
end;
$$;
revoke execute on function app.close_sync_rejections_on_accept() from public, anon, authenticated;

create or replace trigger trg_close_sync_rejections_on_accept
after insert on events
for each row execute function app.close_sync_rejections_on_accept();

create index if not exists idx_sync_ingestion_errors_open_device_event
  on sync_ingestion_errors (device_id, local_event_id) where resolved_at is null;

-- ---------------------------------------------------------------------------------------------
-- 2. Close by hand
-- ---------------------------------------------------------------------------------------------
create or replace function public.resolve_sync_ingestion_error(p_id uuid, p_reason text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := app.current_user_role()::text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_row sync_ingestion_errors;
begin
  if v_role is null or v_role not in ('pc', 'cc', 'chamal', 'physician', 'admin') then
    raise exception 'only command roles may close a sync rejection' using errcode = '42501';
  end if;
  if p_reason is null or p_reason not in ('resent', 'duplicate', 'test_data', 'not_recoverable', 'other') then
    raise exception 'unknown reason %', p_reason using errcode = '22023';
  end if;
  if p_reason in ('not_recoverable', 'other') and v_note is null then
    raise exception 'a note is required for reason %', p_reason using errcode = '22023';
  end if;

  select * into v_row from sync_ingestion_errors where id = p_id for update;
  if not found then
    raise exception 'sync rejection % not found', p_id using errcode = 'P0002';
  end if;
  if v_row.incident_id is null then
    if v_role <> 'admin' then
      raise exception 'a rejection with no incident is closed by admin only' using errcode = '42501';
    end if;
  elsif not app.can_read_incident_patients(v_row.incident_id) then
    raise exception 'no access to this incident' using errcode = '42501';
  end if;
  if v_row.resolved_at is not null then
    return jsonb_build_object('id', v_row.id, 'changed', false, 'resolved_at', v_row.resolved_at);
  end if;

  update sync_ingestion_errors
  set resolved_at = now(),
      resolved_by = auth.uid(),
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      resolution_notes = left(p_reason || coalesce(': ' || v_note, ''), 500)
  where id = p_id
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'changed', true, 'resolved_at', v_row.resolved_at, 'reason', p_reason);
end;
$$;
revoke execute on function public.resolve_sync_ingestion_error(uuid, text, text) from public, anon;
grant execute on function public.resolve_sync_ingestion_error(uuid, text, text) to authenticated;
