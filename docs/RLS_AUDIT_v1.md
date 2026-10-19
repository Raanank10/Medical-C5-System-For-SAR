# RLS / Authorization Audit v1

This is the systematic, full-coverage pass that `docs/THREAT_MODEL.md`'s T1 ("RLS/authorization gap grants access across roles or incidents") calls for: every RLS policy and every `SECURITY DEFINER` function's internal authorization logic, checked against the codebase's own established convention — not another incidental spot-check. Everything below was checked against the **live** Supabase project (`btvvjmuwdzirjyauyijx`), not the migration files, since later migration files overwrite earlier ones and only the live/effective state is what actually governs access. Ground truth was pulled via `pg_policies`, `pg_proc`/`pg_get_functiondef`, `information_schema.role_table_grants`/`role_routine_grants`, and `mcp__Supabase__get_advisors`.

Verdicts: **PASS** (matches convention, no issue), **PASS-NOTE** (correct today, but relies on something fragile worth watching), **FAIL** (real gap, fixed in this session — see migration referenced).

## The convention everything is checked against

`app.current_user_role()`, `app.is_command_role()`, `app.can_access_incident(p_incident_id)`, `app.can_write_incident_event(p_incident_id)`, `app.can_write_clinical_event(role_in)` (`database/001_postgresql_schema_v1.2.sql:2007-2073`, `app` schema — not exposed via PostgREST RPC, only reachable from within other SQL/policies). Every prior real gap (`013`-`016`) was a deviation from this convention. This audit's method is checking every policy/function against it.

## Summary of findings

Two real, live gaps were found and fixed (`database/017_lock_out_inactive_profiles.sql`); everything else checked out. Both concern the **same root cause**: `profiles.is_active` was not actually enforced everywhere the codebase's own documentation (`docs/THREAT_MODEL.md` T4/T8) claimed it was.

1. **`app.current_user_role()` did not filter on `is_active`.** Since every RLS policy's role/incident check is built on this function (directly or via `app.is_command_role()`/`app.can_access_incident()`/`app.can_write_incident_event()`), a deactivated profile (`is_active = false`) was **not** actually locked out of RLS-gated table access — only the `sync-log` Edge Function's own separate, explicit `is_active` check (`supabase/functions/sync-log/index.ts:145`) enforced it, and that only covers event ingestion, not the many tables (`patients`, `incidents`, `device_presence`, `incident_memberships`, etc.) that also have direct PostgREST INSERT/UPDATE/SELECT policies. This contradicts `docs/THREAT_MODEL.md`'s T8 claim that "`is_active=false` is checked everywhere (RLS, sync-log)" — it was not checked in RLS at all.
2. **The live `handle_new_user()` trigger function did not set `is_active`.** `database/011_handle_new_user_reads_role_from_metadata.sql` documents (and its own commit message claims verified) that an invite with a missing/invalid role gets `is_active=false` so the account fails closed rather than landing as a fully active, plausible-looking `medic`. The live function body (pulled via `pg_get_functiondef`, not the migration file) omits `is_active` from its `insert into profiles (...)` entirely, so it silently takes the table's column default (`true`). Combined with finding 1, a signup with a missing/mistyped role in the invite metadata got a fully active `medic` account with full medic-level RLS access — the exact "onboarding mistake" scenario T8 describes as mitigated was not actually mitigated live. Root cause of the drift wasn't identified (no evidence of who/what changed the function after `011`); it may never have applied cleanly, or was hand-edited later. Fixed by redeploying the function per `011`'s documented logic.

Neither gap is a cross-incident/cross-role privilege escalation for an *active* account — the class of bug T1 primarily worries about (`013`-`016`) — but both are real defects in the account-deactivation control path, which is a documented, load-bearing safety mechanism (T4, T8), not a hypothetical one.

