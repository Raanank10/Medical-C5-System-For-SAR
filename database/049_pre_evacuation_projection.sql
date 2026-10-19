-- Pre-evacuation report (V2.99.35) - projection and lock. Depends on 048's enum value.
--
-- Requirement (repo owner, 2026-10-19): casualties evacuated from the site before the medical
-- force arrived are entered once, by the first medical staff on site. After that only the PC
-- (חוג״ד) and CC (מ״פ רפואה) may change the report. It must be clear who evacuated them, where
-- to, and in what condition (light / moderate / severe).
--
-- Before this file the en-route screen kept three local counters (light / moderate / severe) plus
-- one free-text note and one "report source". None of it reached the server: SITE_ARRIVAL_CONFIRMED
-- and SITE_EXTRACTED_COUNTER_UPDATED are not in the sync vocabulary, so a PC or CC on another
-- device never saw it, and any role on any device could change the counters.
--
-- What this adds:
-- - incident_pre_evacuations: one row per incident (in logged-in mode a site is an incident,
--   database/045), holding the current report as groups of
--   {count, condition, evacuated_by, destination}, the first reporter and the last editor.
-- - project_pre_evacuation(): AFTER INSERT trigger on events for SITE_PRE_EVACUATION_REPORTED.
--
-- Lock rule ("first to sync wins", decided with the repo owner 2026-10-19):
-- - No row yet: a medical role (medic / paramedic / physician / pc / cc, and admin per D7) creates
--   it. insert ... on conflict do nothing makes this atomic: when two medics sync at the same
--   moment, exactly one insert wins.
-- - Row exists: only pc / cc / admin replace it. Same "newest local_timestamp wins" rule as 044,
--   so a late-syncing older offline edit cannot overwrite a newer one.
-- - Anyone else (a second medic, or the first medic sending again): the event stays in the
--   append-only log as the audit record, the report does not change, and a conflict_log row
--   (PRE_EVACUATION_REPORT_LOCKED) lets command see the rejected version.
-- The role is read from profiles by actor_id, never from events.actor_role: events_insert_by_role
-- checks actor_id = auth.uid() but takes actor_role from the client row as written.
--
-- Robustness (same as 044): bad payload values are dropped, never raised. A raise in an AFTER
-- INSERT trigger would roll back the event insert and lose the field record.

create table if not exists incident_pre_evacuations (
  incident_id uuid primary key references incidents(id) on delete cascade,
  groups jsonb not null default '[]'::jsonb,
  note text,
  light_count integer not null default 0,
  moderate_count integer not null default 0,
  severe_count integer not null default 0,
  total_count integer not null default 0,
  reported_by uuid references profiles(id) on delete set null,
  reported_by_name text,
  reported_by_role user_role,
  reported_at timestamptz not null,
  reported_event_id uuid references events(id) on delete set null,
  updated_by uuid references profiles(id) on delete set null,
  updated_by_name text,
  updated_by_role user_role,
  updated_at timestamptz not null,
  last_event_id uuid references events(id) on delete set null,
  version integer not null default 1
);

comment on table incident_pre_evacuations is
  'Casualties evacuated before the medical force arrived, per incident. Written only by project_pre_evacuation() from SITE_PRE_EVACUATION_REPORTED events: first medical reporter creates it, then only pc/cc/admin may replace it (database/049).';
comment on column incident_pre_evacuations.groups is
  'Array of {count, condition: light|moderate|severe, evacuated_by, destination}.';
comment on column incident_pre_evacuations.updated_at is
  'local_timestamp of the event that last changed the report (newest wins), not server time.';

alter table incident_pre_evacuations enable row level security;

drop policy if exists pre_evacuations_read on incident_pre_evacuations;
create policy pre_evacuations_read on incident_pre_evacuations for select to authenticated
  using (app.can_access_incident(incident_id));
-- No insert / update / delete policy: only the security definer trigger below writes it.

create or replace function public.project_pre_evacuation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role user_role;
  v_name text;
  v_groups jsonb := '[]'::jsonb;
  v_light integer := 0;
  v_moderate integer := 0;
  v_severe integer := 0;
  v_note text;
  v_item jsonb;
  v_count integer;
  v_condition text;
  v_by text;
  v_dest text;
  v_created uuid;
  v_owner record;
