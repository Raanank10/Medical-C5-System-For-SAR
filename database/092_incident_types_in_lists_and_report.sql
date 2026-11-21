-- WP-25 follow-up (V2.99.83): every incident type, not only the first, where other incidents are
-- listed and in the stored after-action report. 090 gave incidents.incident_types (several types,
-- owner 2026-11-18); these two still returned incidents.incident_type alone, so the incident picker,
-- the RCC table of other incidents and the stored report showed one type.
--
-- Both bodies are copied from the live project (pg_get_functiondef, 2026-11-21), not from the
-- repo files, because later files rewrote them: list_open_incidents last changed in 064/053,
-- app.build_incident_aar in 085 (rescue counts on top of build_incident_aar_ext).
--
-- 1. list_open_incidents(): same rows, same filter, same order; one column added at the end,
--    incident_types. The result type changes, so the function is dropped and recreated (Postgres
--    cannot change a function's OUT columns in place). Both happen in this migration's one
--    transaction, so no caller ever sees it missing. Grants are put back as they are live:
--    execute for authenticated and service_role only.
-- 2. app.build_incident_aar(): the live body is kept as it is and wrapped, adding
--    incident.incident_types to the report. Stored reports already saved keep what they have;
--    index.html falls back to incident.incident_type for them.
-- index.html reads incident_types when present and falls back to incident_type, so the client
-- works before and after this file.

drop function if exists public.list_open_incidents();

create function public.list_open_incidents()
returns table (id uuid, visual_id text, location_name text, address text, incident_type text, status incident_status,
               t_zero timestamptz, opened_at timestamptz, opened_by_name text, draft_acknowledged_at timestamptz,
               patient_count bigint, is_member boolean, incident_types text[])
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
                 where m.incident_id = i.id and m.profile_id = auth.uid()),
         i.incident_types
  from incidents i
  left join profiles op on op.id = i.opened_by
  left join profiles dc on dc.id = i.draft_created_by
  where i.status in ('draft','staging','active')
    -- database/045, 053: unit roles list only the sites they can reach.
    and (app.current_user_role() not in ('pc','rpc','rcc','medic','paramedic') or app.can_access_incident(i.id))
  order by (i.status = 'draft') desc, i.opened_at desc;
end;
$$;

revoke execute on function public.list_open_incidents() from public, anon;
grant execute on function public.list_open_incidents() to authenticated, service_role;

create or replace function app.build_incident_aar(p_incident_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select r || jsonb_build_object('incident',
           coalesce(r->'incident', '{}'::jsonb)
           || jsonb_build_object('incident_types', (select to_jsonb(i.incident_types) from incidents i where i.id = p_incident_id)))
  from (
    -- Live body as of 085, unchanged.
    select app.build_incident_aar_ext(p_incident_id) || jsonb_build_object(
      'rescue', (
        select jsonb_build_object(
          'total', count(*),
          'ever_trapped', count(*) filter (where x.was_trapped),
          'extracted', count(*) filter (where x.was_trapped and not x.trapped_now),
          'trapped_at_close', count(*) filter (where x.trapped_now),
          'at_evac_point_at_close', count(*) filter (where x.status = 'evacuating' and x.evac_point_arrived_at is not null),
          'evacuated', count(*) filter (where x.status in ('handed_over', 'evacuated', 'self_evacuated', 'closed')))
        from (select app.rescue_patient_was_trapped(p.id, p.access_status::text) as was_trapped,
                     coalesce(p.access_status::text, '') in ('trapped', 'partial', 'blocked')
                       and coalesce(p.current_status::text, '') not in ('evacuating', 'handed_over', 'evacuated', 'self_evacuated', 'closed') as trapped_now,
                     p.current_status::text as status, p.evac_point_arrived_at
              from patients p where p.incident_id = p_incident_id) x)) as r
  ) s
$$;
