-- merge_incident: decisions made on the target site stand, and every membership change a merge
-- makes is audited (WP-27 follow-up to 097, rls-sync-reviewer 2026-11-26; owner 2026-11-26: a person
-- the CC ended on the target stays ended, and the CC is told). Needs database/096 and 097.
-- Changes against 097, membership section only:
--  1. Someone ended or read-only on the target because of the target's own handover, release or end
--     of access (his company has a read-only incident_unit_links row on the target) stays as he is,
--     even when he is still full on the duplicate. Listed in memberships_kept_ended so the CC can
--     re-assign him (the 096 guard lets his own PC, the CC, chamal or admin give access back).
--     Only a read-only or ended copy that an earlier merge brought onto the target is made full again
--     (memberships_restored).
--  2. One unit_audit row per person already on the target whose membership the merge changes or
--     keeps ended, with the values before (new copies are counted in memberships_added, not audited) (kinds access_restored_by_merge, merge_kept_target_decision,
--     relief_wait_set_by_merge, relief_wait_cleared_by_merge). memberships_added counts new rows only.
--  3. Someone full on both sites waits for relief exactly when his company left either site, so the
--     result no longer depends on the order the duplicates are merged in.
-- Apply with the Supabase connector (apply_migration, named 098_merge_membership_decisions) after
-- the owner's OK. Every other line of the body is 097's.

