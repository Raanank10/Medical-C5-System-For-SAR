-- Tourniquet follow-ups on the server (WP-2b, docs/GAP_CLOSURE_PLAN.md, V2.99.42). Depends on
-- 056's enum value.
--
-- #73 (V2.99.34) made every tourniquet application reach the server and other devices read the
-- active `tourniquets` rows back. Three things still stayed on the recording phone:
-- 1. A limb recorded after application. The row kept limb 'unknown'.
-- 2. Effectiveness (bleeding controlled / bleeding continues). Not part of this file: the client
--    now sends it as TOURNIQUET_REASSESSMENT, which project_tourniquet_events() (001) already
--    projects (tourniquet_status, last_reassessed_at, next reassessment). 058 lets
--    tourniquet_status hold 'effective' / 'bleeding_continues'.
-- 3. Handover. A handed-over patient's tourniquet row stayed is_active, so command counts and the
--    server reassessment watchdog kept treating it as on site.
--
-- project_tourniquet_followups() is a separate AFTER INSERT trigger rather than an edit of
-- project_tourniquet_events(), so the projection that applies, reassesses and releases tourniquets
-- is left exactly as it is.
-- - TOURNIQUET_LIMB_RECORDED (patient-scoped): payload limb (new), previous_limb (what the server
--   row was created with, normally 'unknown') and application_time. Moves the matching active row
--   to the new limb. If a row with the new limb and the same application time already exists, the
--   unique key (patient_id, limb, applied_at) would be violated: that update is skipped, the event
--   stays in the log.
-- - PATIENT_HANDED_OVER (patient-scoped): the patient's active rows get is_active = false.
--   released_at and tourniquet_status stay as they were: the tourniquet was not released, it left
--   the site with the patient, and the handover event itself is the record of that.
-- Nothing here raises (same rule as 044/050/052/054): a raise in an AFTER INSERT trigger would
-- roll back the event insert and lose the field record. Every update is wrapped so that a
-- constraint (tourniquets_tourniquet_status_check, the unique key) cannot reject the event.
--
-- Found while verifying live, 2026-10-20: the first version applied set
-- tourniquet_status = 'handed_over', which tourniquets_tourniquet_status_check does not allow, so
-- for about 5 minutes a handover of a patient with an active tourniquet would have been rejected
-- (no events reached the server in that window; checked). It was replaced live with this version
-- (live migration history: 057_tourniquet_followups, then 057b_tourniquet_followups_no_raise).

create or replace function public.project_tourniquet_followups()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_limb text;
  v_prev text;
  v_applied timestamptz;
begin
  if new.patient_id is null or new.type not in ('TOURNIQUET_LIMB_RECORDED', 'PATIENT_HANDED_OVER') then
    return new;
  end if;

  if new.type = 'PATIENT_HANDED_OVER' then
    begin
      update tourniquets
      set is_active = false,
          updated_at = now()
      where patient_id = new.patient_id
        and is_active = true;
    exception when others then
      null;
    end;
    return new;
  end if;

  v_limb := new.payload_json->>'limb';
  if v_limb is null or v_limb not in ('left_arm','right_arm','left_leg','right_leg','unknown') then
    return new;
  end if;
  v_prev := coalesce(new.payload_json->>'previous_limb', 'unknown');
  if v_prev = v_limb then
    return new;
  end if;
  begin
    v_applied := (new.payload_json->>'application_time')::timestamptz;
  exception when others then
    v_applied := null;
  end;

  begin
    update tourniquets
    set limb = v_limb,
        updated_at = now()
    where id = (
      select t.id from tourniquets t
      where t.patient_id = new.patient_id
        and t.limb = v_prev
        and t.is_active = true
        and (v_applied is null or t.applied_at = v_applied)
      order by t.applied_at desc
      limit 1
    );
  exception when others then
    null; -- e.g. same limb and application time already recorded; the event stays in the log
  end;
  return new;
end;
$function$;

revoke all on function public.project_tourniquet_followups() from public;
revoke execute on function public.project_tourniquet_followups() from anon, authenticated;

drop trigger if exists trg_project_tourniquet_followups on events;
create trigger trg_project_tourniquet_followups
after insert on events
for each row execute function public.project_tourniquet_followups();
