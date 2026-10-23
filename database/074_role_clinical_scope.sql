-- Clinical data stays with the medical roles (V2.99.63). Decided with the repo owner 2026-10-23:
--
-- 1. Logistics officer (logistics_officer): the medics' bags and the supply chain only - which
--    bag, which item, how many, when, the count left, supply requests. No patient, no patient
--    link, no clinical event. Still every site it joins, as before (its supply work spans sites).
-- 2. Rescue chain (rpc, rcc): no clinical data at all. They keep identity, location, trapped /
--    access, evacuation status and the evacuation order; triage reaches them only as a priority
--    (urgent / not urgent / not yet sorted). No triage colour, no tourniquet, no pulse /
--    breathing / injury zones, no MDA classification, no vitals or treatments.
-- 3. Medic: unchanged here (scope stays the whole site). The phone now marks the patients the
--    medic registered or treated (client only, index.html).
--
-- Measured live before this file (read-only, 2026-10-23, row security applied as each role):
-- cc / physician / paramedic read all 55 events of the active site, 19 of them clinical; pc, rcc,
-- rpc, medics of other units and logistics read nothing of a site outside their scope. Gaps this
-- file closes, from the function and policy definitions:
-- - join_incident() lets logistics_officer self-join any open site, after which
--   app.can_read_incident_patients() gave it every patient row and every clinical event.
-- - rpc / rcc could read the patients row of every patient they reach, including current_triage,
--   pulse_present, breathing_present, injury_zones, tourniquet_used, mda_classification and
--   last_vitals_at (database/053 documented this as not covered: RLS cannot hide columns), the
--   tourniquets table, watchdog alerts, external reports (colour counts), pre-evacuation reports
--   (condition counts), and the PATIENT_TRIAGE_UPDATED / TOURNIQUET_* / evacuation events.
--
-- How:
-- - app.can_read_incident_clinical(id): app.can_read_incident_patients(id) and the caller is not
--   logistics_officer / rpc / rcc. Every table that holds per-patient clinical data reads through
--   it. Tables the rescue chain or logistics still need keep app.can_read_incident_patients().
-- - events: rpc / rcc and logistics_officer read an allowlist of event types (a new type stays
--   hidden from them until someone decides otherwise), plus what they wrote themselves.
-- - inventory_ledger_v12 has patient_id: logistics reads it through get_incident_stock_movements(),
--   which leaves that column out.
-- - rpc / rcc read their patients through get_rescue_patient_board(), which returns only the
--   tactical fields and computes priority and evacuation order on the server.
-- - get_incident_command_state() (red counts, missing vitals) refuses logistics, rpc and rcc.
--
-- Not covered, on purpose:
-- - supply_requests.notes / items_json are free text and item lists written for logistics by the
--   requester; they stay readable to logistics.
-- - device_presence.current_patient_id (an opaque id, no patient row behind it for these roles).
-- - events.patient_id on the allowed event types is an opaque id these roles cannot resolve.

