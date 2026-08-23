-- Patient identity lifecycle: capture identity (name + identifying description) separately from
-- the immutable clinical event log, so it can be deleted once an incident's AAR is finalized
-- while the clinical record (triage, vitals, treatments, evacuation destination) stays permanent.
-- See docs/PATIENT_IDENTITY_LIFECYCLE.md for the full design rationale.
--
-- Why a separate write path instead of an event type: events are deliberately, absolutely
-- immutable (prevent_event_mutation() blocks every UPDATE/DELETE, no exceptions). Anything that
-- must later be deletable cannot flow through events even transiently - it needs its own path
-- straight to the mutable patients row. optional_name already exists on patients
-- (001_postgresql_schema_v1.2.sql) and has never been used by any event type or client code -
-- confirmed by direct trace this session, not assumed.
--
-- Both new patients columns are nullable with no default requirement: identity capture is always
-- optional. In a mass-casualty incident there is often no time to identify every patient, and
-- nothing about creating, triaging, treating, or handing off a patient may ever require a name.

alter table patients
  add column if not exists identifying_description text;

alter table incidents
  add column if not exists aar_finalized_at timestamptz,
  add column if not exists aar_finalized_by uuid references profiles(id);

-- Direct write path for identity, bypassing events entirely. Both parameters nullable - either
-- can be set independently (e.g. description known, name not, or vice versa).
create or replace function update_patient_identity(
  p_patient_id uuid,
  p_name text,
  p_identifying_description text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_incident_id uuid;
begin
  select incident_id into v_incident_id from patients where id = p_patient_id;
  if v_incident_id is null then
    raise exception 'patient % not found' , p_patient_id using errcode = 'P0002';
  end if;

  if not app.can_access_incident(v_incident_id) then
    raise exception 'access denied to incident %', v_incident_id using errcode = '42501';
  end if;

  if app.current_user_role() not in ('medic','pc','cc','chamal','admin') then
    raise exception 'role % may not write patient identity', app.current_user_role() using errcode = '42501';
  end if;

  update patients
  set optional_name = p_name,
      identifying_description = p_identifying_description,
      updated_at = now(),
      version = version + 1
  where id = p_patient_id;
end;
$$;

revoke execute on function update_patient_identity(uuid, text, text) from public;
revoke execute on function update_patient_identity(uuid, text, text) from anon;
grant execute on function update_patient_identity(uuid, text, text) to authenticated;

-- Purge trigger: command-role-only. Marks the incident's AAR finalized, then clears identity
-- (name + identifying description) for every patient in the incident. Clinical columns
-- (current_triage, last_vitals_at, handed_over_to, tourniquet history, etc.) are untouched -
-- "evacuated to Hospital X" is an operational fact, not personally identifying once it's no
-- longer tied to a name.
create or replace function finalize_incident_aar(p_incident_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not app.can_access_incident(p_incident_id) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;

  if not app.is_command_role() then
    raise exception 'role % may not finalize an AAR', app.current_user_role() using errcode = '42501';
  end if;

  update incidents
  set aar_finalized_at = now(),
      aar_finalized_by = auth.uid()
  where id = p_incident_id;

  update patients
  set optional_name = null,
      identifying_description = null,
      updated_at = now(),
      version = version + 1
  where incident_id = p_incident_id
    and (optional_name is not null or identifying_description is not null);
end;
$$;

revoke execute on function finalize_incident_aar(uuid) from public;
revoke execute on function finalize_incident_aar(uuid) from anon;
grant execute on function finalize_incident_aar(uuid) to authenticated;
