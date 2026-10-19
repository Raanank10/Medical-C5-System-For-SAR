-- Pre-evacuation report (V2.99.35) - enum value only. 049 projects it.
--
-- Kept in its own file, like 043 before 044: a new enum value cannot be used in the same
-- transaction that adds it, so applying this and the projection as one migration fails.
--
-- SITE_PRE_EVACUATION_REPORTED: casualties who left the site before the medical force arrived
-- (evacuated by MDA, United Hatzalah, civilians, ...). One event carries the whole report as
-- groups of {count, condition, evacuated_by, destination}; each later event replaces it.
-- Who may write it is decided in 049, not here.

alter type event_type add value if not exists 'SITE_PRE_EVACUATION_REPORTED';