**Addendum**: `database/020_physician_paramedic_rls.sql` (F3, `docs/CONFLICT_RESOLUTION_DECISION.md`) later re-issued roughly 30 of the 86 policies below to add `physician`/`paramedic` to their role lists, and widened `app.is_command_role()`/`app.can_access_incident()`/`app.can_write_clinical_event()`. Every predicate was reproduced verbatim from its live state (pulled via `pg_policies` immediately before writing that migration) plus the new role(s) — no shape was invented, and the total policy count is unchanged (86, confirmed live) since no table gained or lost a policy, only role lists within existing ones changed. Two follow-up gaps in that same migration were found afterward and fixed live: `events_insert_by_role` was missing `physician` from its own inline role array (`database/022`), and `high_risk_override_insert` was missing both `paramedic` (despite `020`'s own header comment saying it should be included) and `physician` (`database/023`) — both found by live testing, not migration-file review. The per-table table below reflects the audit's original point-in-time state and was not re-verified row-by-row after `020`/`022`/`023` — re-running this checklist after any further schema change remains the documented practice, not a one-time audit.

**Second addendum**: `database/025_physician_death_confirmation.sql` added a 33rd table, `death_confirmations` (2 policies: `death_confirmations_read` — command role or self, same shape as every other command-tier table above; `death_confirmations_insert` — physician-only, the one deliberately single-role, no-array policy in the schema), bringing the live total to 33 tables / 88 policies. Live testing found a real gap the same pattern as `022`/`023` above: `death_confirmations_insert` alone does **not** actually stop a non-physician from creating a `death_confirmations` row, because the row is written by `project_patient_state()`'s trigger, which is `SECURITY DEFINER` and bypasses that table's RLS entirely for its own insert — the policy only ever gated a hypothetical *direct* client write to the table. The real fix had to go on `events_insert_by_role` itself (`database/026_events_death_confirmed_physician_only.sql`): a narrow, event-type-specific carve-out (`type <> 'PATIENT_DEATH_CONFIRMED' or actor_role = 'physician'`) — the first time any policy in this schema has gated by event `type` rather than purely by role. Verified live: a paramedic-impersonated direct `events` insert of `PATIENT_DEATH_CONFIRMED` is denied post-fix (succeeded pre-fix); a physician's own insert still succeeds and correctly projects into both `patients` and `death_confirmations`; an unrelated event type from a non-physician command role is unaffected.

## RLS policies — 32 tables, 86 policies (all reviewed)

| Table | Policies | Verdict | Note |
|---|---|---|---|
| aar_context_notes | 2 | PASS | `app.is_command_role() AND app.can_access_incident(incident_id)` on both. |
| aar_reports | 4 | PASS | Same shape on all 4 (select/insert/update/delete). |
| conflict_log | 1 | PASS | Command-role + incident-scoped read only; writes are trigger-only (see functions below), no direct client write policy — correct, matches "conflict_log is audit output, not client-editable." |
| device_presence | 4 | PASS | `can_access_incident` AND (self `actor_id` OR command role) on write; self-or-command is the right shape for a presence heartbeat table. |
| device_sync_state | 4 | PASS | Same shape as device_presence; `incident_id IS NULL` branch correctly handles pre-incident-assignment device state. |
| events | 2 | PASS | Insert: `actor_id = auth.uid()` AND `can_access_incident` AND (`can_write_clinical_event(actor_role)` OR actor_role in the explicitly-listed non-clinical write roles). Read: `can_access_incident`. This is the core event-sourcing gate and it's correctly incident + role scoped. |
| experiment_observer_notes | 2 | PASS | `can_access_incident` + self `actor_id` on write. |
| external_patient_links | 4 | PASS | Scoped via `EXISTS (... external_reports er WHERE er.id = ... AND can_access_incident(er.incident_id))` — correct transitive incident scoping through the parent table, the same class of join `015` fixed elsewhere. |
| external_reports | 4 | PASS | Direct `can_access_incident` + command-role gate on write. |
| high_risk_override_confirmations | 2 | PASS | Write restricted to `medic`/`pc` + self `actor_id`; read is command-role-or-self. Correctly incident-scoped. |
| incident_memberships | 4 | PASS | Read is self-or-command-role; write is command-role-only. No incident-membership self-check needed here since this table *is* the membership source `can_access_incident` reads from. |
| incidents | 4 | PASS | Read via `can_access_incident(id)`; insert/update correctly special-case a medic's own `draft` incident (`draft_created_by = auth.uid()`) alongside the normal command-role path — matches the documented draft-incident-approval flow. |
| inventory_items / kit_templates / kit_template_items / treatment_catalog / treatment_inventory_items | 4 each | PASS | Catalog/reference tables — `read: true` (any authenticated user), write restricted to admin or logistics-adjacent roles. Correct: these aren't incident-scoped data. |
| inventory_ledger / inventory_ledger_v12 | 2 each | PASS | `incident_id IS NULL OR can_access_incident(incident_id)` read; write additionally requires role in (`medic`,`pc`,`logistics_officer`,`admin`). |
| patient_edit_conflicts | 1 | PASS | Command-role + incident-scoped read only; correct (conflict surfacing, not client-editable). |
| patients | 3 | PASS | Insert restricted to (`medic`,`pc`,`rpc`,`rcc`) + `can_access_incident`; the projection-update policy is intentionally broad on role (`medic`,`pc`,`cc`,`chamal`,`admin`) since it backs the pulled-projection merge described in `docs/ROADMAP.md` Phase 3, but still incident-scoped. |
| profiles | 1 (read only) | PASS | Self-or-command-role read; **no write policy exists at all** — profile creation is `handle_new_user()`-only (trigger, `SECURITY DEFINER`) and profile updates (role changes, `is_active` toggles) have no client-facing path, which is correct: it prevents a client from self-editing its own role/`is_active` (ties directly to T4). |
| sectors | 4 | PASS | Incident-scoped, write role list appropriately wider (includes `rpc`/`rcc`) than delete (excludes them) — matches site-authority roles being able to create/update but not delete sector records. |
| supply_request_items | 4 | PASS | Transitively scoped via `EXISTS (... supply_requests sr WHERE sr.id = ... AND can_access_incident(sr.incident_id))`, same correct pattern as external_patient_links. |
| supply_requests | 4 | PASS | Direct incident scoping, write role list (`medic`,`pc`,`logistics_officer`,`admin`) matches the supply-request domain. |
| sync_event_dependencies | 1 | PASS | Command-role read only — writes are service-role/trigger-only, matching the "poison event quarantine" design in `docs/ARCHITECTURE.md`. |
| sync_ingestion_errors | 1 | PASS | Command-role AND incident-scoped read (`incident_id IS NULL OR can_access_incident(incident_id)`) — this is the exact policy `015` fixed to add incident scoping; confirmed still correct live. |
| tester_feedback_reports | 3 | PASS | Self-or-command read, self-only insert, command-only update. |
| tourniquets | 1 (read only) | PASS | Incident-scoped read; writes are trigger-only (`project_tourniquet_events()`, `SECURITY DEFINER`) — correct, tourniquet state is derived from `TOURNIQUET_*` events, not directly editable. |
| watchdog_alerts | 2 | PASS | Incident-scoped read for everyone with incident access; update (resolve/acknowledge) restricted to command roles. |
| **patient_handover_tokens, realtime_outbox** | 0 each | PASS (by design) | RLS enabled with zero policies **and** confirmed live via `information_schema.role_table_grants` that `anon`/`authenticated` have no grants at all on either table — fail-closed by GRANT absence, RLS is a redundant second layer. Documented intentionally in `database/004_rls_gap_fixes_and_trigger_security_definer.sql`'s comments as "same treatment as `incident_command_state`" (below). Not the same failure mode as `patient_handover_tokens`/`realtime_outbox` appearing in `get_advisors`' `rls_enabled_no_policy` INFO lint — that lint is a correct observation, not evidence of a gap, given the grant check. |

`incident_command_state` (33rd sensitive table): confirmed live via `pg_class.relrowsecurity = false` — RLS is **deliberately disabled**, not merely policy-less. `001_postgresql_schema_v1.2.sql:2425-2426` explicitly does `alter table incident_command_state disable row level security; revoke all on incident_command_state from anon, authenticated;`. Access is exclusively through `get_incident_command_state()` (below). Confirmed no `anon`/`authenticated` grants live. PASS (by design) — noted here rather than in the table above since it doesn't use RLS as its mechanism at all.

## SECURITY DEFINER functions — 17 in `public`, 4 in `app` (all reviewed)

| Function | Type | Verdict | Note |
|---|---|---|---|
| `handle_new_user()` | trigger (`auth.users` insert) | **FAIL → fixed** | See Summary finding 2. Fixed in `database/017_lock_out_inactive_profiles.sql`. Grants already correctly restricted to `postgres`/`service_role` only (`016`), unaffected by this fix. |
| `get_incident_command_state(p_incident_id)` | RPC (`authenticated`-callable) | PASS | Body explicitly calls `app.can_access_incident(p_incident_id)` and raises `42501` if false, before reading `incident_command_state`. `get_advisors` flags this function as a generic WARN ("signed-in users can execute a SECURITY DEFINER function") — that lint doesn't inspect function bodies, so the WARN is a false positive relative to the actual (correct) internal check. Documenting this here so it isn't "fixed" by loosening the grant, which would be the wrong direction. |
| `refresh_incident_command_state(p_incident_id)` | RPC-shaped (returns `void`), not trigger | PASS-NOTE | No internal authorization check — correctness today depends entirely on it **not** being granted to `anon`/`authenticated` (confirmed: grantees are `postgres`, `service_role` only). If a future migration or dashboard change ever grants `EXECUTE` to `authenticated`, any authenticated user could force a recompute of any incident's aggregate command counts by passing an arbitrary `incident_id` — not a confidentiality leak (recomputes only from real underlying data via `vw_kpi_incident_command_summary`), but an unauthenticated-by-incident write. Recommend leaving un-granted; flagging so a future grant change gets scrutiny. |
| `silence_resolved_watchdogs_for_event(p_event_id)` | RPC-shaped (returns `void`) | PASS-NOTE | Same grant-reliance pattern as above; grantees `postgres`/`service_role` only. |
| `generate_dead_man_switch_alerts(threshold)` | RPC-shaped (returns `integer`) | PASS-NOTE | Same grant-reliance pattern; this one writes cross-user watchdog alerts for *every* medic incident-wide if ever called by a client, so the grant boundary matters more here. Grantees confirmed `postgres`/`service_role` only. |
| `generate_tourniquet_reassessment_alerts(p_incident_id)` | RPC-shaped (returns `integer`) | PASS-NOTE | Same pattern; grantees confirmed `postgres`/`service_role` only. |
| `apply_event_projection_and_outbox()` | trigger (`events` insert) | PASS | Writes `conflict_log`/`realtime_outbox` for specific event types. No internal auth check needed — only fires after `events`' own RLS-gated insert already authorized the write; `RETURNS trigger` functions cannot be called directly via RPC regardless of grants (Postgres rejects it — the `trigger` pseudo-type can't be produced by an ordinary call), so this class of function has no direct-RPC-callable attack surface by construction. |
| `clear_patient_pending_on_incident_confirmation()` | trigger (`incidents` update) | PASS | Same reasoning. |
| `draft_incident_approval_outbox()` | trigger (`events` insert) | PASS | Same reasoning. |
| `flag_negative_inventory_after_insert()` | trigger (`inventory_ledger` insert) | PASS | Same reasoning. |
| `flag_pediatric_medication_missing_weight()` | trigger (`events` insert) | PASS | Same reasoning. |
| `mark_patient_pending_when_incident_is_draft()` | trigger (`patients` insert) | PASS | Same reasoning. |
| `project_patient_state()` | trigger (`events` insert) | PASS | This is the `013`-consolidated patient-status projector. Verified live: every branch that writes `current_status` (`PATIENT_STATUS_UPDATED`, `PATIENT_HANDED_OVER`, `PATIENT_TRIAGED_EXPECTANT`) correctly excludes the terminal statuses (`deceased`/`handed_over`/`closed`/`self_evacuated`) in its `WHERE` clause — the racing-trigger class of bug `013` fixed is still fixed, and status writes are consolidated into this one function (no competing unguarded writer found). |
| `project_tourniquet_events()` | trigger (`events` insert) | PASS | Same reasoning as other event triggers. |
| `refresh_command_state_after_event()` | trigger (`events`/similar insert) | PASS | Calls `refresh_incident_command_state()` internally; trigger-only, not directly RPC-reachable. |
| `trg_process_logistics_event_safety_v12()` | trigger (`inventory_ledger_v12` insert) | PASS | Same reasoning. |
| `trg_verify_pediatric_safety()` | trigger (`events` insert) | PASS | Same reasoning. |
| `app.current_user_role()` | helper, `SECURITY DEFINER` | **FAIL → fixed** | See Summary finding 1. Fixed in `database/017_lock_out_inactive_profiles.sql`. |
| `app.can_access_incident(p_incident_id)`, `app.can_write_incident_event(p_incident_id)` | helpers, `SECURITY DEFINER` | **FAIL → fixed** | Initially assessed PASS ("calls `current_user_role()` internally, fix cascades") — **wrong**, caught during live verification of the fix, not during the initial read-through. Both functions' `incident_memberships` `EXISTS` branch checks `im.profile_id = auth.uid()` directly, bypassing `current_user_role()` (and therefore `is_active`) entirely. Redefined to require `current_user_role() is not null` up front; verified live (see "Fix applied" below). |
| `app.is_command_role()` | helper, `SECURITY DEFINER` | PASS | Calls `app.current_user_role()` internally with no independent branch, so fix #1 alone correctly cascades to it. Grantee is `PUBLIC` on all `app.*` functions, but the `app` schema is not part of Supabase's PostgREST-exposed schema set (confirmed live: `set local role authenticated` + a direct call to any `app.*()` function returns `permission denied for schema app`), so these are not directly RPC-callable regardless of grant; even if they were, `app.current_user_role()` returns `null` for an unauthenticated (`anon`) caller, so every dependent boolean check already evaluates to `false` for `anon`. |
| `app.can_write_clinical_event(role_in)` | helper, plain SQL (not `SECURITY DEFINER`) | PASS | Pure `role_in in ('medic','pc')` logic, no table access — correctly does not need elevated privilege. |

