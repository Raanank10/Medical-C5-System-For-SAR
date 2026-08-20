-- Fixes a real RLS gap found while building the poison-event review panel
-- (docs/ROADMAP.md Phase 3): sync_ingestion_errors_read_command only checked
-- app.is_command_role(), with no app.can_access_incident() check at all -
-- unlike every sibling command-read policy in this schema (e.g.
-- aar_context_notes_read_command). A pc/cc/chamal/admin account could read
-- another incident's quarantined/malformed events, including raw_payload,
-- not just their own incident's.
--
-- incident_id is nullable on this table (set null on incident delete, and a
-- sufficiently malformed envelope may never resolve an incident_id at all) -
-- such orphan rows aren't scoped to any incident, so they stay visible to
-- any command role rather than becoming permanently invisible to everyone.

drop policy if exists sync_ingestion_errors_read_command on sync_ingestion_errors;
create policy sync_ingestion_errors_read_command on sync_ingestion_errors
  for select to authenticated
  using (app.is_command_role() and (incident_id is null or app.can_access_incident(incident_id)));
