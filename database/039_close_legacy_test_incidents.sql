-- Close the two seeded test incidents (TEST-INC-A / TEST-INC-B) that index.html used to
-- hardcode as its only push/pull targets (SITE_TO_INCIDENT_ID). From V2.99.23 logged-in mode
-- works only inside incidents opened from the field (database/038), so these two would
-- otherwise sit in every user's open-incident list forever, with stale August test patients
-- whose timers all read overdue.
--
-- Closed, not deleted (docs/OPERATIONS_SAFETY.md: never remove audit history): incident rows,
-- patients, events and memberships all stay; existing members can still read them. Idempotent.

update incidents
set status = 'closed',
    closed_at = coalesce(closed_at, now()),
    metadata = metadata || jsonb_build_object(
      'closed_reason', 'legacy hardcoded test incident, superseded by the real incident lifecycle (database/038, V2.99.23)'),
    updated_at = now(),
    version = version + 1
where id in ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2')
  and status <> 'closed';