## Fix applied

`database/017_lock_out_inactive_profiles.sql`:
1. Redefines `app.current_user_role()` to add `and is_active = true` to its `select ... from profiles where id = auth.uid()`, so every RLS policy and helper built on it fails closed for a deactivated profile. `profiles_read_authenticated`'s `id = auth.uid()` self-read branch is untouched, so a deactivated user can still see their own (now-inactive) profile row — they just can't act as their role anywhere else.
2. Redefines `app.can_access_incident()` and `app.can_write_incident_event()` to additionally require `app.current_user_role() is not null`. **This second part was not in the first version of the fix** — caught only while verifying it live: both functions' `incident_memberships` `EXISTS` branch checks `im.profile_id = auth.uid()` directly and never calls `current_user_role()` at all, so a deactivated `medic`/`pc` who already had a real `incident_memberships` row would still have passed even with fix #1 alone. Since every incident-scoped RLS policy in this schema routes through one of these two functions (see the policy table above — no policy inlines `incident_memberships` directly), this closes the gap everywhere it matters without touching individual policies.
3. Redeploys `handle_new_user()` to match `database/011_handle_new_user_reads_role_from_metadata.sql`'s documented logic: `is_active` is set to whether the invite's `role` metadata was a valid `user_role` value, not silently defaulted to `true`.