CREATE OR REPLACE FUNCTION public.merge_incident(p_source_id uuid, p_target_id uuid, p_reason text, p_device_id text DEFAULT NULL::text, p_local_event_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_restored jsonb := '[]'::jsonb;
  v_kept_ended jsonb := '[]'::jsonb;
  v_wait_set jsonb := '[]'::jsonb;
  v_wait_cleared jsonb := '[]'::jsonb;
  v_kind text;
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
  update patient_handover_tokens set incident_id = p_target_id where incident_id = p_source_id;
  update sync_ingestion_errors set incident_id = p_target_id where incident_id = p_source_id;

  update watchdog_alerts s set resolved_at = now(), updated_at = now(),
         payload_json = coalesce(s.payload_json, '{}'::jsonb) || jsonb_build_object('resolved_by_merge', p_target_id)
  where s.incident_id = p_source_id and s.resolved_at is null and s.dedupe_key is not null
    and exists (select 1 from watchdog_alerts t where t.incident_id = p_target_id and t.resolved_at is null
      and t.alert_type = s.alert_type and t.dedupe_key = s.dedupe_key
      and t.patient_id is not distinct from s.patient_id and t.actor_id is not distinct from s.actor_id);
  update watchdog_alerts set incident_id = p_target_id where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('watchdog_alerts', v_count);

  -- Memberships (096, 097, 098; owner 2026-11-26). A decision made on the target site itself
  -- stands: the merge never quietly undoes it, and every change it makes to a person is audited.
  --  * New people: a full membership on the duplicate is copied as full (with its wait for relief);
  --    a read-only or ended one is copied with its access ended, so his records from before his
  --    relief, redirected here by sync-log (067), are still accepted.
  --  * Someone read-only or ended on the target but still full on the duplicate: when his company has
  --    a read-only link on the target (the target's own handover, release or end of access), he stays
  --    as he is and the CC is told (memberships_kept_ended); otherwise his row is a copy from an
  --    earlier merge and he gets full access back (memberships_restored).
  --  * Someone full on both: he waits for relief when his company left either site (a read-only link
  --    on the target or the duplicate), otherwise not, whatever order the duplicates are merged in.
  --    Waiting never takes access away; it only asks him (or his PC / the CC) to confirm the relief.
  perform set_config('app.membership_relief_via_rpc', 'on', true);
  for r in
    select t.profile_id, t.role_at_incident, t.read_only_since, t.access_ended_at, t.relieved_by,
           t.relief_pending_since, m.relief_pending_since as src_pending, p.display_name,
           coalesce(p.company_id, pl.company_id) as company_id,
           exists (select 1 from incident_unit_links l where l.incident_id = p_target_id and l.read_only_since is not null
                   and l.company_id = coalesce(p.company_id, pl.company_id)) as target_left,
           exists (select 1 from incident_unit_links l where l.incident_id = p_source_id and l.read_only_since is not null
                   and l.company_id = coalesce(p.company_id, pl.company_id)) as source_left
    from incident_memberships t
    join incident_memberships m on m.incident_id = p_source_id and m.profile_id = t.profile_id
      and m.read_only_since is null and m.access_ended_at is null
    join profiles p on p.id = t.profile_id
    left join platoons pl on pl.id = p.platoon_id
    where t.incident_id = p_target_id
    order by t.profile_id
  loop
    v_kind := null;
    if r.read_only_since is not null or r.access_ended_at is not null then
      if r.target_left then
        v_kept_ended := v_kept_ended || jsonb_build_object('profile_id', r.profile_id, 'display_name', r.display_name);
        v_kind := 'merge_kept_target_decision';
      else
        update incident_memberships set read_only_since = null, access_ended_at = null, relieved_by = null,
               relief_pending_since = case when r.source_left then coalesce(r.src_pending, now()) else null end
        where incident_id = p_target_id and profile_id = r.profile_id;
        v_restored := v_restored || jsonb_build_object('profile_id', r.profile_id, 'display_name', r.display_name);
        v_kind := 'access_restored_by_merge';
      end if;
    elsif (r.target_left or r.source_left) and r.relief_pending_since is null then
      update incident_memberships set relief_pending_since = coalesce(r.src_pending, now())
      where incident_id = p_target_id and profile_id = r.profile_id;
      v_wait_set := v_wait_set || to_jsonb(r.profile_id);
      v_kind := 'relief_wait_set_by_merge';
    elsif not (r.target_left or r.source_left) and r.relief_pending_since is not null then
      update incident_memberships set relief_pending_since = null
      where incident_id = p_target_id and profile_id = r.profile_id;
      v_wait_cleared := v_wait_cleared || to_jsonb(r.profile_id);
      v_kind := 'relief_wait_cleared_by_merge';
    end if;
    if v_kind is not null then
      perform app.write_unit_audit('incident_unit_changed', r.company_id, null, r.profile_id, p_target_id, null, null, null, null,
        jsonb_build_object('kind', v_kind, 'source_id', p_source_id, 'role_at_incident', r.role_at_incident, 'by_role', v_role,
          'before', jsonb_build_object('read_only_since', r.read_only_since, 'access_ended_at', r.access_ended_at,
                                       'relief_pending_since', r.relief_pending_since, 'relieved_by', r.relieved_by)));
    end if;
  end loop;
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by, relief_pending_since)
  select p_target_id, m.profile_id, m.role_at_incident, coalesce(m.assigned_by, auth.uid()), m.relief_pending_since
  from incident_memberships m where m.incident_id = p_source_id
    and m.read_only_since is null and m.access_ended_at is null
  on conflict (incident_id, profile_id) do nothing;
  get diagnostics v_count = row_count;
  v_moved := v_moved || jsonb_build_object('memberships_added', v_count, 'memberships_restored', v_restored,
                                           'memberships_kept_ended', v_kept_ended,
                                           'relief_wait_set', v_wait_set, 'relief_wait_cleared', v_wait_cleared);
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by, read_only_since, access_ended_at, relieved_by)
  select p_target_id, m.profile_id, m.role_at_incident, coalesce(m.assigned_by, auth.uid()), m.read_only_since,
         coalesce(m.access_ended_at, now()), m.relieved_by
  from incident_memberships m where m.incident_id = p_source_id
    and m.read_only_since is not null
  on conflict (incident_id, profile_id) do nothing;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('memberships_late_records_only', v_count);
  perform set_config('app.membership_relief_via_rpc', '', true);
  update device_presence s set incident_id = p_target_id
  where s.incident_id = p_source_id
    and not exists (select 1 from device_presence t where t.incident_id = p_target_id and t.actor_id = s.actor_id and t.device_id = s.device_id);

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

  if exists (select 1 from incident_pre_evacuations where incident_id = p_source_id) then
    if not exists (select 1 from incident_pre_evacuations where incident_id = p_target_id) then
      update incident_pre_evacuations set incident_id = p_target_id, updated_at = now() where incident_id = p_source_id;
    else
      v_pre_evac_kept := true;
    end if;
  end if;

  perform set_config('app.incident_merge_via_rpc', 'on', true);
  update events set origin_incident_id = coalesce(origin_incident_id, incident_id), incident_id = p_target_id
  where incident_id = p_source_id;
  get diagnostics v_count = row_count; v_moved := v_moved || jsonb_build_object('events', v_count);
  perform set_config('app.incident_merge_via_rpc', '', true);

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
                            'pre_evacuation_kept_on_source', v_pre_evac_kept,
                            'memberships_restored', v_restored, 'memberships_kept_ended', v_kept_ended);
end;
$function$
;
