-- Evacuation tracking (V2.99.31) - projection. Depends on 042's enum values.
--
-- Gaps found 2026-10-17 (checked live):
-- - The client's handover always sent destination_facility:'pending', so project_patient_state()
--   wrote the literal string 'pending' into patients.handed_over_to for every handed-over patient.
--   Nothing recorded where a casualty was actually taken, or how MDA classified them.
-- - External reports (MDA / police / ...) never left the device that entered them: the client
--   never sent EXTERNAL_REPORT_CREATED, so external_reports had 0 rows and a CC on another
--   device never saw a report a PC entered.
--
-- What this adds:
-- - patients.evacuation_destination / mda_classification / evacuation_updated_at, written from
--   PATIENT_HANDED_OVER (when the fields are present) and PATIENT_EVACUATION_UPDATED. The MDA
--   classification sits beside current_triage and never changes it (src/domain/rules.js
--   MDA_CLASSIFICATIONS / mdaClassificationDiffersFromTriage).
-- - external_reports rows from EXTERNAL_REPORT_CREATED, idempotent by source_event_id, plus an
--   external_patient_links row when the report names a patient of the same incident.
--
-- Deliberately a separate trigger, not another branch in project_patient_state(): that function
-- carries the triage-authority logic (021/041) and redefining all of it to add two columns would
-- risk exactly the copy drift those files warn about. It never touches triage or status.
--
-- Robustness: bad payload values are ignored, never raised. A raise inside an AFTER INSERT
-- trigger would roll back the event insert itself and lose the field record, so an unknown MDA
-- value, a non-numeric count or a malformed patient id simply does not project.
--
-- Ordering: an older offline update that syncs late must not overwrite a newer one, so the
-- patient fields only move forward in local_timestamp (same idea as the 5-minute triage rule,
-- without role authority: destination and MDA classification are reported facts, not clinical
-- decisions).

alter table patients add column if not exists evacuation_destination text;
alter table patients add column if not exists mda_classification text;
alter table patients add column if not exists evacuation_updated_at timestamptz;

do $$ begin
  alter table patients add constraint chk_patients_mda_classification
    check (mda_classification is null or mda_classification in ('minor','anxiety','moderate','serious','critical','deceased'));
exception when duplicate_object then null; end $$;

comment on column patients.evacuation_destination is
  'Where the casualty was taken (hospital / receiving facility), from PATIENT_HANDED_OVER or PATIENT_EVACUATION_UPDATED (database/043).';
comment on column patients.mda_classification is
  'Magen David Adom''s own classification (minor/anxiety/moderate/serious/critical/deceased). Beside current_triage, never replaces it (database/043).';

alter table external_reports add column if not exists source_event_id uuid references events(id) on delete set null;
create unique index if not exists idx_external_reports_source_event on external_reports(source_event_id) where source_event_id is not null;

create or replace function public.project_evacuation_tracking()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_destination text;
  v_mda text;
  v_report_id uuid;
  v_source text;
  v_linked text;
begin
  if new.type in ('PATIENT_HANDED_OVER','PATIENT_EVACUATION_UPDATED') and new.patient_id is not null then
    v_destination := nullif(btrim(coalesce(new.payload_json->>'destination_facility','')), '');
    -- Pre-V2.99.31 clients sent the placeholder 'pending'; it is not a destination.
    if v_destination = 'pending' then v_destination := null; end if;
    v_mda := new.payload_json->>'mda_classification';
    if v_mda is not null and v_mda not in ('minor','anxiety','moderate','serious','critical','deceased') then
      v_mda := null;
    end if;

    if v_destination is not null or v_mda is not null then
      update patients
      set evacuation_destination = coalesce(v_destination, evacuation_destination),
          mda_classification = coalesce(v_mda, mda_classification),
          evacuation_updated_at = new.local_timestamp,
          updated_at = now(),
          version = version + 1
      where id = new.patient_id
        and (evacuation_updated_at is null or evacuation_updated_at <= new.local_timestamp);
    end if;

  elsif new.type = 'EXTERNAL_REPORT_CREATED' then
    v_source := new.payload_json->>'source';
    if v_source is null or v_source not in ('mda','united_hatzalah','yedidim','police','idf','civilian','other') then
      v_source := 'other';
    end if;

    insert into external_reports (
      incident_id, source, external_reference,
      reported_red, reported_yellow, reported_green, reported_black,
      evacuation_destination, notes, created_by, source_event_id
    )
    values (
      new.incident_id,
      v_source::external_source,
      left(new.payload_json->>'external_reference', 200),
      case when new.payload_json->>'reported_red' ~ '^[0-9]{1,5}$' then (new.payload_json->>'reported_red')::integer else 0 end,
      case when new.payload_json->>'reported_yellow' ~ '^[0-9]{1,5}$' then (new.payload_json->>'reported_yellow')::integer else 0 end,
      case when new.payload_json->>'reported_green' ~ '^[0-9]{1,5}$' then (new.payload_json->>'reported_green')::integer else 0 end,
      case when new.payload_json->>'reported_black' ~ '^[0-9]{1,5}$' then (new.payload_json->>'reported_black')::integer else 0 end,
      nullif(btrim(coalesce(new.payload_json->>'evacuation_destination','')), ''),
      nullif(btrim(coalesce(new.payload_json->>'notes','')), ''),
      new.actor_id,
      new.id
    )
    on conflict (source_event_id) where source_event_id is not null do nothing
    returning id into v_report_id;

    -- Kept in the payload (not events.patient_id) so a report about a patient this device never
    -- synced cannot fail the events FK and lose the report itself.
    v_linked := new.payload_json->>'linked_patient_id';
    if v_report_id is not null and v_linked ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      insert into external_patient_links (external_report_id, patient_id, match_score, match_reason, linked_by)
      select v_report_id, p.id, 100, jsonb_build_object('method','manual_late_update','event_id',new.id), new.actor_id
      from patients p
      where p.id = v_linked::uuid and p.incident_id = new.incident_id
      on conflict (external_report_id, patient_id) do nothing;
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.project_evacuation_tracking() from public;

drop trigger if exists trg_project_evacuation_tracking on events;
create trigger trg_project_evacuation_tracking
after insert on events
for each row execute function public.project_evacuation_tracking();