begin
  if new.type <> 'SITE_PRE_EVACUATION_REPORTED' or new.incident_id is null then
    return new;
  end if;

  select p.role, p.display_name into v_role, v_name from profiles p where p.id = new.actor_id;
  if v_role is null then
    return new;
  end if;

  if jsonb_typeof(new.payload_json->'groups') = 'array' then
    for v_item in select value from jsonb_array_elements(new.payload_json->'groups') limit 50 loop
      continue when jsonb_typeof(v_item) <> 'object';
      continue when coalesce(v_item->>'count','') !~ '^[0-9]{1,4}$';
      v_count := (v_item->>'count')::integer;
      continue when v_count < 1;
      v_condition := v_item->>'condition';
      continue when v_condition is null or v_condition not in ('light','moderate','severe');
      v_by := v_item->>'evacuated_by';
      if v_by is null or v_by not in ('mda','united_hatzalah','yedidim','fire','police','idf','civilian','self','other') then
        v_by := 'other';
      end if;
      v_dest := nullif(left(btrim(coalesce(v_item->>'destination','')), 200), '');
      v_groups := v_groups || jsonb_build_array(jsonb_build_object(
        'count', v_count, 'condition', v_condition, 'evacuated_by', v_by, 'destination', v_dest));
      if v_condition = 'light' then v_light := v_light + v_count;
      elsif v_condition = 'moderate' then v_moderate := v_moderate + v_count;
      else v_severe := v_severe + v_count;
      end if;
    end loop;
  end if;
  v_note := nullif(left(btrim(coalesce(new.payload_json->>'note','')), 500), '');

  -- First report: any medical role. Atomic against a concurrent first report.
  if v_role in ('medic','paramedic','physician','pc','cc','admin') then
    insert into incident_pre_evacuations (
      incident_id, groups, note, light_count, moderate_count, severe_count, total_count,
      reported_by, reported_by_name, reported_by_role, reported_at, reported_event_id,
      updated_by, updated_by_name, updated_by_role, updated_at, last_event_id
    )
    values (
      new.incident_id, v_groups, v_note, v_light, v_moderate, v_severe, v_light + v_moderate + v_severe,
      new.actor_id, v_name, v_role, new.local_timestamp, new.id,
      new.actor_id, v_name, v_role, new.local_timestamp, new.id
    )
    on conflict (incident_id) do nothing
    returning incident_id into v_created;
    if v_created is not null then
      return new;
    end if;
  end if;

  -- Report exists: only pc / cc / admin may replace it, newest local_timestamp wins.
  if v_role in ('pc','cc','admin') then
    update incident_pre_evacuations
    set groups = v_groups,
        note = v_note,
        light_count = v_light,
        moderate_count = v_moderate,
        severe_count = v_severe,
        total_count = v_light + v_moderate + v_severe,
        updated_by = new.actor_id,
        updated_by_name = v_name,
        updated_by_role = v_role,
        updated_at = new.local_timestamp,
        last_event_id = new.id,
        version = version + 1
    where incident_id = new.incident_id
      and updated_at <= new.local_timestamp;
    -- An older offline edit that synced late is simply superseded; the event stays in the log.
    return new;
  end if;

  -- Locked: keep the event as the audit record, leave the report, tell command.
  select reported_by, reported_by_name, reported_by_role into v_owner
  from incident_pre_evacuations where incident_id = new.incident_id;
  if found then
    insert into conflict_log (incident_id, event_id, actor_id, conflict_type, severity, reason, description, payload_json)
    values (
      new.incident_id, new.id, new.actor_id, 'PRE_EVACUATION_REPORT_LOCKED', 'medium', 'pre_evacuation_locked',
      'Pre-evacuation report already entered by the first medical reporter; only pc/cc may change it. This version was kept in the event log and not applied.',
      jsonb_build_object(
        'event_id', new.id,
        'rejected_role', v_role,
        'rejected_name', v_name,
        'owner_id', v_owner.reported_by,
        'owner_name', v_owner.reported_by_name,
        'owner_role', v_owner.reported_by_role,
        'groups', v_groups,
        'note', v_note
      )
    );
  end if;
  return new;
end;
$function$;

revoke all on function public.project_pre_evacuation() from public;
revoke execute on function public.project_pre_evacuation() from anon, authenticated;

drop trigger if exists trg_project_pre_evacuation on events;
create trigger trg_project_pre_evacuation
after insert on events
for each row execute function public.project_pre_evacuation();