Verified live, not just by inspection:
- `get_advisors(security)` re-run after applying — unchanged from the pre-fix baseline (no new WARN/ERROR introduced; the pre-existing WARNs are the already-reviewed `get_incident_command_state` false positive and the out-of-scope T6 leaked-password item).
- A real deactivated synthetic profile (`ce6b292c-7cc3-4330-9040-b24e9a832a55`, seed data, `is_active=false`) was given a real `incident_memberships` row for a real incident inside an explicit `begin; ... rollback;` block, impersonated via `set_config('request.jwt.claims', ...)` + `set local role authenticated` (no data persisted — confirmed via a post-rollback row count): reading `incidents` for that incident returned **0 rows** — correctly denied.
- The same test against a real *active* profile with a real membership row returned **1 row** — confirms the fix didn't regress legitimate access.

## Follow-up: two functions added after this audit, plus the two "RLS enabled, no policy" INFO findings

`docs/PRODUCTION_READINESS.md` flagged two loose ends this audit didn't originally cover — both closed out here, live, per this doc's own recommendation ("re-run after any schema change that adds a new table, policy, or `SECURITY DEFINER` function").

**`finalize_incident_aar(p_incident_id)` and `update_patient_identity(p_patient_id, p_name, p_identifying_description)`** — both postdate this audit (added with the patient-identity-lifecycle work, `database/018`) and both trip the same `get_advisors` WARN class as `get_incident_command_state` above ("signed-in users can execute a `SECURITY DEFINER` function"). Checked their live bodies via `pg_get_functiondef`:

