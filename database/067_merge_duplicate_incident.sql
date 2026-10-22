-- Merge a duplicate incident into another (decision D8, revised by D10; docs/GAP_CLOSURE_PLAN.md
-- WP-11 part 2 PR B, V2.99.50).
--
-- Two medics can still open the same event twice (D10 warns at opening, but offline phones or a
-- hurried "open anyway" get through). Company-level command (cc, chamal, admin) merges the
-- duplicate (source) into the incident everyone should work in (target):
--
-- 1. Patients and everything recorded about them move to the target. A temporary patient id
--    (visual_id) that the target already uses is renamed "<id>-<last 4 characters of the source
--    incident's id>" (a counter is added if even that is taken); every rename is listed in the
--    INCIDENT_MERGED event. Patient uuids do not change, so phones keep their records.
-- 2. Events: re-tagged to the target and stamped with origin_incident_id, the incident they were
--    first recorded in. This is the one, recorded exception to append-only (owner, D8): nothing is
--    deleted and no content changes. prevent_event_mutation() allows exactly that update, only
--    inside merge_incident() (app.incident_merge_via_rpc), and nothing else.
-- 3. Rows that are unique per incident:
--    - sectors with the same building/floor/apartment/room as a target sector: the source's
--      patients and AAR notes point to the target's sector; the source sector stays behind.
--    - memberships: everyone on the source becomes a member of the target too (the source rows
--      stay, recording who worked there).
--    - device presence / device sync state: moved unless the same device already reports to the
--      target (then the source row stays, stale).
--    - active watchdog alerts that the target already has (same dedupe key): the source copy is
--      resolved, then moved, so the target does not show the same alert twice.
--    - site authority (T0, building status, site clear): moved if the target has none; otherwise
--      the target keeps its own values and takes the source's only where it has none (earliest T0,
--      newest building status, first site clear).
--    - pre-evacuation report: moved if the target has none; otherwise the target keeps its own and
--      the source's stays on the source. The event says so (pre_evacuation_kept_on_source), because
--      adding two reports could count the same casualties twice; command decides.
--    - command state: recomputed for both.
--    - incident_open_acknowledgments, aar_reports and unit_audit stay with the source (they are
--      about the source itself).
-- 4. The source is closed through the close guard (040), with metadata.merged_into
--    {target_id, target_visual_id, at, by, reason}, and gets an INCIDENT_CLOSED event with
--    merged_into. The target gets an INCIDENT_MERGED event with what moved and every rename.
-- 5. sync-log (v11) sends later pushes for the source (an offline phone that still works in it)
--    to the target; the client switches a phone that is in the source to the target.
--
-- Applied live 2026-10-22 as 066_merge_duplicate_incident (the event type as
-- 065_incident_merged_enum_value); renumbered 067/066 in the repo because database/065 is
-- medics_in_platoons (merged first).
--
-- Idempotent: merging the same pair again returns the earlier result's shape with changed:false.

alter table events add column if not exists origin_incident_id uuid references incidents(id) on delete set null;
create index if not exists idx_events_origin_incident on events(origin_incident_id) where origin_incident_id is not null;
comment on column events.origin_incident_id is
  'Set only by merge_incident(): the incident this event was first recorded in, before a duplicate incident was merged into incident_id.';

create or replace function public.prevent_event_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- The one exception (database/067, D8): merge_incident() re-tags a duplicate incident's events
  -- to the target. Only incident_id and origin_incident_id may change, and origin_incident_id
  -- must keep the first incident the event was recorded in.
  if tg_op = 'UPDATE'
     and coalesce(current_setting('app.incident_merge_via_rpc', true), '') = 'on'
     and new.origin_incident_id is not distinct from coalesce(old.origin_incident_id, old.incident_id)
     and (to_jsonb(new) - 'incident_id' - 'origin_incident_id') = (to_jsonb(old) - 'incident_id' - 'origin_incident_id') then
    return new;
  end if;
  raise exception 'events are immutable. append a new event instead.';
