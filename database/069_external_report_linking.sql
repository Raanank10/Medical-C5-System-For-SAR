-- Linking an external report to a patient later (docs/GAP_CLOSURE_PLAN.md WP-16 PR B, step 5;
-- owner 2026-10-22). Depends on 044 (external_reports projection) and 068 (stored AAR).
--
-- Before this, a report could name a patient only when it was created from that patient's card
-- ("הוסף עדכון לפצוע מחולץ", payload linked_patient_id, database/044). A report entered first
-- (an MDA count, a police list) could never be tied to a casualty afterwards, so the stored
-- after-action report could not say which field casualties an outside report covered.
-- EXTERNAL_REPORT_LINKED was in the sync list but no client ever sent it and nothing projected it.
--
-- 1. project_evacuation_tracking() gains an EXTERNAL_REPORT_LINKED branch:
--    - payload: external_report_id (the server row id) or external_reference (the id the
--      creating phone gave the report, for one not yet seen from the server), and optional
--      action 'unlink'; the patient is the event's own patient_id;
--    - only the roles that may create reports (pc, cc, chamal, physician, admin, the same list
--      as sync-log's EXTERNAL_REPORT_EVENTS) and only when the report and the patient are both
--      in the event's incident; anything else is ignored, never raised (a raise would roll back
--      the event and lose the audit record);
--    - a link never changes triage, status, destination or MDA classification. The client sends
--      MDA's classification for the patient as its own PATIENT_EVACUATION_UPDATED (044).
--    Every link and unlink stays in the events log; external_patient_links is the current view.
--    Known limit: an unlink leaves no tombstone, so a link recorded offline before an unlink but
--    synced after it re-creates the link. Two command phones offline on the same report.
-- 2. Clients no longer write external_reports or external_patient_links directly. The direct
--    insert/update/delete policies let pc/cc/chamal/physician/admin add, edit or delete reports
--    and links with no event (no audit), without the same-incident check, and after the close.
--    The client never used them (it only reads); the projection is SECURITY DEFINER. ALTER
--    POLICY, nothing dropped (same as aar_reports in 068).
-- 3. The stored report gets an external_reports section: reports by source, the counts they
--    reported, how many field casualties were linked, and MDA vs field triage for the linked
--    ones. app.build_incident_aar() from 068 is renamed to app.build_incident_aar_base() and
--    wrapped, so 068's body is not copied here and cannot drift.

-- ---------------------------------------------------------------------------------------------
-- 1. Projection
-- ---------------------------------------------------------------------------------------------
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
  v_ref text;
begin
  if new.type in ('PATIENT_HANDED_OVER','PATIENT_EVACUATION_UPDATED') and new.patient_id is not null then
    v_destination := nullif(btrim(coalesce(new.payload_json->>'destination_facility','')), '');
    -- Pre-V2.99.33 clients sent the placeholder 'pending'; it is not a destination.
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

  elsif new.type = 'EXTERNAL_REPORT_LINKED' and new.patient_id is not null
        and new.actor_role::text in ('pc','cc','chamal','physician','admin') then
    v_linked := new.payload_json->>'external_report_id';
    if v_linked ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select er.id into v_report_id from external_reports er
      where er.id = v_linked::uuid and er.incident_id = new.incident_id;
    end if;
    if v_report_id is null then
      v_ref := left(new.payload_json->>'external_reference', 200);
      if v_ref is not null then
        select er.id into v_report_id from external_reports er
        where er.incident_id = new.incident_id and er.external_reference = v_ref
        order by er.created_at limit 1;
      end if;
    end if;

    if v_report_id is not null
       and exists (select 1 from patients p where p.id = new.patient_id and p.incident_id = new.incident_id) then
      if new.payload_json->>'action' = 'unlink' then
        delete from external_patient_links
        where external_report_id = v_report_id and patient_id = new.patient_id;
      else
        insert into external_patient_links (external_report_id, patient_id, match_score, match_reason, linked_by)
        values (v_report_id, new.patient_id, 100,
                jsonb_build_object('method','manual_link','event_id',new.id), new.actor_id)
        on conflict (external_report_id, patient_id) do nothing;
      end if;
    end if;
  end if;

  return new;
end;
$function$;

revoke all on function public.project_evacuation_tracking() from public;

-- ---------------------------------------------------------------------------------------------
-- 2. No direct client writes
-- ---------------------------------------------------------------------------------------------
alter policy external_reports_insert on external_reports with check (false);
alter policy external_reports_update on external_reports using (false) with check (false);
alter policy external_reports_delete on external_reports using (false);
alter policy external_patient_links_insert on external_patient_links with check (false);
alter policy external_patient_links_update on external_patient_links using (false) with check (false);
alter policy external_patient_links_delete on external_patient_links using (false);

-- ---------------------------------------------------------------------------------------------
-- 3. External reports in the stored report
-- ---------------------------------------------------------------------------------------------
alter function app.build_incident_aar(uuid) rename to build_incident_aar_base;

create or replace function app.build_incident_aar(p_incident_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select app.build_incident_aar_base(p_incident_id) || jsonb_build_object(
    'external_reports', jsonb_build_object(
      'total', (select count(*) from external_reports where incident_id = p_incident_id),
      'by_source', coalesce((select jsonb_object_agg(s, n) from (select source::text s, count(*) n from external_reports
                              where incident_id = p_incident_id group by 1) x), '{}'::jsonb),
      'reported', (select jsonb_build_object('red', coalesce(sum(reported_red), 0), 'yellow', coalesce(sum(reported_yellow), 0),
                                             'green', coalesce(sum(reported_green), 0), 'black', coalesce(sum(reported_black), 0))
                   from external_reports where incident_id = p_incident_id),
      'linked_patients', (select count(distinct l.patient_id) from external_patient_links l
                          join external_reports er on er.id = l.external_report_id where er.incident_id = p_incident_id),
      'linked_mda_vs_field', coalesce((select jsonb_agg(jsonb_build_object('field_triage', t, 'mda_classification', m, 'count', n))
                               from (select coalesce(p.current_triage::text, 'unknown') t, coalesce(p.mda_classification, 'unknown') m, count(*) n
                                     from patients p
                                     where p.incident_id = p_incident_id
                                       and exists (select 1 from external_patient_links l join external_reports er on er.id = l.external_report_id
                                                   where l.patient_id = p.id and er.incident_id = p_incident_id)
                                     group by 1, 2) x), '[]'::jsonb)))
$$;
revoke execute on function app.build_incident_aar(uuid) from public, anon, authenticated;
revoke execute on function app.build_incident_aar_base(uuid) from public, anon, authenticated;