| Function | Verdict | Why |
|---|---|---|
| `finalize_incident_aar(p_incident_id)` | PASS | Checks `app.can_access_incident(p_incident_id)` **and** `app.is_command_role()` before touching anything, raising `42501` on either failure. Only then clears `patients.optional_name`/`identifying_description` for the incident and stamps `incidents.aar_finalized_at/by`. |
| `update_patient_identity(p_patient_id, p_name, p_identifying_description)` | PASS | Resolves the patient's `incident_id` first, checks `app.can_access_incident()`, then gates on an explicit role allowlist (`medic, paramedic, pc, cc, physician, chamal, admin`) — `rpc`/`rcc`/`logistics` correctly excluded, consistent with identity being a rescue-chain *read*, not *write*, capability (`docs/ROLE_COMMAND_MODEL_v2.8.md`'s "Evacuation order visibility" addendum). |

Same false-positive class as `get_incident_command_state` — the lint can't see inside the function body, so it flags any `authenticated`-callable `SECURITY DEFINER` function regardless of what that function actually checks. No fix needed; documenting here so a future pass doesn't "fix" it by loosening the grant.

**`patient_handover_tokens`/`realtime_outbox` — "RLS Enabled No Policy" (INFO)**. `docs/PRODUCTION_READINESS.md` carried this as "believed intentional... hasn't had a dedicated design review." Verified live, not just believed:

- `information_schema.role_table_grants` for both tables: only `postgres` and `service_role` have any grant at all (`SELECT`/`INSERT`/`UPDATE`/`DELETE`/etc.) — `anon` and `authenticated` have **zero** grants on either table. PostgREST/RLS never even gets evaluated for a role with no grant in the first place.
- `pg_roles`: `service_role.rolbypassrls = true` (and `postgres.rolbypassrls = true`) — the `sync-log` Edge Function's service-role client (the only real writer to either table) bypasses RLS entirely by design, which is how it can read/write these tables with zero policies defined.
- For completeness: even if `anon`/`authenticated` were later granted access by mistake, Postgres's own RLS semantics mean "RLS enabled, zero policies" is a **default-deny** for any non-bypass role, not default-allow — so the current state is safe in both the grant dimension and the policy dimension, not just one.

Verdict: **PASS (by design)**, same as `incident_command_state`'s "RLS deliberately disabled + grants revoked" pattern documented above — just the RLS-enabled-instead-of-disabled variant of the same idea. No fix needed; `docs/PRODUCTION_READINESS.md` updated to reflect this is now reviewed, not just assumed.

## Follow-up: incident lifecycle RPCs (`database/038`)

Six new `authenticated`-callable `SECURITY DEFINER` functions (`open_incident`, `list_open_incidents`, `join_incident`, `confirm_draft`, `reject_draft`, `acknowledge_draft`) plus one internal helper (`app.append_incident_lifecycle_event`, `EXECUTE` revoked from `public`/`anon`/`authenticated`). All six trip the same `get_advisors` WARN class as `get_incident_command_state` above; the advisor showed no other new finding after `038` was applied (checked before and after).

**Deliberate access widening, decided with the repo owner (2026-10-03), not an oversight:** before `038`, a field role (medic, paramedic, pc, logistics_officer) could only see or write an incident a command role had added it to. Now any active profile can (a) list the minimal header fields of every open incident and (b) join any open incident on its own, which grants it that incident's normal role-scoped read/write access. This is what lets the first medic on scene, or a second medic arriving later, work without waiting for command. Accepted for a single-unit deployment; a multi-unit deployment would need unit scoping on both functions (the same missing platoon/company model already listed under `docs/AUTH_AND_ROLE_MODEL.md`'s Known Gaps).

Verified live by impersonation (`set local role` + `request.jwt.claims`) inside transactions that were always rolled back, nothing persisted:

| Check | Result |
|---|---|
| medic `open_incident` | `draft`, opener auto-joined; retry with same id returns `created:false` |
| medic reads own draft via plain RLS / writes an event into it via `events_insert_by_role` | allowed (both were impossible before `038`) |
| medic `confirm_draft` / `acknowledge_draft` | denied (`42501`) |
| paramedic before / after `join_incident` | `can_access_incident` false -> true |
| logistics_officer `open_incident` | denied; `join_incident` allowed |
| a different medic reusing an existing incident id | denied (`23505`) |
| non-member medic writing an event into someone else's draft | denied by `events_insert_by_role` |
| pc `acknowledge_draft`, `confirm_draft` (+ idempotent retry) | allowed; pc becomes a member |
| pc `reject_draft` on an active incident | denied |
| patient `pending_incident_approval` after confirm / after reject | cleared / kept |
| `join_incident` on a rejected draft; rejected draft in `list_open_incidents` | denied; not listed |
| cc `open_incident` | `active` |
| inactive profile / `anon` calling `list_open_incidents` | denied (`no active profile` / `permission denied for function`) |
| internal helper called directly by `authenticated` | denied |
| events written | `INCIDENT_DRAFT_CREATED`, `INCIDENT_CONFIRMED`, `INCIDENT_DRAFT_REJECTED`, `INCIDENT_OPENED`, each with the real `actor_role` |