end;
$$;

create or replace function merge_incident(
  p_source_id uuid,
  p_target_id uuid,
  p_reason text,
  p_device_id text default null,
  p_local_event_id text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := app.current_user_role()::text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_src incidents;
  v_tgt incidents;
  v_suffix text;
  v_new text;
  v_n int;
  v_count int;
  v_renames jsonb := '[]'::jsonb;
  v_moved jsonb := '{}'::jsonb;
  v_pre_evac_kept boolean := false;
  r record;
begin
  if v_role is null or v_role not in ('cc', 'chamal', 'admin') then
    raise exception 'only company-level command (cc, chamal, admin) may merge incidents' using errcode = '42501';
  end if;
  if p_source_id is null or p_target_id is null or p_source_id = p_target_id then
    raise exception 'choose two different incidents' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'a reason is required to merge incidents' using errcode = '22023';
  end if;

  -- Lock both rows in a fixed order so two concurrent merges cannot deadlock or cross.
  perform 1 from incidents where id in (p_source_id, p_target_id) order by id for update;
  select * into v_src from incidents where id = p_source_id;
  if not found then
    raise exception 'incident % not found', p_source_id using errcode = 'P0002';
  end if;
  select * into v_tgt from incidents where id = p_target_id;
  if not found then
    raise exception 'incident % not found', p_target_id using errcode = 'P0002';
  end if;
  if v_src.status = 'closed' and v_src.metadata->'merged_into'->>'target_id' = p_target_id::text then
    return jsonb_build_object('source_id', p_source_id, 'target_id', p_target_id, 'changed', false);
  end if;
  if v_src.status not in ('active', 'staging') then
    raise exception 'incident % is %: only an open incident can be merged', v_src.visual_id, v_src.status using errcode = '42501';
  end if;
  if v_tgt.status not in ('active', 'staging') then
    raise exception 'incident % is %: merge into an open incident', v_tgt.visual_id, v_tgt.status using errcode = '42501';
  end if;

  -- 1. Patients: rename temporary ids the target already uses.
  v_suffix := upper(right(regexp_replace(coalesce(v_src.visual_id, p_source_id::text), '[^A-Za-z0-9]', '', 'g'), 4));
  for r in
    select p.id, p.visual_id from patients p
    where p.incident_id = p_source_id
      and exists (select 1 from patients t where t.incident_id = p_target_id and t.visual_id = p.visual_id)
    order by p.created_at, p.id
  loop
    v_new := r.visual_id || '-' || v_suffix;
    v_n := 1;
    while exists (select 1 from patients where incident_id in (p_source_id, p_target_id) and visual_id = v_new) loop
      v_n := v_n + 1;
      v_new := r.visual_id || '-' || v_suffix || '-' || v_n;
    end loop;
    update patients set visual_id = v_new, updated_at = now(), version = version + 1 where id = r.id;
    v_renames := v_renames || jsonb_build_object('patient_id', r.id, 'from', r.visual_id, 'to', v_new);
  end loop;

  -- 3a. Sectors the target already has: point the source's patients and notes at the target's.
  for r in
    select s.id as src_sector, t.id as tgt_sector from sectors s
    join sectors t on t.incident_id = p_target_id
      and t.building_no is not distinct from s.building_no and t.floor is not distinct from s.floor
      and t.apartment is not distinct from s.apartment and t.room is not distinct from s.room
    where s.incident_id = p_source_id
  loop
    update patients set sector_id = r.tgt_sector where sector_id = r.src_sector;
    update aar_context_notes set sector_id = r.tgt_sector where sector_id = r.src_sector;
  end loop;
  update sectors s set incident_id = p_target_id
  where s.incident_id = p_source_id
    and not exists (select 1 from sectors t where t.incident_id = p_target_id
      and t.building_no is not distinct from s.building_no and t.floor is not distinct from s.floor
      and t.apartment is not distinct from s.apartment and t.room is not distinct from s.room);
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('sectors', v_count);

  update patients set incident_id = p_target_id, updated_at = now(), version = version + 1 where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('patients', v_count);

  -- Plain per-incident rows.
  update tourniquets set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('tourniquets', v_count);
  update external_reports set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('external_reports', v_count);
  update supply_requests set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('supply_requests', v_count);
  update medical_resource_requests set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('medical_resource_requests', v_count);
  update inventory_ledger_v12 set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('inventory_ledger', v_count);
  update inventory_ledger_v11_archived set incident_id = p_target_id where incident_id = p_source_id;
  update death_confirmations set incident_id = p_target_id where incident_id = p_source_id;
  update conflict_log set incident_id = p_target_id where incident_id = p_source_id;
  update aar_context_notes set incident_id = p_target_id where incident_id = p_source_id;
  update high_risk_override_confirmations set incident_id = p_target_id where incident_id = p_source_id;
  update patient_edit_conflicts set incident_id = p_target_id where incident_id = p_source_id;
  update patient_handover_tokens set incident_id = p_target_id where incident_id = p_source_id;
  update realtime_outbox set incident_id = p_target_id where incident_id = p_source_id;
  update sync_ingestion_errors set incident_id = p_target_id where incident_id = p_source_id;
  update sync_event_dependencies set incident_id = p_target_id where incident_id = p_source_id;
  update experiment_observer_notes set incident_id = p_target_id where incident_id = p_source_id;

  -- 3b. Watchdog alerts: resolve the source's copy of an alert the target already has open.
  update watchdog_alerts s set resolved_at = now(), updated_at = now(),
         payload_json = coalesce(s.payload_json, '{}'::jsonb) || jsonb_build_object('resolved_by_merge', p_target_id)
  where s.incident_id = p_source_id and s.resolved_at is null and s.dedupe_key is not null
    and exists (select 1 from watchdog_alerts t where t.incident_id = p_target_id and t.resolved_at is null
      and t.alert_type = s.alert_type and t.dedupe_key = s.dedupe_key
      and t.patient_id is not distinct from s.patient_id and t.actor_id is not distinct from s.actor_id);
  update watchdog_alerts set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('watchdog_alerts', v_count);

  -- 3c. Memberships, device rows.
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by)
  select p_target_id, m.profile_id, m.role_at_incident, coalesce(m.assigned_by, auth.uid())
  from incident_memberships m where m.incident_id = p_source_id
  on conflict (incident_id, profile_id) do nothing;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('memberships_added', v_count);
  update device_presence s set incident_id = p_target_id
  where s.incident_id = p_source_id
    and not exists (select 1 from device_presence t where t.incident_id = p_target_id and t.actor_id = s.actor_id and t.device_id = s.device_id);
  update device_sync_state s set incident_id = p_target_id
  where s.incident_id = p_source_id
    and not exists (select 1 from device_sync_state t where t.incident_id = p_target_id and t.device_id = s.device_id);

  -- 3d. Site authority.
  if exists (select 1 from incident_site_authority where incident_id = p_source_id) then
    if not exists (select 1 from incident_site_authority where incident_id = p_target_id) then
      update incident_site_authority set incident_id = p_target_id, updated_at = now() where incident_id = p_source_id;
    else
      update incident_site_authority t set
        official_t0 = case when t.official_t0 is null or (s.official_t0 is not null and s.official_t0 < t.official_t0) then s.official_t0 else t.official_t0 end,
        official_by_role = case when t.official_t0 is null or (s.official_t0 is not null and s.official_t0 < t.official_t0) then s.official_by_role else t.official_by_role end,
        official_by_name = case when t.official_t0 is null or (s.official_t0 is not null and s.official_t0 < t.official_t0) then s.official_by_name else t.official_by_name end,
        official_at = case when t.official_t0 is null or (s.official_t0 is not null and s.official_t0 < t.official_t0) then s.official_at else t.official_at end,
        building_status = case when s.building_status_at is not null and (t.building_status_at is null or s.building_status_at > t.building_status_at) then s.building_status else t.building_status end,
        building_status_by_role = case when s.building_status_at is not null and (t.building_status_at is null or s.building_status_at > t.building_status_at) then s.building_status_by_role else t.building_status_by_role end,
        building_status_by_name = case when s.building_status_at is not null and (t.building_status_at is null or s.building_status_at > t.building_status_at) then s.building_status_by_name else t.building_status_by_name end,
        building_status_at = case when s.building_status_at is not null and (t.building_status_at is null or s.building_status_at > t.building_status_at) then s.building_status_at else t.building_status_at end,
        site_cleared_at = coalesce(t.site_cleared_at, s.site_cleared_at),
        site_cleared_by_role = case when t.site_cleared_at is null then s.site_cleared_by_role else t.site_cleared_by_role end,
        site_cleared_by_name = case when t.site_cleared_at is null then s.site_cleared_by_name else t.site_cleared_by_name end,
        updated_at = now()
      from incident_site_authority s
      where t.incident_id = p_target_id and s.incident_id = p_source_id;
    end if;
  end if;

  -- 3e. Pre-evacuation report.
  if exists (select 1 from incident_pre_evacuations where incident_id = p_source_id) then
    if not exists (select 1 from incident_pre_evacuations where incident_id = p_target_id) then
      update incident_pre_evacuations set incident_id = p_target_id, updated_at = now() where incident_id = p_source_id;
    else
      v_pre_evac_kept := true;
    end if;
  end if;

  -- 2. Events (last, so every row the projections point at has already moved).
  perform set_config('app.incident_merge_via_rpc', 'on', true);
  update events set origin_incident_id = coalesce(origin_incident_id, incident_id), incident_id = p_target_id
  where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('events', v_count);
  perform set_config('app.incident_merge_via_rpc', '', true);

  -- 4. Close the source; record the merge on both.
  perform set_config('app.incident_close_via_rpc', 'on', true);
  update incidents
  set status = 'closed', closed_by = auth.uid(), closed_at = now(),
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('merged_into', jsonb_build_object(
        'target_id', p_target_id, 'target_visual_id', v_tgt.visual_id, 'at', now(), 'by', auth.uid(), 'reason', v_reason)),
      updated_at = now(), version = version + 1
  where id = p_source_id;
  perform set_config('app.incident_close_via_rpc', '', true);

  perform app.append_incident_lifecycle_event(p_source_id, 'INCIDENT_CLOSED',
    jsonb_build_object('visual_id', v_src.visual_id, 'merged_into', p_target_id, 'merged_into_visual_id', v_tgt.visual_id,
                       'reason', v_reason, 'open_patient_count', 0),
    p_device_id, nullif(coalesce(p_local_event_id, '') || case when p_local_event_id is null then '' else '-source' end, ''));
  perform app.append_incident_lifecycle_event(p_target_id, 'INCIDENT_MERGED',
    jsonb_build_object('source_id', p_source_id, 'source_visual_id', v_src.visual_id, 'source_location_name', v_src.location_name,
                       'reason', v_reason, 'moved', v_moved, 'renamed_patients', v_renames,
                       'pre_evacuation_kept_on_source', v_pre_evac_kept),
    p_device_id, p_local_event_id);

  perform refresh_incident_command_state(p_source_id);
  perform refresh_incident_command_state(p_target_id);

  return jsonb_build_object('source_id', p_source_id, 'target_id', p_target_id, 'target_visual_id', v_tgt.visual_id,
                            'changed', true, 'moved', v_moved, 'renamed_patients', v_renames,
                            'pre_evacuation_kept_on_source', v_pre_evac_kept);
end;
$$;

revoke execute on function merge_incident(uuid, uuid, text, text, text) from public, anon;
grant execute on function merge_incident(uuid, uuid, text, text, text) to authenticated;
