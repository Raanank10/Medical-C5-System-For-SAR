-- Real command-dashboard reads (docs/API_SURFACE_v1.2.md "Command Dashboard API",
-- docs/ROADMAP.md Phase 3: "Real command-dashboard reads").
--
-- incident_command_state has RLS disabled and all grants revoked from anon/authenticated
-- (001_postgresql_schema_v1.2.sql: "revoke all on incident_command_state from anon,
-- authenticated") by design - it's a service-role-only precomputed snapshot table, meant to be
-- read through a server-side API with its own permission check, not queried directly by
-- clients. This is that permission check: one SECURITY DEFINER function performing the same
-- app.can_access_incident() gate used everywhere else in this schema, then returning the
-- precomputed row. Matches docs/API_SURFACE_v1.2.md's "This endpoint uses one API-level
-- permission check" for GET /command/incidents/:incidentId/state.

create or replace function get_incident_command_state(p_incident_id uuid)
returns incident_command_state
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  result incident_command_state;
begin
  if not app.can_access_incident(p_incident_id) then
    raise exception 'access denied to incident %', p_incident_id using errcode = '42501';
  end if;
  select * into result from incident_command_state where incident_id = p_incident_id;
  return result; -- an all-null row if the incident has no synced events yet, not an error
end;
$$;

-- Postgres/PostgREST grants EXECUTE on new functions broadly by default; without an explicit
-- revoke, Supabase's security advisor flags this as callable by `anon` too (verified live -
-- functionally harmless since app.can_access_incident() still blocks an unauthenticated caller,
-- but tightened anyway per the advisor's own recommendation rather than leaving it looser than
-- intended).
revoke execute on function get_incident_command_state(uuid) from public;
revoke execute on function get_incident_command_state(uuid) from anon;
grant execute on function get_incident_command_state(uuid) to authenticated;