## Follow-up: incident close guard (`database/040`)

Gap found while preparing the first PC+CC experiment (asked by the repo owner, verified live): the only close action in the app changed a local flag and logged `INCIDENT_CLOSE_TOGGLED` with no patient check, nothing on the server reacted to it, and `incidents_update` let pc/cc/chamal/admin/physician/rpc/rcc set `status='closed'` directly, again with no patient check. Design decided with the repo owner (2026-10-15): open patients block the close; medical command (pc/cc/chamal/physician) and admin may override with a mandatory reason; rescue command (rpc/rcc) may close but not override.

New: `close_incident()`, `reopen_incident()` (`authenticated`-callable `SECURITY DEFINER`, own role check plus `app.can_access_incident`), `reject_draft()` redefined to pass the guard, and the trigger function `app.guard_incident_close()` (`SECURITY DEFINER`, `EXECUTE` revoked from `public`/`anon`/`authenticated`) on a `BEFORE UPDATE OF status` trigger. The RPCs set a transaction-local flag (`app.incident_close_via_rpc`) around their own update and clear it right after, which the trigger requires for a signed-in user's transition to `closed`. `get_advisors` after the change: the two new RPCs trip the same WARN class as the other lifecycle RPCs; no other new finding; the `app.` trigger function is not exposed.

Verified live by impersonation inside a transaction that was always rolled back (post-rollback check: `TEST-INC-A` still `closed`, zero `INCIDENT_CLOSED`/`INCIDENT_REOPENED` events persisted). Fixture: `TEST-INC-A` reopened inside the transaction, 3 of its 5 patients open.

| Check | Result |
|---|---|
| service path (no `auth.uid()`) sets status directly | allowed (migrations / service role unaffected) |
| rpc direct `update incidents set status='closed'` | denied by the trigger (`42501`), even though `incidents_update` RLS allows rpc |
| rpc `close_incident` without / with a reason | `closed:false`, `can_override:false`, 3 open patients listed |
| medic `close_incident` | denied (`42501`) |
| cc `close_incident` without a reason / with a blank reason | `closed:false`, `reason_required:true` |
| cc `close_incident` with a reason | closed, `override:true`; `metadata.close_override` has reason, role `cc`, count 3; one `INCIDENT_CLOSED` event with actor_role `cc` |
| cc `close_incident` again | `closed:true, changed:false` |
| cc `reopen_incident`, then cc direct close in the same transaction | reopened + `INCIDENT_REOPENED`; direct close still denied (the flag does not leak past the RPC) |
| every patient handed over, rpc `close_incident` | closed, `override:false` |
| medic opens a draft; cc `close_incident` on it | denied (draft: confirm or reject) |
| cc `reject_draft` on it | allowed (passes the guard) |
| cc `reopen_incident` on the rejected draft | denied |

Every other function that updates `incidents` (`confirm_draft`, `acknowledge_draft`, `finalize_incident_aar`) was checked: none sets `status='closed'`, so none is affected by the trigger.

## Follow-up: admin user management (`database/042`)

Gap (verified live 2026-10-16): `profiles` has only a SELECT policy, so no signed-in user could change a role or `is_active`; the only paths were `scripts/invite_user.js` with the service-role key on a laptop, or hand edits in the dashboard. Those changes left no record. Design decided with the repo owner (2026-10-16): only an active admin invites, picks the role per invitation, changes roles and (de)activates; confirmation for anything that grants admin and for deactivation.

New: table `admin_user_audit` (RLS on, one SELECT policy for `app.current_user_role() = 'admin'`, all privileges revoked from `public`/`anon`/`authenticated` except SELECT for `authenticated`, no INSERT/UPDATE/DELETE policy; append-only trigger `app.reject_admin_user_audit_mutation()`); trigger function `app.log_profile_access_change()` (`SECURITY DEFINER`, `EXECUTE` revoked) on `AFTER UPDATE OF role, is_active ON profiles`; RPCs `admin_list_users()`, `admin_set_user_role()`, `admin_set_user_active()` (`SECURITY DEFINER`, `EXECUTE` for `authenticated` only, own admin check). No existing policy changed; no UPDATE policy was added to `profiles`.

**Not yet applied to the live project** (the repo owner chose to review the PR first). Verified on a local PostgreSQL 16 with stand-ins copied from the live definitions (`user_role`, `auth.users`, `auth.uid()`, `profiles` with its live policy and grants, `app.current_user_role()`), impersonating each role as `authenticated` with a JWT subject:

