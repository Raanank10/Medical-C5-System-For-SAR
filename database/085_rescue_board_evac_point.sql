-- RCC evacuation messages: the rescue board tells "at the evacuation point" from "on the way"
-- (RCC panel, V2.99.76, repo owner 2026-11-19). Needs 074 (the board) and 077 (the arrival
-- columns) applied first.
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
-- A new output column changes the return type, so the function is dropped and created again;
-- the grants are restated. The client reads the column only when it is present: before this file
-- is applied the RCC message says "בפינוי לנאפ״ל" on 'evacuating' instead of "הגיע לנאפ״ל".

begin;

drop function if exists public.get_rescue_patient_board(uuid);

create function public.get_rescue_patient_board(p_incident_id uuid)
returns table(id uuid, visual_id text, optional_name text, identifying_description text,
              location_json jsonb, access_status text, trap_status text, is_trapped boolean,
              evac_state text, priority text, evac_order integer, updated_at timestamptz, version integer,
              evac_point_arrived_at timestamptz)
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
         case when r.current_status::text = 'evacuating' then r.evac_point_arrived_at end
  from scored r
  order by r.score, r.id;
end;
$function$;

revoke all on function public.get_rescue_patient_board(uuid) from public, anon;
grant execute on function public.get_rescue_patient_board(uuid) to authenticated;

commit;
