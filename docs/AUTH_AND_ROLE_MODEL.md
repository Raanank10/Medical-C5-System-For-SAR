# Authentication and Role Model

`docs/ROADMAP.md` Phase 5 deliverable: the real auth/authorization architecture as a standalone technical document, separate from `docs/THREAT_MODEL.md` (which covers what could go wrong) and `docs/ROLE_COMMAND_MODEL_v2.8.md` (which covers what each role does operationally, not how the system enforces it). This document is the connective layer between those two: how identity, roles, and access control actually work end to end, grounded in what's live today.

## Identity and Session Layer

Authentication is real Supabase Auth (email/password), not custom-built. Onboarding is invite-only: an admin invites a person via `scripts/invite_user.js` (which sets the intended role in the invite's `user_metadata` — the Supabase dashboard's own "Send invitation" button has no field for this, so inviting through the dashboard directly produces an account with no usable role, see Account Lifecycle below), the invitee sets their own password on first login (`docs/AUTH_INVITE_AND_PASSWORD_RESET.md` covers this flow's own history — it originally silently dropped a person into their dashboard with no password ever set, a real bug, now fixed).

A successful login produces a Supabase session (JWT). The client (`index.html`) holds `currentUser = {id, email, role}` in memory and persists the session via a custom `storage` adapter passed into the Supabase JS client's `createClient()` call, routed through the same PIN-derived encryption as every other clinically-relevant `localStorage` key (`patients[]`, the outbox, drafts, conflict log — `docs/THREAT_MODEL.md` T2). The session token is fully covered by that encryption, not an exception to it.

## Role Model

`user_role` (Postgres enum, live): `medic`, `pc`, `logistics_officer`, `cc`, `chamal`, `admin`, `rpc`, `rcc`, `physician`, `paramedic` — 10 roles. `rpc`/`rcc` were added after the initial schema (`database/006_add_rpc_rcc_enum_values.sql`) for the platoon/company-commander site-authority actions in `docs/ROLE_COMMAND_MODEL_v2.8.md`. `physician`/`paramedic` were added later still (`database/019_add_physician_paramedic_enum_values.sql`) to give F3's cross-device conflict-resolution role-authority tie-break (`docs/CONFLICT_RESOLUTION_DECISION.md`) real roles to rank, resolving what had been a client-only "doctor/paramedic" demo dashboard with no server backing. The client maps two server role names onto different client-side role keys via `SERVER_ROLE_TO_CLIENT_ROLE` in `index.html`: `logistics_officer` → `logistics`, and `physician` → `doctor` (reusing the existing senior-clinical-review dashboard). `paramedic` needs no remap — it flows through unchanged and reuses medic's own dashboard. Its clinical event-write scope matches medic's/physician's (same drugs and procedures, including `high_risk_override_insert` — `database/023_high_risk_override_add_physician_paramedic.sql`); it does not get physician's command-adjacent scope or official death-certification authority.

What each role means operationally (who they are, what they do in the field/command structure) is `docs/ROLE_COMMAND_MODEL_v2.8.md`'s job, not repeated here. This document only covers how the *system* enforces the boundaries between them.

## Authorization Enforcement

**RLS is the only real authorization boundary — not the Supabase anon key, and not client-side role checks.** The anon key embedded in `index.html` identifies the application, not a privilege level (`docs/THREAT_MODEL.md` T7); every RLS policy requires `authenticated` (a real logged-in JWT). Client-side role-based UI (showing/hiding screens per role) is a UX convenience, not a security control — the real gate is always the database.

Five `app.*()` SQL helper functions (all `SECURITY DEFINER`, `stable`, live in the `app` schema) are the shared vocabulary every RLS policy is built from:

- `app.current_user_role()` — `select role from profiles where id = auth.uid()`. The foundation everything else is built on.
- `app.is_command_role()` — `current_user_role() in ('pc','cc','chamal','admin','physician')`. Used by policies scoped to command-tier reads (e.g. `sync_ingestion_errors`, `aar_context_notes`, `conflict_log`); `physician` was added here (`database/020_physician_paramedic_rls.sql`) as part of mirroring `cc`'s command-adjacent scope.
- `app.can_access_incident(p_incident_id)` — command roles get blanket access; everyone else needs a real `incident_memberships` row. The single most-used check in the schema; `docs/RLS_AUDIT_v1.md` exists specifically because a table skipping this call was the recurring bug pattern found this session.
- `app.can_write_clinical_event(role_in)` — `role_in in ('medic','pc','paramedic')`. A narrower helper for clinical-event-type write gating specifically; `paramedic` was added here since it shares medic's/physician's clinical event-write scope. `physician` isn't in this specific helper's list (it reaches the same clinical events through its own OR'd branch in `events_insert_by_role`, `database/022_events_insert_add_physician.sql`), but is included directly in `high_risk_override_insert` (`database/023`) alongside `paramedic`.
- `app.can_write_incident_event(p_incident_id)` — command roles again get blanket write access; `medic`/`pc` need a real `incident_memberships` row with `role_at_incident in ('medic','pc')` for that specific incident. Distinct from `can_access_incident` (read) — this is the write-side equivalent with its own membership-role check. Not referenced by any live policy today (confirmed before `database/020`), so it wasn't touched for `physician`/`paramedic`.

Three more `app.*()` helpers exist specifically for F3's role-authority tie-break (`database/021_field_level_conflict_resolution.sql`), not general-purpose RLS predicates like the five above — `execute` is revoked from `public`/`anon`/`authenticated` on all three, since they're meant to be called only from inside `project_patient_state()`'s trigger body, never as a direct RPC:

- `app.role_authority_rank(r user_role)` — maps a role to its numeric rank for the tie-break: `physician`=5, `paramedic`=4, `cc`=3, `pc`=2, `medic`=1, everything else (`chamal`/`admin`/`logistics_officer`/`rpc`/`rcc`)=0.
- `app.resolve_field_authority(...)` — given an incumbent field value/role/timestamp and a new one, decides whether the new value wins, and whether this was a genuine authority-decided collision (see `docs/CONFLICT_RESOLUTION_DECISION.md` for the full decision logic).
- `app.log_field_authority_conflict(...)` — writes the resulting override to `conflict_log` when a genuine collision occurred, so it's surfaced to command review rather than silently lost.

Why `SECURITY DEFINER`: these functions need to read `profiles`/`incident_memberships` regardless of what RLS the *calling* policy's own table has — without the elevated privilege, a helper function meant to be usable from any RLS policy would itself be blocked by RLS on the tables it reads, a circular problem. This is also exactly the pattern that produced real bugs this session when a function's *own* internal check didn't match its grant (`get_incident_command_state` initially `anon`-executable, `handle_new_user` directly RPC-callable) — see `docs/RLS_AUDIT_v1.md` for the full audit and `docs/THREAT_MODEL.md` T1 for why this class of bug is the top-ranked risk in the codebase.

## Account Lifecycle

1. **Invite** — `scripts/invite_user.js` calls Supabase Auth's admin invite endpoint with the intended role in `user_metadata`.
2. **Signup trigger** — `handle_new_user()` (a Postgres trigger on `auth.users`, `database/008`/`011`) reads the role from that metadata. If missing or not a real `user_role` enum value (e.g. someone was invited through the dashboard button instead of the script), the profile is still created — onboarding must not silently fail closed on that alone — but `is_active=false`.
3. **Gate** — `is_active` is checked everywhere (every RLS policy, the `sync-log` Edge Function). A `false` value locks the account out completely: authenticated, but with no usable access, rather than silently granted a wrong/default role. `database/017_lock_out_inactive_profiles.sql` (found during `docs/RLS_AUDIT_v1.md`'s systematic pass) closed two remaining gaps in this specific path — an inactive account could still be read/write in ways the `is_active` gate was supposed to prevent.
4. **Deactivation** — setting `is_active=false` on an existing account (an admin action) has the same locked-out effect. There is currently no dedicated admin UI for this — it's a direct database operation, not a feature in `index.html`.

## Known Gaps (cross-referenced, not re-litigated here)

- **No MFA.** Password-only authentication.
- **No leaked-password protection** — a Supabase Pro-tier feature, currently unavailable on the Free plan this project runs on (`docs/THREAT_MODEL.md` T6).
- **No `rpc`/`rcc` platoon/company scoping** — `docs/ARCHITECTURE.md`'s "Backend Deployment Status" already documents this: the "tactical view scoped to my own platoon/company, no vitals/identity" requirement needs a real platoon/company data model (a `platoons` table, `patients.assigned_platoon_id` or equivalent) that doesn't exist yet. `rpc`/`rcc` currently get the same incident-wide access shape as other roles, just with different write-action permissions (`database/007`).
- **No role-change audit trail.** `profiles.role`/`is_active` changes aren't themselves logged as auditable events — an admin's own promote/demote/deactivate actions leave no record beyond the row's own `updated_at`. Real gap, not previously documented elsewhere; candidate for `docs/AUDIT_AND_RETENTION_POLICY.md`'s Class A (clinical/operational record) if adopted, since who has access to what is exactly the kind of thing an after-action review might need to reconstruct.

## Explicitly Out of Scope Here

- Whether the 8-role model itself is operationally correct (that's `docs/ROLE_COMMAND_MODEL_v2.8.md`'s domain, a product/command-structure question, not an access-control one).
- Legal/regulatory identity-verification requirements for a real deployment (who is allowed to be a "medic" in this system, credential verification) — outside a technical auth document's scope.
