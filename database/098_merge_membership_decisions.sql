-- merge_incident: decisions made on the target site stand, and the merge audits every person
-- already on the target that it changes or leaves ended (WP-27 follow-up to 097; rls-sync-reviewer
-- 2026-11-26, twice; owner 2026-11-26: a person the CC ended on the target stays ended, and the CC
-- is told). Needs database/096 and 097. Live had no merge, relief row or unit link when written
-- (checked 2026-11-26), so no existing row needs the new marker.
--  1. incident_memberships.merged_copy_from: set only by merge_incident on the read-only / ended copy
--     it makes for a duplicate's relieved member. A read-only or ended row on the target is made full
--     again only when it carries this mark; any other such row is the target's own decision and stays
--     (listed in memberships_kept_ended, with names and state, so the CC can re-assign).
--  2. The 096 guard treats merged_copy_from as a relief field: only the CC, chamal or admin change it
--     directly, a re-assignment that gives access back clears it, and any later change to a copy's
--     read-only or ended state (an RPC's too) clears it, so the row then counts as the site's decision.
--  3. One unit_audit row (before and after) per person already on the target whose membership the
--     merge changes or keeps ended; memberships_added counts new rows only; the event payload carries
--     profile ids only.
--  4. Someone full on both sites (or restored) waits for relief exactly when his company has an
--     unended read-only link on either site, whatever the merge order.
--  5. A repeated merge returns the same memberships_kept_ended.
-- Apply with the Supabase connector (apply_migration, named 098_merge_membership_decisions) after
-- the owner's OK.

alter table incident_memberships add column if not exists merged_copy_from uuid references incidents(id) on delete set null;
comment on column incident_memberships.merged_copy_from is
  'Set by merge_incident() on the read-only / ended copy it makes for a member of the merged duplicate (database/098); a later merge may make only such a row full again.';

create or replace function app.guard_membership_relief_fields()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := app.current_user_role()::text;
  v_row incident_memberships;
  v_locked boolean := false;
  v_new_relief boolean := false;
  v_kind text;
  v_before jsonb;
  v_after jsonb;
begin
  if coalesce(current_setting('role', true), 'none') in
       ('none', 'postgres', 'service_role', 'supabase_admin', 'supabase_auth_admin', 'supabase_storage_admin')
     or coalesce(current_setting('app.membership_relief_via_rpc', true), '') = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    -- 098: once anything (an RPC included) changes a merge copy's read-only or ended state, the row
    -- is the site's own decision, not a copy: the mark goes, so a later merge cannot undo it.
    if tg_op = 'UPDATE' and old.merged_copy_from is not null
       and new.merged_copy_from is not distinct from old.merged_copy_from
       and (new.read_only_since is distinct from old.read_only_since or new.access_ended_at is distinct from old.access_ended_at) then
      new.merged_copy_from := null;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    v_row := old;
  else
    v_row := new;
  end if;
  if tg_op <> 'INSERT' then
    v_locked := old.read_only_since is not null or old.access_ended_at is not null
                or old.relief_pending_since is not null or old.relieved_by is not null
                or old.merged_copy_from is not null;
    v_before := jsonb_build_object('read_only_since', old.read_only_since, 'access_ended_at', old.access_ended_at,
                                   'relief_pending_since', old.relief_pending_since, 'relieved_by', old.relieved_by,
                                   'merged_copy_from', old.merged_copy_from);
  end if;
  if tg_op <> 'DELETE' then
    v_new_relief := new.read_only_since is not null or new.access_ended_at is not null
                    or new.relief_pending_since is not null or new.relieved_by is not null
                    or new.merged_copy_from is not null;
  end if;
  if tg_op = 'DELETE' then
    if v_locked then
      if coalesce(v_role, '') not in ('cc', 'chamal', 'admin') then
        raise exception 'only the CC, chamal or admin may remove a membership that carries relief fields' using errcode = '42501';
      end if;
      v_kind := 'membership_with_relief_removed';
    end if;
  elsif tg_op = 'INSERT' then
    if v_new_relief then
      if coalesce(v_role, '') not in ('cc', 'chamal', 'admin') then
        raise exception 'only the CC, chamal or admin may set relief fields on a site membership' using errcode = '42501';
      end if;
      v_kind := 'relief_fields_set';
    end if;
  elsif (new.incident_id is distinct from old.incident_id or new.profile_id is distinct from old.profile_id)
        and (v_locked or v_new_relief) then
    if coalesce(v_role, '') not in ('cc', 'chamal', 'admin') then
      raise exception 'only the CC, chamal or admin may move a membership that carries relief fields' using errcode = '42501';
    end if;
    v_kind := 'membership_with_relief_moved';
  elsif new.read_only_since is distinct from old.read_only_since
     or new.access_ended_at is distinct from old.access_ended_at
     or new.relief_pending_since is distinct from old.relief_pending_since
     or new.relieved_by is distinct from old.relieved_by
     or new.merged_copy_from is distinct from old.merged_copy_from then
    if coalesce(v_role, '') not in ('cc', 'chamal', 'admin') then
      raise exception 'only the CC, chamal or admin may change relief fields on a site membership' using errcode = '42501';
    end if;
    v_kind := 'relief_fields_edited';
  elsif v_locked and (new.assigned_by is distinct from old.assigned_by or new.created_at is distinct from old.created_at
                      or new.role_at_incident is distinct from old.role_at_incident) then
    -- A re-assignment (or a role change) of someone relieved: the PC of his company (the policy
    -- already limits a PC to that), the CC, chamal or admin give him full access back.
    if coalesce(v_role, '') not in ('pc', 'cc', 'chamal', 'admin') then
      raise exception 'only the CC, chamal, admin or his own PC can give a relieved member access back' using errcode = '42501';
    end if;
    new.read_only_since := null;
    new.access_ended_at := null;
    new.relief_pending_since := null;
    new.relieved_by := null;
    new.merged_copy_from := null;
    v_kind := 'access_restored_by_assignment';
  end if;
  if v_kind is not null then
    if tg_op <> 'DELETE' then
      v_after := jsonb_build_object('incident_id', new.incident_id, 'profile_id', new.profile_id,
                                    'read_only_since', new.read_only_since, 'access_ended_at', new.access_ended_at,
                                    'relief_pending_since', new.relief_pending_since, 'relieved_by', new.relieved_by,
                                    'merged_copy_from', new.merged_copy_from);
    end if;
    -- On a key move the audit row is for the old row; `after` names where it went.
    if tg_op <> 'INSERT' then v_row := old; end if;
    perform app.write_unit_audit('incident_unit_changed',
      (select coalesce(p.company_id, pl.company_id) from profiles p left join platoons pl on pl.id = p.platoon_id where p.id = v_row.profile_id),
      null, v_row.profile_id, v_row.incident_id, null, null, null, null,
      jsonb_build_object('kind', v_kind, 'role_at_incident', v_row.role_at_incident,
        'by_role', v_role, 'before', v_before, 'after', v_after));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;
-- Defensive repeat of 096: the guard is a trigger function only.
revoke all on function app.guard_membership_relief_fields() from public, anon, authenticated;

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
    -- 098: a repeat (say the first answer was lost) still tells the CC who stayed out.
    return jsonb_build_object('source_id', p_source_id, 'target_id', p_target_id, 'target_visual_id', v_tgt.visual_id,
      'changed', false, 'memberships_restored', '[]'::jsonb,
      'memberships_kept_ended', coalesce((
        select jsonb_agg(jsonb_build_object('profile_id', im.profile_id, 'display_name', p.display_name,
                 'read_only_since', im.read_only_since, 'access_ended_at', im.access_ended_at) order by p.display_name)
        from events e
        cross join lateral jsonb_array_elements_text(coalesce(e.payload_json->'moved'->'memberships_kept_ended', '[]'::jsonb)) k(pid)
        join incident_memberships im on im.incident_id = p_target_id and im.profile_id = k.pid::uuid
          and (im.read_only_since is not null or im.access_ended_at is not null)
        join profiles p on p.id = im.profile_id
        where e.incident_id = p_target_id and e.type = 'INCIDENT_MERGED' and e.payload_json->>'source_id' = p_source_id::text), '[]'::jsonb));
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
  -- stands: the merge never quietly undoes it, and it audits every person already on the target
  -- whom it changes or leaves ended.
  --  * New people: a full membership on the duplicate is copied as full (with its wait for relief);
  --    a read-only or ended one is copied with its access ended and marked merged_copy_from, so his
  --    records from before his relief, redirected here by sync-log (067), are still accepted.
  --  * Someone read-only or ended on the target but full on the duplicate: if his target row is a
  --    merge copy (merged_copy_from set) he gets full access back (memberships_restored); otherwise
  --    it is the target's own decision (a handover, release, relief, end of access or a direct CC
  --    edit) and he stays as he is; the CC is told (memberships_kept_ended) and can re-assign him.
  --  * Someone full on both, or restored: he waits for relief exactly when his company has a link
  --    in force (not ended) that left it read-only on either site, whatever the merge order. Waiting
  --    never takes access away; it only asks him (or his PC / the CC) to confirm the relief.
  --  * Someone full on the target and read-only on the duplicate keeps his target row (the merged
  --    site is the target).
  perform set_config('app.membership_relief_via_rpc', 'on', true);
  for r in
    select t.profile_id, t.role_at_incident, t.read_only_since, t.access_ended_at, t.relieved_by,
           t.relief_pending_since, t.merged_copy_from, m.relief_pending_since as src_pending, p.display_name,
           coalesce(p.company_id, pl.company_id) as company_id,
           exists (select 1 from incident_unit_links l where l.incident_id in (p_target_id, p_source_id)
                   and l.read_only_since is not null and l.ended_at is null
                   and l.company_id = coalesce(p.company_id, pl.company_id)) as company_left
    from incident_memberships t
    join incident_memberships m on m.incident_id = p_source_id and m.profile_id = t.profile_id
      and m.read_only_since is null and m.access_ended_at is null
    join profiles p on p.id = t.profile_id
    left join platoons pl on pl.id = p.platoon_id
    where t.incident_id = p_target_id
    order by t.profile_id
    for update of t
  loop
    v_kind := null;
    if r.read_only_since is not null or r.access_ended_at is not null then
      if r.merged_copy_from is null then
        v_kept_ended := v_kept_ended || jsonb_build_object('profile_id', r.profile_id, 'display_name', r.display_name,
                          'read_only_since', r.read_only_since, 'access_ended_at', r.access_ended_at);
        v_kind := 'merge_kept_target_decision';
      else
        update incident_memberships set read_only_since = null, access_ended_at = null, relieved_by = null, merged_copy_from = null,
               relief_pending_since = case when r.company_left then coalesce(r.src_pending, now()) else null end
        where incident_id = p_target_id and profile_id = r.profile_id;
        v_restored := v_restored || jsonb_build_object('profile_id', r.profile_id, 'display_name', r.display_name);
        v_kind := 'access_restored_by_merge';
      end if;
    elsif r.company_left and r.relief_pending_since is null then
      update incident_memberships set relief_pending_since = coalesce(r.src_pending, now())
      where incident_id = p_target_id and profile_id = r.profile_id;
      v_wait_set := v_wait_set || to_jsonb(r.profile_id);
      v_kind := 'relief_wait_set_by_merge';
    elsif not r.company_left and r.relief_pending_since is not null then
      update incident_memberships set relief_pending_since = null
      where incident_id = p_target_id and profile_id = r.profile_id;
      v_wait_cleared := v_wait_cleared || to_jsonb(r.profile_id);
      v_kind := 'relief_wait_cleared_by_merge';
    end if;
    if v_kind is not null then
      perform app.write_unit_audit('incident_unit_changed', r.company_id, null, r.profile_id, p_target_id, null, null, null, null,
        jsonb_build_object('kind', v_kind, 'source_id', p_source_id, 'role_at_incident', r.role_at_incident, 'by_role', v_role,
          'before', jsonb_build_object('read_only_since', r.read_only_since, 'access_ended_at', r.access_ended_at,
                                       'relief_pending_since', r.relief_pending_since, 'relieved_by', r.relieved_by,
                                       'merged_copy_from', r.merged_copy_from),
          'after', (select jsonb_build_object('incident_id', x.incident_id, 'profile_id', x.profile_id,
                      'read_only_since', x.read_only_since, 'access_ended_at', x.access_ended_at,
                      'relief_pending_since', x.relief_pending_since, 'relieved_by', x.relieved_by,
                      'merged_copy_from', x.merged_copy_from)
                    from incident_memberships x where x.incident_id = p_target_id and x.profile_id = r.profile_id)));
    end if;
  end loop;
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by, relief_pending_since)
  select p_target_id, m.profile_id, m.role_at_incident, coalesce(m.assigned_by, auth.uid()), m.relief_pending_since
  from incident_memberships m where m.incident_id = p_source_id
    and m.read_only_since is null and m.access_ended_at is null
  on conflict (incident_id, profile_id) do nothing;
  get diagnostics v_count = row_count;
  -- Profile ids only in the event payload (every member pulls it); names go to the caller only.
  v_moved := v_moved || jsonb_build_object('memberships_added', v_count,
    'memberships_restored', coalesce((select jsonb_agg(x->'profile_id') from jsonb_array_elements(v_restored) x), '[]'::jsonb),
    'memberships_kept_ended', coalesce((select jsonb_agg(x->'profile_id') from jsonb_array_elements(v_kept_ended) x), '[]'::jsonb),
    'relief_wait_set', v_wait_set, 'relief_wait_cleared', v_wait_cleared);
  insert into incident_memberships (incident_id, profile_id, role_at_incident, assigned_by, read_only_since, access_ended_at, relieved_by, merged_copy_from)
  select p_target_id, m.profile_id, m.role_at_incident, coalesce(m.assigned_by, auth.uid()), m.read_only_since,
         coalesce(m.access_ended_at, now()), m.relieved_by, p_source_id
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
