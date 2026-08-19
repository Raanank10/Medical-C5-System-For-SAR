-- The V2.995 rescue-chain feature (rpc/rcc first-responder report + site
-- authority) emits three event types the deployed event_type enum never
-- had: FIRST_RESPONDER_REPORT, OFFICIAL_INCIDENT_OPENED_BY_RESCUE,
-- INCIDENT_CLOSE_TOGGLED (confirmed via index.html's saveLocalEvent calls).
-- BUILDING_STATUS_UPDATED and SITE_CLEAR_CONFIRMED were already present.
-- Without this, those three event types would be silently quarantined by
-- any sync endpoint as unparseable envelopes the moment a real rpc/rcc
-- device tried to sync. Found and fixed while building the sync-log
-- Edge Function (supabase/functions/sync-log), before it ever hit the gap
-- for real.

alter type event_type add value if not exists 'FIRST_RESPONDER_REPORT';
alter type event_type add value if not exists 'OFFICIAL_INCIDENT_OPENED_BY_RESCUE';
alter type event_type add value if not exists 'INCIDENT_CLOSE_TOGGLED';
