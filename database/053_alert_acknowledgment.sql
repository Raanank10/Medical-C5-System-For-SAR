-- Alert acknowledgment is shared across devices (WP-4, docs/GAP_CLOSURE_PLAN.md, V2.99.39).
--
-- Before this file, pressing "בטיפול" (in treatment) on a patient's alert only changed the phone
-- that pressed it: the client wrote a local timeline entry and bumped a counter that never cleared.
-- WATCHDOG_ACKNOWLEDGED was already in the event_type enum, the client sync list and sync-log
-- (SYSTEM_EVENTS, every role), but the client never sent it and nothing projected it. A CC or PC
-- on another device kept seeing the alert as unhandled, so command could not tell "nobody has seen
-- this" from "a medic is on it" (docs/PRODUCTION_READINESS.md).
--
-- Decision D4 (repo owner, 2026-10-20): both the event and server state.
--
-- What this adds:
-- - patients.alert_acknowledged_at / _by / _by_name / _by_role: the patient's current
--   acknowledgment. The client's alerts are computed per patient on each device (from triage,
--   vitals age, tourniquet time, ...), not read from watchdog_alerts, so the acknowledgment has to
--   live on the patient for other devices to honour it.
-- - project_alert_acknowledgment(): AFTER INSERT trigger on events.
--   - WATCHDOG_ACKNOWLEDGED (patient-scoped): sets the four columns, newest local_timestamp wins,
--     and marks that patient's open, unacknowledged watchdog_alerts rows acknowledged
--     (acknowledged_at / acknowledged_by), so the server-side watchdogs agree.
--   - WATCHDOG_ALERT with payload_json.reason = 'reescalated' (patient-scoped): the patient got worse
--     after the acknowledgment (red/black triage, critical vitals), so the device that saw it clears
--     its own acknowledgment and sends this. The server clears the four columns when the
--     acknowledgment is not newer than the re-escalation, so every device shows the alert again.
--     watchdog_alerts rows keep their acknowledged_at as history.
-- Any role may acknowledge (sync-log allows WATCHDOG_ACKNOWLEDGED for every role, as before): the
-- point is to show who is handling it, not to gate it. The role and name are read from profiles by
-- actor_id, never from events.actor_role.
--
-- Robustness (same as 044/050/052): nothing here raises. A raise in an AFTER INSERT trigger would
-- roll back the event insert and lose the field record. The event always stays in the log.

alter table patients add column if not exists alert_acknowledged_at timestamptz;
alter table patients add column if not exists alert_acknowledged_by uuid references profiles(id) on delete set null;
alter table patients add column if not exists alert_acknowledged_by_name text;
alter table patients add column if not exists alert_acknowledged_by_role user_role;

comment on column patients.alert_acknowledged_at is
  'local_timestamp of the newest WATCHDOG_ACKNOWLEDGED ("בטיפול") for this patient; cleared by a later WATCHDOG_ALERT re-escalation (database/053).';

create or replace function public.project_alert_acknowledgment()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role user_role;
  v_name text;
begin
  if new.patient_id is null or new.type not in ('WATCHDOG_ACKNOWLEDGED', 'WATCHDOG_ALERT') then
    return new;
  end if;

  select p.role, p.display_name into v_role, v_name from profiles p where p.id = new.actor_id;
  if v_role is null then
    return new;
  end if;

  if new.type = 'WATCHDOG_ACKNOWLEDGED' then
    update patients
    set alert_acknowledged_at = new.local_timestamp,
        alert_acknowledged_by = new.actor_id,
        alert_acknowledged_by_name = v_name,
        alert_acknowledged_by_role = v_role,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and (alert_acknowledged_at is null or alert_acknowledged_at <= new.local_timestamp);

    update watchdog_alerts
    set acknowledged_at = new.local_timestamp,
        acknowledged_by = new.actor_id,
        updated_at = now(),
        version = version + 1
    where patient_id = new.patient_id
      and acknowledged_at is null
      and resolved_at is null;
    return new;
  end if;

  -- WATCHDOG_ALERT: only an explicit re-escalation clears the acknowledgment.
  if coalesce(new.payload_json->>'reason', '') = 'reescalated' then
    update patients
    set alert_acknowledged_at = null,
        alert_acknowledged_by = null,
        alert_acknowledged_by_name = null,
        alert_acknowledged_by_role = null,
        updated_at = now(),
        version = version + 1
    where id = new.patient_id
      and alert_acknowledged_at is not null
      and alert_acknowledged_at <= new.local_timestamp;
  end if;
  return new;
end;
$function$;

revoke all on function public.project_alert_acknowledgment() from public;
revoke execute on function public.project_alert_acknowledgment() from anon, authenticated;

drop trigger if exists trg_project_alert_acknowledgment on events;
create trigger trg_project_alert_acknowledgment
after insert on events
for each row execute function public.project_alert_acknowledgment();
