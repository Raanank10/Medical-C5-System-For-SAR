-- "חולץ" needs a medic's check first for an unsorted casualty (repo owner, 2026-11-19). Needs 085.
--
-- 085 lets the RPC / RCC mark a trapped casualty extracted (PATIENT_EXTRACTED): access free, and an
-- on-site casualty is sent to the evacuation point. The owner's rule: a trapped casualty no medic
-- has sorted yet may not be extracted without a medic's check. The phone does not offer "חולץ" for
-- them (it shows "טרם מוין — נדרשת בדיקת חובש לפני חילוץ"); this is the same rule on the server, in
-- case an older phone or a direct insert sends one: the projection leaves the patient row as it is.
-- "Unsorted" is exactly the rescue board's 'pending' priority (074): no triage colour (red, yellow,
-- green, black), no active tourniquet, not dead. The event itself stays in the log.
--
-- Only the trigger function changes (create or replace); its trigger from 085 keeps calling it.

create or replace function app.project_patient_extracted()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_status text;
  v_triage text;
begin
  if new.patient_id is null or new.actor_role::text not in ('rpc', 'rcc', 'admin') then
    return new;
  end if;
  select current_status::text, current_triage::text into v_status, v_triage from patients where id = new.patient_id;
  if v_status is null then
    return new;
  end if;
  -- 086: a trapped casualty no medic has sorted yet (the rescue board's "pending": no triage
  -- colour, no active tourniquet, not dead) is not extracted before a medic checks them. The
  -- event stays in the log; the patient row does not change.
  if v_status <> 'deceased'
     and coalesce(v_triage, '') not in ('red', 'yellow', 'green', 'black')
     and not exists (select 1 from tourniquets t where t.patient_id = new.patient_id and t.is_active) then
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