-- ---------------------------------------------------------------------------------------------
-- Clinical read helper
-- ---------------------------------------------------------------------------------------------
create or replace function app.can_read_incident_clinical(p_incident_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select app.can_read_incident_patients(p_incident_id)
     and coalesce(app.current_user_role()::text not in ('logistics_officer','rpc','rcc'), false)
$function$;

revoke all on function app.can_read_incident_clinical(uuid) from public, anon;
grant execute on function app.can_read_incident_clinical(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Per-patient clinical tables
-- ---------------------------------------------------------------------------------------------
alter policy patients_read_authenticated on patients
  using (app.can_read_incident_clinical(incident_id));

alter policy tourniquets_read on tourniquets
  using (app.can_read_incident_clinical(incident_id));

alter policy watchdog_read_authenticated on watchdog_alerts
  using (app.can_read_incident_clinical(incident_id));

-- Colour counts (reported_red / _yellow / _green / _black) and the report-to-patient links.
alter policy external_reports_read on external_reports
  using (app.can_read_incident_clinical(incident_id));

alter policy external_patient_links_read on external_patient_links
  using (exists (select 1 from external_reports er
                 where er.id = external_patient_links.external_report_id
                   and app.can_read_incident_clinical(er.incident_id)));

-- Condition counts (light / moderate / severe) of casualties evacuated before the medical force.
alter policy pre_evacuations_read on incident_pre_evacuations
  using (app.can_read_incident_clinical(incident_id));

-- ---------------------------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------------------------
drop policy if exists events_read_authenticated on events;
create policy events_read_authenticated on events for select to authenticated using (
  app.can_read_incident_patients(incident_id)
  and (
    (select app.current_user_role()) not in ('rpc','rcc','logistics_officer')
    or actor_id = (select auth.uid())
    -- Rescue chain: incident and site lifecycle, identity, location, access (trapped), supply
    -- requests. Not PATIENT_TRIAGE_UPDATED / PATIENT_TRIAGED_EXPECTANT (colour),
    -- PATIENT_STATUS_UPDATED (clinical statuses), PATIENT_EVACUATION_UPDATED (MDA
    -- classification), TOURNIQUET_*, FIRST_RESPONDER_REPORT of others (tourniquet yes/no),
    -- SITE_PRE_EVACUATION_REPORTED (condition counts), EXTERNAL_REPORT_* (colour counts).
    -- Priority and evacuation status come from get_rescue_patient_board().
    or ((select app.current_user_role()) in ('rpc','rcc') and type = any (array[
      'INCIDENT_DRAFT_CREATED','INCIDENT_OPENED','INCIDENT_CONFIRMED','INCIDENT_DRAFT_MERGED',
      'INCIDENT_DRAFT_REJECTED','INCIDENT_CLOSED','INCIDENT_REOPENED','INCIDENT_CLOSE_TOGGLED',
      'OFFICIAL_INCIDENT_OPENED_BY_RESCUE','BUILDING_STATUS_UPDATED','SITE_CLEAR_CONFIRMED',
      'MEDIC_SITE_CLOSE_REQUESTED','PATIENT_IDENTIFIED','PATIENT_LOCATION_UPDATED',
      'PATIENT_ACCESS_UPDATED',
      'SUPPLY_REQUEST_CREATED','SUPPLY_REQUEST_DISPATCHED','SUPPLY_REQUEST_IN_TRANSIT','SUPPLY_REQUEST_RECEIVED'
    ]::event_type[]))
    -- Logistics: incident lifecycle, supply requests and stock moves between holders. Not
    -- SUPPLY_CONSUMED / SUPPLY_USE_CANCELLED / INVENTORY_LEDGER_MOVEMENT / INVENTORY_LEDGER_ENTRY /
    -- LOCAL_STOCKOUT_WARNING (carry the patient), nor RESUPPLY_* (carry the linked patients and
    -- the medic's reason). Bag counts come from get_incident_stock_movements().
    or ((select app.current_user_role()) = 'logistics_officer' and type = any (array[
      'INCIDENT_DRAFT_CREATED','INCIDENT_OPENED','INCIDENT_CONFIRMED','INCIDENT_DRAFT_MERGED',
      'INCIDENT_DRAFT_REJECTED','INCIDENT_CLOSED','INCIDENT_REOPENED','INCIDENT_CLOSE_TOGGLED',
      'SUPPLY_REQUEST_CREATED','SUPPLY_REQUEST_DISPATCHED','SUPPLY_REQUEST_IN_TRANSIT','SUPPLY_REQUEST_RECEIVED',
      'INVENTORY_INITIALIZED','INVENTORY_TRANSFER_OUT','INVENTORY_TRANSFER_IN',
      'PLATOON_STOCK_INITIALIZED','PLATOON_STOCK_REFILLED','DIRECT_LOGO_TO_MEDIC_REFILL'
    ]::event_type[]))
  )
);

-- ---------------------------------------------------------------------------------------------
-- Logistics: bag and truck counts without the patient
-- ---------------------------------------------------------------------------------------------
alter policy inventory_ledger_v12_read on inventory_ledger_v12
  using ((incident_id is null or app.can_read_incident_patients(incident_id))
         and coalesce(app.current_user_role()::text <> 'logistics_officer', false));

create or replace function public.get_incident_stock_movements(p_incident_id uuid)
returns table(item_type text, movement_type text, quantity_delta integer, stock_owner text,
              stock_after integer, actor_id uuid, device_id text, local_event_id text,
              occurred_at timestamptz, created_at timestamptz, stock_seq text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not app.can_read_incident_patients(p_incident_id) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  return query
  select l.item_type, l.movement_type::text, l.quantity_delta, l.stock_owner,
         l.stock_after, l.actor_id, l.device_id, l.local_event_id,
         l.occurred_at, l.created_at, l.payload_json->>'stock_seq'
  from inventory_ledger_v12 l
  where l.incident_id = p_incident_id
  order by l.occurred_at desc nulls last
  limit 2000;
end;
$function$;

revoke all on function public.get_incident_stock_movements(uuid) from public, anon;
grant execute on function public.get_incident_stock_movements(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Rescue chain: tactical patient board
-- ---------------------------------------------------------------------------------------------
-- priority: 'urgent' (red, or an active tourniquet), 'pending' (not sorted yet, never shown as
-- not urgent), 'not_urgent' (yellow, green, black, and anyone deceased). evac_order: 1, 2, 3...
-- in the order medical command uses (index.html evacuationPriorityRank / evacuationSortScore; keep
-- the two in step). Only the position is returned: the score itself would show minutes on a
-- tourniquet.
--   rank 0  active tourniquet with under 45 minutes left of the 120-minute window
--   rank 1  active tourniquet
--   rank 2  red with AVPU P/U, respiratory rate over 30 or under 8, or a managed airway
--   rank 3  yellow, stabilizing or observing
--   rank 4  the rest, by colour (red, yellow, green, not sorted)
--   rank 5  deceased (status deceased, or black): always last, whatever else is recorded
--           (owner, 2026-10-23; index.html isDeceasedForEvac)
--   score = rank * 1000 - minutes on the tourniquet, 4000 + colour order, or 9000 for rank 5.
--   Lower goes first.
-- evac_state: on_site / evacuating / evacuated. Deceased is not told apart (clinical status).
-- Only rpc / rcc (and admin) may call it: logistics is an incident member too, and must not get
-- the patient list.
create or replace function public.get_rescue_patient_board(p_incident_id uuid)
returns table(id uuid, visual_id text, optional_name text, identifying_description text,
              location_json jsonb, access_status text, trap_status text, is_trapped boolean,
              evac_state text, priority text, evac_order integer, updated_at timestamptz, version integer)
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
         r.updated_at, r.version
  from scored r
  order by r.score, r.id;
end;
$function$;

revoke all on function public.get_rescue_patient_board(uuid) from public, anon;
grant execute on function public.get_rescue_patient_board(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- Command snapshot: red counts and missing vitals are clinical
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_incident_command_state(p_incident_id uuid)
returns incident_command_state
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  result incident_command_state;
begin
  if not app.can_access_incident(p_incident_id)
     or coalesce(app.current_user_role()::text in ('logistics_officer','rpc','rcc'), true) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  select * into result from incident_command_state where incident_id = p_incident_id;
  return result;
end;
$function$;
