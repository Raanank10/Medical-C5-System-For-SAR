-- WP-25 hardening (after database/090 went live 2026-11-20). Two Supabase security-advisor
-- findings on 090's functions:
--
-- 1. incident_type_adder() and incident_type_may_remove() are SECURITY DEFINER and were granted
--    to authenticated. Neither checks incident access, so any signed-in user could call
--    /rest/v1/rpc/incident_type_adder for any incident id and learn who added a type (role,
--    profile id, time) to an incident they are not part of. Nothing outside the database calls
--    them: index.html never does, and 090's own SECURITY DEFINER functions (guard_incident_types,
--    project_incident_type_event, resolve_incident_type_report, change_incident_type) run as the
--    owner and keep their access. So execute is revoked from authenticated.
--
-- 2. incident_types_valid, incident_type_role_tier, incident_type_stamp and
--    incident_types_restamp had no fixed search_path ("function_search_path_mutable"). They read
--    no tables and use only built-ins (always resolved from pg_catalog), so an empty search_path
--    changes nothing in what they do. incident_types_valid backs the incidents check constraint;
--    altering its settings does not rewrite or recheck the table.

revoke execute on function public.incident_type_adder(uuid, text) from authenticated;
revoke execute on function public.incident_type_may_remove(uuid, text, uuid, text) from authenticated;

alter function public.incident_types_valid(text[]) set search_path = '';
alter function public.incident_type_role_tier(text) set search_path = '';
alter function public.incident_type_stamp(uuid, text, text, timestamptz) set search_path = '';
alter function public.incident_types_restamp(jsonb, text[], text[], jsonb) set search_path = '';