| Check | Result |
|---|---|
| migration applied twice | second run is a no-op (idempotent) |
| admin `admin_list_users()` | all accounts, including one with no profile and one pending (`has_password=false`) |
| cc / anon `admin_list_users()` | cc: denied by the function's admin check; anon: `permission denied for function` |
| admin changes medic to paramedic | allowed; one `role_changed` audit row with the admin as actor |
| same role again | no-op, no audit row |
| admin changes own role / deactivates self | denied |
| admin deactivates cc | allowed; `deactivated` audit row |
| role change for an account with no profile | denied (`no profile for this user`) |
| deactivated cc, deactivated admin2, medic call the RPCs | all denied (`only an active admin`) |
| signed-in direct `update profiles set role='admin'` | `UPDATE 0` (no UPDATE policy) |
| direct change outside a session (superuser) | audited, actor `NULL` |
| medic reads `admin_user_audit` | 0 rows |
| signed-in insert into `admin_user_audit` | `permission denied` |
| UPDATE / DELETE on `admin_user_audit` as superuser | rejected by the append-only trigger |
| `service_role` insert (the Edge Function path) | allowed |

To do once applied live: the same matrix against the real project inside a rolled-back transaction, `get_advisors`, and one real invite with a synthetic address.

## Follow-up: platoon command scope (`database/045`)

Decided with the repo owner 2026-10-18: מ״פ רפואה (cc, company) sees every site; חוג״ד (pc, platoon) only its own platoon's site, enforced on the server and not only in the UI. A site is an incident, one incident per platoon. A medic's draft goes to the PC of that medic's platoon. Medics and paramedics follow the same no-self-join rule.

The cc side was already true (`app.can_access_incident` gives cc/chamal/admin/physician/rpc/rcc every incident). The pc was not actually confined, because membership was self-service. Gaps found live:

