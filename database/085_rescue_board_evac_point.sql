-- RCC panel (V2.99.76, repo owner 2026-11-19): the rescue board tells "at the evacuation point"
-- from "on the way" and says who was ever trapped; the stored report keeps the rescue counts.
-- Needs 069 (the report wrapper), 074 (the board) and 077 (the arrival columns) applied first.
--
-- Why. The RCC gets a message when a patient reaches the evacuation point (נאפ״ל) or is evacuated
-- to hospital. get_rescue_patient_board() (074) returns evac_state on_site / evacuating /
-- evacuated, and 'evacuating' covers both "moving to the evacuation point" and "arrived, waiting
-- for MDA" (077). The RCC cannot read the patients table (074), so it cannot see
-- patients.evac_point_arrived_at itself.
--
-- What. The same function, unchanged in every other column, ordering and access rule, with one
-- more column: evac_point_arrived_at, set only while the patient is evacuating. A time and a
-- place, not clinical data (no colour, tourniquet, vitals or treatment), so it is inside the
-- rescue chain's scope (docs/ROLE_COMMAND_MODEL_v2.8.md).
--
-- Second column: was_trapped, true when the patient is trapped now or any event ever recorded them
-- trapped (PATIENT_ACCESS_UPDATED trap_status / access_status, or a create payload). The board
-- only knows who is trapped now; the RCC table counts "extracted so far" (was trapped, is not any
-- more) so the incident's history does not vanish as patients are freed and evacuated.
--
-- Third: the stored report (068, wrapped by 069) gets a 'rescue' section at close: total
-- patients, ever trapped, extracted, still trapped, at the evacuation point, evacuated. Same
-- wrapper pattern as 069: the current function is renamed and called.
--
-- Fourth: "אין גישה" (no access to the casualty yet) is waiting for rescue like trapped (owner,
-- 2026-11-19). access_status gets a 'blocked' value; the client sends it (PATIENT_ACCESS_UPDATED
-- access_status 'blocked', projected by 041's existing cast) and every count here treats
-- trapped / partial / blocked alike. Before 085 the phone sent 'free' for it.
--
-- Fifth: a FIRST_RESPONDER_REPORT (the rescue chain's only way to report a casualty) marked
-- "trapped" sets the new patient's access_status, which nothing projected before.
--
-- Sixth: "חולץ" (owner, 2026-11-19). The RPC / RCC mark a trapped casualty extracted with a new
-- event, PATIENT_EXTRACTED (sync-log allows it for rpc and rcc only). It sets access_status 'free'
-- and sends the patient to the evacuation point to meet a medic for the MIST handover: an on-site
-- status becomes 'evacuating' with no arrival yet (077: on the way to the נאפ״ל). A patient already
-- evacuating, handed over, evacuated or deceased keeps its status. It is not clinical data: the
-- rescue chain never sees or sets triage.
--
-- New output columns change the return type, so the function is dropped and created again;
-- the grants are restated. The client reads the column only when it is present: before this file
-- is applied the RCC message says "בפינוי לנאפ״ל" on 'evacuating' instead of "הגיע לנאפ״ל".

-- A new enum value cannot be used in the transaction that adds it; nothing below casts to it (all
-- comparisons are on text), so it can sit inside the same file.
alter type access_status add value if not exists 'blocked';
alter type event_type add value if not exists 'PATIENT_EXTRACTED';

begin;

-- Was this patient ever trapped? Current access status, or any event that recorded it trapped.
create or replace function app.rescue_patient_was_trapped(p_patient_id uuid, p_access_status text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_access_status, '') in ('trapped', 'partial', 'blocked')
      or exists (select 1 from events e
                 where e.patient_id = p_patient_id
                   and (e.payload_json->>'trap_status' in ('trapped', 'access_blocked')
                        or e.payload_json->>'access_status' in ('trapped', 'partial', 'blocked')
                        or e.payload_json->>'trapped' = 'true'
                        or e.type::text = 'PATIENT_EXTRACTED'))
$$;
revoke execute on function app.rescue_patient_was_trapped(uuid, text) from public, anon, authenticated;

drop function if exists public.get_rescue_patient_board(uuid);

create function public.get_rescue_patient_board(p_incident_id uuid)
returns table(id uuid, visual_id text, optional_name text, identifying_description text,
              location_json jsonb, access_status text, trap_status text, is_trapped boolean,
              evac_state text, priority text, evac_order integer, updated_at timestamptz, version integer,
              evac_point_arrived_at timestamptz, was_trapped boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if coalesce(app.current_user_role()::text not in ('rpc','rcc','admin'), true)
     or not app.can_read_incident_patients(p_incident_id) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  return query
  with tq as (
    select t.patient_id, min(t.applied_at) as applied_at
    from tourniquets t
    where t.incident_id = p_incident_id and t.is_active
    group by t.patient_id
  ),
  vit as (
    select distinct on (e.patient_id) e.patient_id,
           upper(e.payload_json->>'avpu') as avpu,
           case when (e.payload_json->>'rr') ~ '^[0-9]+(\.[0-9]+)?$' then (e.payload_json->>'rr')::numeric end as rr
    from events e
    where e.incident_id = p_incident_id and e.type = 'VITALS_RECORDED' and e.patient_id is not null
    order by e.patient_id, e.local_timestamp desc
  ),
  airway as (
    select distinct e.patient_id
    from events e
    where e.incident_id = p_incident_id and e.patient_id is not null
      and (e.type = 'AIRWAY_MANAGED'
           or (e.type = 'INTERVENTION_RECORDED' and coalesce(e.payload_json->>'treatment_label','') like '%נתיב אוויר%'))
  ),
  ranked as (
    select p.*,
           case when tq.applied_at is not null
                then greatest(0, floor(extract(epoch from (now() - tq.applied_at)) / 60))::int end as tq_min,
           case
             when p.current_status::text = 'deceased' or p.current_triage::text = 'black' then 5
             when tq.applied_at is not null and greatest(0, 120 - floor(extract(epoch from (now() - tq.applied_at)) / 60)) < 45 then 0
             when tq.applied_at is not null then 1
             when p.current_triage::text = 'red' and (vit.avpu in ('P','U') or vit.rr > 30 or vit.rr < 8 or airway.patient_id is not null) then 2
             when p.current_triage::text = 'yellow' and p.current_status::text in ('observing','stabilizing') then 3
             else 4
           end as rank_tier
    from patients p
    left join tq on tq.patient_id = p.id
    left join vit on vit.patient_id = p.id
    left join airway on airway.patient_id = p.id
    where p.incident_id = p_incident_id
  ),
  scored as (
    select r.*,
           case when r.rank_tier = 5 then 9000
                when r.rank_tier < 4 then r.rank_tier * 1000 - coalesce(r.tq_min, 0)
                else 4000 + case r.current_triage::text when 'red' then 0 when 'yellow' then 1 when 'green' then 2 when 'black' then 3 else 4 end
           end as score
    from ranked r
  )
  select r.id, r.visual_id, r.optional_name, r.identifying_description, r.location_json,
         r.access_status::text, r.trap_status::text, r.is_trapped,
         case
           when r.current_status::text = 'evacuating' then 'evacuating'
           when r.current_status::text in ('handed_over','evacuated','self_evacuated','closed') then 'evacuated'
           else 'on_site'
         end,
         case
           when r.rank_tier = 5 then 'not_urgent'
           when r.current_triage::text = 'red' or r.tq_min is not null then 'urgent'
           when r.current_triage is null or r.current_triage::text not in ('yellow','green','black') then 'pending'
           else 'not_urgent'
         end,
         (row_number() over (order by r.score, r.id))::int,
         r.updated_at, r.version,
         -- 085: only while the patient is evacuating (moving or at the point); final statuses keep the
         -- column for the stored report, the rescue board does not need it then.
         case when r.current_status::text = 'evacuating' then r.evac_point_arrived_at end,
         app.rescue_patient_was_trapped(r.id, r.access_status::text)
  from scored r
  order by r.score, r.id;
end;
$function$;

revoke all on function public.get_rescue_patient_board(uuid) from public, anon;
grant execute on function public.get_rescue_patient_board(uuid) to authenticated;

-- The stored report keeps the rescue counts (built at close by app.store_incident_aar_on_close()).
alter function app.build_incident_aar(uuid) rename to build_incident_aar_ext;

create or replace function app.build_incident_aar(p_incident_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
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
            from patients p where p.incident_id = p_incident_id) x))
$$;
revoke execute on function app.build_incident_aar(uuid) from public, anon, authenticated;
revoke execute on function app.build_incident_aar_ext(uuid) from public, anon, authenticated;

-- A first responder's "trapped" reaches the patient row. Only while the access status is still
-- unknown: a medic's later record wins.
create or replace function app.project_first_responder_access()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.type::text = 'FIRST_RESPONDER_REPORT' and new.patient_id is not null and new.payload_json->>'trapped' = 'true' then
    update patients set access_status = 'trapped', access_recorded_at = new.local_timestamp, updated_at = now(), version = version + 1
     where id = new.patient_id and access_status::text = 'unknown';
  end if;
  return new;
end;
$function$;
revoke execute on function app.project_first_responder_access() from public, anon, authenticated;
drop trigger if exists trg_project_first_responder_access on events;
create trigger trg_project_first_responder_access after insert on events
  for each row when (new.type::text = 'FIRST_RESPONDER_REPORT') execute function app.project_first_responder_access();

-- "חולץ": freed, on the way to the evacuation point.
create or replace function app.project_patient_extracted()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_status text;
begin
  if new.patient_id is null or new.actor_role::text not in ('rpc', 'rcc', 'admin') then
    return new;
  end if;
  select current_status::text into v_status from patients where id = new.patient_id;
  if v_status is null then
    return new;
  end if;
  if v_status in ('evacuating', 'handed_over', 'evacuated', 'self_evacuated', 'closed', 'deceased') then
    -- Already on the way, out or dead: only the access changes.
    update patients
       set access_status = 'free', access_recorded_at = new.local_timestamp, updated_at = now(), version = version + 1
     where id = new.patient_id;
  else
    update patients
       set access_status = 'free', access_recorded_at = new.local_timestamp,
           current_status = 'evacuating', status_recorded_at = new.local_timestamp,
           status_set_by_role = new.actor_role, status_set_by_event_id = new.id,
           evac_point_arrived_at = null, evac_point_arrived_role = null,
           updated_at = now(), version = version + 1
     where id = new.patient_id;
  end if;
  return new;
end;
$function$;
revoke execute on function app.project_patient_extracted() from public, anon, authenticated;
drop trigger if exists trg_project_patient_extracted on events;
create trigger trg_project_patient_extracted after insert on events
  for each row when (new.type::text = 'PATIENT_EXTRACTED') execute function app.project_patient_extracted();

commit;
