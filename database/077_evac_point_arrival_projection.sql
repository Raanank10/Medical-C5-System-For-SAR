-- WP-18 (V2.99.66): moving to the evacuation point vs arrived there, and since when.
-- Depends on 076's enum value. Decided with the repo owner 2026-10-24.
--
-- Gap (docs/GAP_CLOSURE_PLAN.md WP-18): status 'evacuating' covered both "the rescuers are
-- moving the patient to the evacuation point" and "waiting there for MDA", and nothing recorded
-- when a patient reached the point, so command could not see how long anyone had waited.
--
-- What this adds:
-- - patients.evac_point_arrived_at: when the patient reached the evacuation point, from
--   PATIENT_EVAC_POINT_ARRIVED's local_timestamp (the time on the phone that recorded it), so an
--   offline phone that pushes late keeps the real arrival time. Never later than the server's
--   own clock (a phone clock running ahead cannot shorten the wait). Earliest report wins: two
--   phones confirming the same arrival keep the first.
-- - patients.evac_point_arrived_role: role of whoever recorded it (shown to command).
-- - patients.evac_point_cleared_at: set when the patient is taken back from the evacuation
--   point (a later status that is neither evacuating nor final). The arrival is cleared, and an
--   arrival recorded before that moment, pushed late, is ignored; a new arrival after it counts.
--   Final statuses (handed_over, deceased, closed, self_evacuated) keep the arrival time, so the
--   stored report can still tell how long the patient waited.
--
-- Status itself is unchanged: moving and arrived are both 'evacuating', so the triage-authority
-- projection (project_patient_state, 021/041) and every view that reads current_status work as
-- before. Arrived = evacuating and evac_point_arrived_at set.
--
-- Deliberately its own trigger, not a branch in project_patient_state() (same reason as 044).
-- Trigger order: Postgres fires AFTER triggers by name, so trg_project_patient_state_evac_point
-- runs after trg_project_patient_state and sees the status that projection settled on (a status
-- update that lost a role-authority tie-break does not clear an arrival).
--
-- Robustness: nothing here raises. A raise inside an AFTER INSERT trigger would roll back the
-- event insert and lose the field record.
--
-- Who may send it: sync-log CLINICAL_EVENTS (medic, paramedic, physician, pc, admin), the same
-- roles that set 'evacuating'. Read: the existing patients read policies; no new grant.

alter table patients add column if not exists evac_point_arrived_at timestamptz;
alter table patients add column if not exists evac_point_arrived_role text;
alter table patients add column if not exists evac_point_cleared_at timestamptz;

comment on column patients.evac_point_arrived_at is
  'When the patient reached the site''s evacuation point (נקודת פינוי), from PATIENT_EVAC_POINT_ARRIVED''s phone time; earliest wins (database/077, WP-18).';
comment on column patients.evac_point_arrived_role is
  'Role of whoever recorded the arrival at the evacuation point (database/077).';
comment on column patients.evac_point_cleared_at is
  'Set when the patient was taken back from the evacuation point; arrivals recorded before it are ignored (database/077).';

create or replace function public.project_evac_point_arrival()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_at timestamptz;
  v_status text;
begin
  if new.patient_id is null then
    return new;
  end if;

  if new.type = 'PATIENT_EVAC_POINT_ARRIVED' then
    v_at := least(new.local_timestamp, now());
    update patients
    set evac_point_arrived_at = v_at,
        evac_point_arrived_role = new.actor_role::text,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and (evac_point_arrived_at is null or evac_point_arrived_at > v_at)
      and (evac_point_cleared_at is null or evac_point_cleared_at < v_at);

  elsif new.type = 'PATIENT_STATUS_UPDATED' then
    -- Read after project_patient_state() ran (trigger order above).
    select current_status::text into v_status from patients where id = new.patient_id;
    if v_status is not null
       and v_status not in ('evacuating','handed_over','deceased','closed','self_evacuated') then
      -- Also when no arrival is stored yet: an arrival recorded before this status, pushed late
      -- by an offline phone, is out of date and must not mark the patient as waiting.
      update patients
      set evac_point_arrived_at = case when evac_point_arrived_at < new.local_timestamp then null else evac_point_arrived_at end,
          evac_point_arrived_role = case when evac_point_arrived_at < new.local_timestamp then null else evac_point_arrived_role end,
          evac_point_cleared_at = new.local_timestamp,
          updated_at = now(),
          version = version + 1
      where id = new.patient_id
        and (evac_point_cleared_at is null or evac_point_cleared_at < new.local_timestamp);
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.project_evac_point_arrival() from public;

drop trigger if exists trg_project_patient_state_evac_point on events;
create trigger trg_project_patient_state_evac_point
after insert on events
for each row execute function public.project_evac_point_arrival();