| Gap | Fix |
|---|---|
| `join_incident()` let any role self-join any open incident | pc/medic/paramedic may join only what `app.can_access_incident` already allows. logistics_officer unchanged |
| `list_open_incidents()` listed every open incident (address, patient count) to everyone | pc/medic/paramedic list only incidents they can access |
| `confirm_draft` / `reject_draft` / `acknowledge_draft` checked only `is_command_role()` | also `app.can_access_incident` (a pc acts only on its own platoon's drafts) |
| `incident_memberships` insert/update/delete: any pc, any row, any incident; read: every roster | pc only in incidents it belongs to, only for its own platoon's medics/paramedics, never itself or a command role (`app.pc_may_manage_membership`). Read: own rows, company-level all, pc only its incidents' rosters |
| `profiles` read: a pc read every account | pc reads itself and its own platoon only |
| `incidents` update/delete USING checked the role only | also `app.can_access_incident(id)` (defense in depth; the SELECT policy happened to scope it) |

New: `profiles.platoon_commander_id` (the platoon roster), `set_platoon_commander()` (cc/chamal/admin/physician only), a trigger that refuses any other roster change even with RLS bypassed, `app.is_incident_member()`, `app.pc_may_manage_membership()`. `app.can_access_incident()` additionally lets a pc see a draft drafted by a medic of its platoon.

Verified before applying, on a local PostgreSQL 16 built like Supabase (an `authenticated` role, `auth.uid()` from the JWT claim, RLS enabled, the live pre-045 definitions), 45 checks, each run as the real role in a rolled-back transaction: CC sees every incident and patient; PC1 sees its own incident plus its own platoon's draft only; an unassigned paramedic sees nothing; the picker list is scoped for pc/medic and unchanged for cc and logistics; PC2 and an unassigned medic cannot self-join; a PC may join and confirm its own platoon's draft but cannot join, confirm, reject or acknowledge another platoon's; confirming makes the PC a member; a PC assigns its own platoon's medic into its own incident but not another platoon's medic, an unrostered paramedic, itself into another site, its medic into another site, or a physician; a PC's delete in another site affects nothing; CC assigns a PC anywhere; a PC reads only itself and its platoon; a PC or medic cannot change the roster, CC can; the roster target must be a pc and the member a medic/paramedic; a direct profile update changes nothing; the trigger refuses a pc roster change even with RLS bypassed; a PC cannot update or delete another platoon's incident. Applying 045 twice is a no-op.

**Applied live 2026-10-18, with the `sync-log` Edge Function deployed as v6.** The order was `043` → `044` → `045` → `046`. These were numbered `042`-`045` when applied, and the live migration history still records them under those names. They were renumbered when merging `main`, whose `042_admin_user_management.sql` took `042` and was not yet applied live. The Supabase tool cancelled any batch that contained a `drop ...` statement, so the live apply used equivalent forms with the same end state:
- `044` went in two parts, and its `drop trigger if exists` was a no-op because the trigger did not exist yet.
- `045` used `ALTER POLICY` on the seven existing policies instead of drop-and-create. That variant was re-run against the local harness with the pre-045 policies in place first, and passed all 45 checks.
- `046` was added after the security advisor reported `project_evacuation_tracking()` as executable by anon/authenticated via `/rest/v1/rpc`. 044/045 had revoked EXECUTE only from PUBLIC, the same gap `016` once fixed. After `046`, neither trigger function is executable by anon or authenticated.

Live verification ran as the real cc, pc, medic, paramedic and logistics accounts, in one `DO` block that always ended by raising its report, so everything rolled back. Afterwards: 0 test incidents, events or reports remained, and the platoon roster was unchanged. All 28 checks passed:
- **Roster:** cc sets the roster through `set_platoon_commander()` and the target must be a pc. pc and medic cannot change the roster.
- **CC visibility:** cc sees all 4 test incidents and both patients.
- **PC visibility:** pc sees only its own site plus its own platoon's draft. It cannot read the other site's patient, its picker lists 2 of the 4 incidents, and it cannot read other sites' rosters or any profile outside its platoon.
- **PC drafts and joining:** pc self-join of another site is refused (`42501`). confirm, reject and acknowledge of another platoon's draft are refused. pc confirms its own platoon's draft and becomes a member.
- **PC memberships:** pc assigns its own platoon's medic but not another platoon's medic, and cannot add itself to another site.
- **Projection, through real event inserts:** a pc handover projects destination and MDA classification. A United Hatzalah report is projected to `external_reports`, linked to its patient, and readable by cc. A later cc MDA update projects. An older, late-syncing update is ignored, and the destination is kept.
- **Medics and logistics:** an unassigned medic or paramedic cannot self-join, and an unassigned medic sees neither site. logistics self-join is unchanged.

Checks that need a raw `UPDATE`/`DELETE` (a pc updating or deleting another platoon's incident, and the roster trigger with RLS bypassed) are covered by the local harness only. The tool would not run those statements live, even inside a rolled-back transaction.

Not changed: `logistics_officer` keeps self-join (its supply work spans incidents, not part of the decision); `app.can_write_incident_event` still grants pc blanket, but no live policy uses it (checked).

## Follow-up: admin full access (`database/047`, `048`)

Found from live data on 2026-10-19 (`docs/GAP_CLOSURE_PLAN.md` WP-0): two phones logged in as admin, members of an active incident, had every `QUICK_PATIENT_CREATED` quarantined with `PATIENT_CREATE_FAILED` ("new row violates row-level security policy for table patients"), and every later event for those patients failed `events_patient_id_fkey`. `patients_insert` (last defined in `020`) allowed medic/pc/paramedic/rpc/rcc only, while `sync-log`'s role gate and the client `AUTH_MATRIX` allow admin. A live scan of every INSERT/UPDATE policy whose role list lacks admin found only `patients_insert`, `death_confirmations_insert` (physician-only by design) and `high_risk_override_insert`. The repo owner then decided admin may do everything (D7 in `docs/GAP_CLOSURE_PLAN.md`; revisit before any real-world use). `database/047_admin_full_access.sql` adds admin to `patients_insert`, `high_risk_override_insert`, `death_confirmations_insert` and the physician-death guard in `project_patient_state()`; `database/048_admin_wins_tie_break.sql` ranks admin 6 in `app.role_authority_rank()`, above physician, so admin also wins same-field collisions. Event log and audit tables stay append-only for every role, admin included (no UPDATE/DELETE policy on `events`, `conflict_log`, `retention_actions` and similar, by the same owner decision). The `app.can_access_incident()` check is unchanged, but note that it already grants `cc`/`chamal`/`admin`/`rpc`/`rcc`/`physician` access to every incident without a membership row, so after `047` an admin can create a patient in any incident, joined or not, exactly as `rpc`/`rcc` already could.

The `patients_insert` part was verified live on 2026-10-19 after the owner applied it, by role impersonation inside a single block that was forced to roll back (no data left behind): admin in a joined incident ALLOWED; admin in a non-joined incident ALLOWED (by design, see above); logistics_officer with a membership row DENIED (`new row violates row-level security policy`); medic with a membership row ALLOWED (regression check). `get_advisors` (security) shows nothing new: the remaining WARN/INFO items are the pre-existing client-facing `SECURITY DEFINER` RPCs, the two intentional no-policy tables covered above, and leaked-password protection (`docs/THREAT_MODEL.md` T6).

The rest of `047` (`high_risk_override_insert`, `death_confirmations_insert`, and the physician-death guard in `project_patient_state()`) was applied by the owner later on 2026-10-19 and checked live: all three policies now list admin; the guard reads `coalesce(new.actor_role::text, '') not in ('physician', 'admin')` and the old `is distinct from 'physician'` text is gone; `project_patient_state()` is still `SECURITY DEFINER` with `search_path=public`, its trigger `trg_project_patient_state` is enabled, and `anon`/`authenticated` still cannot execute it. Patient insert by impersonation in a rolled-back block: admin ALLOWED; cc, chamal and logistics_officer DENIED (unchanged). `get_advisors` (security): nothing new. `048` was then applied by the owner the same day and checked live: `app.role_authority_rank()` returns admin 6, physician 5, medic 1, chamal 0, is still `immutable` with `search_path=public`, and `anon`/`authenticated` still cannot execute it. `app.resolve_field_authority()` with a 300-second window: admin editing after a physician wins; a physician editing after admin loses; medic after physician still loses (unchanged); medic after admin outside the window wins (last write wins).

## Explicitly not re-litigated here

- T6 (leaked-password protection) and T5 (service-role key handling) — out of scope, not RLS/authorization, already tracked in `docs/THREAT_MODEL.md`.
- Full line-by-line cross-check of every role's write scope against `docs/API_SURFACE_v1.2.md`/`docs/ROLE_COMMAND_MODEL_v2.7.md` for every table was done at a summary level while reviewing each policy above (role lists per policy were checked against the role's documented capability); no drift was found. A dedicated doc-vs-schema diff was not built as a separate artifact.
