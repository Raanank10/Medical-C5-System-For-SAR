-- Real RLS-vs-documented-authorization mismatch, found while scoping the kit-templates work
-- (not previously noticed or documented anywhere): both the client's in-app AUTH_MATRIX and
-- C5_SENTINEL_SAR_MVP_SPEC_v1.2.md's auth table say cc can manage kit templates, but
-- database/005_rls_performance_fixes.sql's kit_templates_insert/update/delete and
-- kit_template_items_insert/update/delete policies only ever granted pc/logistics_officer/admin
-- - cc has never actually been able to write to either table. physician is a separate case: the
-- client's AUTH_MATRIX claims physician:'yes' here too, but per explicit product direction
-- physician should stay focused on treatment, not logistics/admin config - that claim is wrong
-- and is corrected client-side (AUTH_MATRIX), not by widening RLS to match it.
--
-- Re-creates the four write policies (drop + create, matching this schema's own convention for
-- policy changes, e.g. 019/020) with cc added and the 005-era current_user_role() calls wrapped
-- in a scalar subquery, matching 005's own later performance-fix style rather than 004's
-- original unwrapped one.

drop policy if exists kit_templates_insert on kit_templates;
create policy kit_templates_insert on kit_templates for insert to authenticated with check ((select app.current_user_role()) in ('pc','cc','logistics_officer','admin'));

drop policy if exists kit_templates_update on kit_templates;
create policy kit_templates_update on kit_templates for update to authenticated using ((select app.current_user_role()) in ('pc','cc','logistics_officer','admin')) with check ((select app.current_user_role()) in ('pc','cc','logistics_officer','admin'));

drop policy if exists kit_templates_delete on kit_templates;
create policy kit_templates_delete on kit_templates for delete to authenticated using ((select app.current_user_role()) in ('pc','cc','logistics_officer','admin'));

drop policy if exists kit_template_items_insert on kit_template_items;
create policy kit_template_items_insert on kit_template_items for insert to authenticated with check ((select app.current_user_role()) in ('pc','cc','logistics_officer','admin'));

drop policy if exists kit_template_items_update on kit_template_items;
create policy kit_template_items_update on kit_template_items for update to authenticated using ((select app.current_user_role()) in ('pc','cc','logistics_officer','admin')) with check ((select app.current_user_role()) in ('pc','cc','logistics_officer','admin'));

drop policy if exists kit_template_items_delete on kit_template_items;
create policy kit_template_items_delete on kit_template_items for delete to authenticated using ((select app.current_user_role()) in ('pc','cc','logistics_officer','admin'));
