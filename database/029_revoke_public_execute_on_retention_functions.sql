-- 028's `revoke all ... from anon, authenticated` was a no-op: these functions had never
-- received an individual grant to those roles - their actual reachability came from
-- Postgres's default `GRANT EXECUTE ... TO PUBLIC` on newly created functions, confirmed via
-- pg_proc.proacl showing a bare `=X/postgres` entry (PUBLIC). Every role, including anon/
-- authenticated, implicitly has PUBLIC's privileges, so get_advisors correctly flagged both
-- functions as callable via PostgREST RPC by anyone (including anon, unauthenticated). This
-- revokes the actual grant (PUBLIC), matching the same pattern already used elsewhere in this
-- schema (e.g. get_incident_command_state's ACL has no bare PUBLIC entry) - verified live via
-- get_advisors before/after: both functions no longer appear in the security advisor at all.
revoke all on function redact_expired_handover_token_credentials() from public;
revoke all on function redact_resolved_sync_ingestion_error_payloads() from public;
