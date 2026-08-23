# Threat Model

This is the first of the `docs/ROADMAP.md` Phase 5 ("Operational Readiness Research") deliverables. It exists to identify what would need review before any real-world pilot discussion — not to declare the system secure. C5 Sentinel-SAR is a development prototype (`docs/OPERATIONS_SAFETY.md`); nothing here should be read as a production security sign-off.

Grounded in what is actually built as of this writing (`docs/ARCHITECTURE.md`'s "Backend Deployment Status", `docs/ROADMAP.md` Phase 3), not aspirational architecture. Where a threat is already mitigated, the mitigation is named and, where this session verified it live, how.

## System and Trust Boundaries

See `docs/ARCHITECTURE.md`'s system-shape diagram for the intended full picture. What actually exists today:

```text
Field device (medic/pc/logistics/cc/chamal/rpc/rcc)
  - index.html (single HTML/JS file, no build step)
  - localStorage: patients[], outbox, pull cursors — plaintext, unencrypted
  - Supabase JS client: Auth (JWT), REST (PostgREST), one deployed Edge Function
       |
       | HTTPS (TLS via Supabase infrastructure)
       v
Supabase project (btvvjmuwdzirjyauyijx)
  - Postgres: RLS on every clinical/operational table, SECURITY DEFINER functions for
    cross-role reads/writes that RLS alone can't express
  - sync-log Edge Function: POST/GET /sync/log, runs as the caller's own JWT for events
    insert/select (RLS is the real gate), service-role client only for
    sync_ingestion_errors writes
  - Auth: email/password, invite-based onboarding, no MFA
       |
       v
Operator tooling (not field-facing)
  - analytics/export_live_incident.py: service-role key, offline reporting only
  - Supabase dashboard / MCP tooling used during development
```

Trust boundaries that matter:

1. **Field device ↔ Supabase.** The device holds a real user's JWT after login; RLS is the only thing standing between "authenticated" and "sees every incident's data."
2. **Within Supabase, role ↔ role.** A `medic` and a `cc` are both `authenticated` at the Postgres level — every distinction between what they can see/do is enforced by RLS policies and `app.*()` helper functions, not by anything at the network layer.
3. **Trigger/function definer ↔ caller.** Several functions run `SECURITY DEFINER` (elevated privilege) specifically to do things RLS can't (e.g. a medic's pediatric-medication event needs to write a cross-role-visible `watchdog_alerts` row). Each one is a deliberate, narrow privilege boundary — and, as this session found twice, an easy place to leave a gap if the function's *own* authorization check doesn't match its grant.
4. **Operator tooling ↔ everything.** `export_live_incident.py`'s service-role key bypasses RLS entirely. It is explicitly an offline, trusted-operator tool, not a field-facing code path.

## Assets

Ranked by sensitivity, assuming a real (non-synthetic) deployment:

1. **Clinical/patient data** — `patients`, `events` (vitals, triage, injuries, medications), `tourniquets`, `inventory_ledger_v12`. Currently always synthetic per repo policy, but the schema is shaped for real PII and real clinical data.
2. **Identity data** — `profiles` (role, display name, phone, unit), Supabase Auth credentials.
3. **Operational/command data** — incident location, sector/building status, device presence (who is where), reinforcement requests.
4. **Audit/integrity data** — `conflict_log`, `sync_ingestion_errors`, `watchdog_alerts`, event history. Tampering with or losing this undermines after-action review and clinical accountability, not just confidentiality.
5. **Credentials/secrets** — Supabase service-role key (operator tooling only), user JWTs/passwords, handover tokens (`patients.handover_token`).

## Actors

- **Legitimate role holders** (`medic`, `pc`, `cc`, `chamal`, `logistics_officer`, `rpc`, `rcc`, `admin`) — the intended users. The main risk from this group is a role seeing/doing more than their role should (an RLS/authorization gap), not malice.
- **A device that is lost, stolen, or left unlocked in the field.** SAR/MCI field conditions make this a realistic, not theoretical, scenario.
- **Network attacker** — someone positioned to intercept or tamper with traffic between a field device and Supabase.
- **Malicious or buggy client** — a compromised or misbehaving device sending malformed/adversarial event payloads (this one is already partially in scope by design — see "poison event quarantine" below).
- **An operator running `export_live_incident.py`** — trusted, but a mishandled service-role key here has the largest blast radius of any actor in this list, since it bypasses RLS entirely.
- **A person the app's own inviter mis-scoped** — e.g. `kelnerraanan@gmail.com` from earlier this session: an invited account that authenticated but was deliberately left without an active profile. Onboarding mistakes are a realistic threat-adjacent failure mode, not just an inconvenience.

## Threats and Current Mitigation Status

### T1: RLS/authorization gap grants access across roles or incidents

**This is the single most concrete, evidenced risk in this codebase** — not a hypothetical. Real instances found and fixed in this session alone:

- A racing-trigger bug (`database/013`) where an unguarded projection trigger could silently overwrite a terminal patient status (`handed_over`) set moments earlier by a guarded one.
- `get_incident_command_state()` initially executable by the `anon` role (fixed in `database/014`'s follow-up).
- `sync_ingestion_errors_read_command` checked role membership but not incident membership at all — a `pc`/`cc`/`chamal`/`admin` in one incident could read another incident's quarantined events (fixed in `database/015`).
- `handle_new_user()` directly callable via RPC by `anon`/`authenticated` (not exploitable in practice — Postgres rejects direct calls to trigger functions — but tightened anyway, `database/016`).

**Pattern**: every one of these was found by deliberately checking a specific policy/grant against the established convention used elsewhere in the same schema, or by re-running the Supabase security advisor after a change — not by a systematic audit. **This strongly suggests more exist that haven't been found yet.** A real pre-pilot review needs a full, deliberate pass over every RLS policy and every `SECURITY DEFINER` function's internal authorization logic, not incremental discovery.

*Mitigation status*: the systematic pass this called for has now been done — see `docs/RLS_AUDIT_v1.md`. Every live RLS policy (86, across 32 tables) and every live `SECURITY DEFINER` function (17 in `public`, 4 in `app`) was checked against the schema's `app.*()` authorization-helper convention, not just the migration files (later files overwrite earlier ones; only live state was trusted). Two more real gaps were found this way — both in the account-deactivation path (`profiles.is_active`), not the cross-incident-read class `013`-`016` already covered — and fixed live in `database/017_lock_out_inactive_profiles.sql`, verified with a real deactivated-profile impersonation test, not just inspection. See T4/T8 below for what changed. No further systematic pass is scheduled; a repeat is recommended after any schema change that adds a new table, policy, or `SECURITY DEFINER` function, using `docs/RLS_AUDIT_v1.md`'s table/function checklist as the starting point.

### T2: Lost or stolen field device exposes local data

`localStorage` (`patients[]`, `state.localEvents`, the sync outbox) is plaintext. A lost or stolen device in an MCI/SAR context — a realistic scenario, not an edge case — exposes every patient this device has touched, unencrypted, to anyone with filesystem/browser-storage access.

*Mitigation status*: mitigated, including the Supabase session token. A device PIN — never persisted anywhere, in any form, held only in memory for the session — is used purely as PBKDF2 key-derivation material for an AES-256-GCM key encrypting `patients[]`/site state, the sync outbox, the in-progress patient-intake draft, the conflict log, observer notes, and (as of this follow-up) the Supabase session token itself at rest. This works identically whether the medic is logged in via Supabase Auth or in local-demo (no-login) mode, since it depends on nothing but the PIN itself — no OS/browser feature. `screen-pin-gate` is now the true first screen on every fresh load, ahead of `screen-login`, gating both modes identically. Verified live via Playwright (`npm run test:browser-smoke`): a fresh device is prompted to set up a PIN; a returning device is prompted to unlock and a wrong PIN is rejected while the correct one succeeds; the raw `localStorage` record is confirmed to be an opaque `{salt,iv,ct}` blob, not readable JSON.

The session-token follow-up (previously deferred over a suspected "brand-new device's first action is an invite link, before any PIN exists" bootstrapping conflict) turned out not to need new design: confirmed by direct trace that every code path touching the Supabase client (`getSupabaseClient()`'s 16 call sites, and `restoreSession()`'s single call site) already runs strictly after `bootAfterUnlock()`, i.e. after a PIN has been set up or unlocked — the invite-link signal itself is captured URL-only, before any storage is touched. Supabase's `auth.storage` option officially supports async `getItem`/`setItem`/`removeItem`, so the same `secureGetItem`/`queuedSecureSetItem` primitives plug in directly as a custom storage adapter — no new crypto, no new UI. One disclosed, accepted tradeoff: a device with a pre-existing plaintext session from before this change is signed out once, silently, on its next load (not a data-loss or security issue) — acceptable for a prototype with only synthetic test accounts.

Two residual points, stated explicitly rather than left implicit:
- **A short PIN's real strength.** No PBKDF2 iteration count (300,000 by default, `PIN_KDF_ITERATIONS`) makes a 6-digit PIN (~20 bits of entropy) resistant to a determined offline attacker with the ciphertext, salt, and verifier — this targets opportunistic access to a lost/found device, not a forensic lab. PIN loss is unrecoverable by design (destructive reset only, `resetLocalPinAndWipe()`) — no key-escrow, since that would reintroduce a second durable on-device secret. Only truly-unsynced outbox events are lost forever this way; everything else re-hydrates from the server on next login/sync.
- **Durability window narrowed slightly.** `crypto.subtle` is Promise-only, so the `beforeunload` flush that used to be a synchronous best-effort write is now async and not guaranteed to finish before an instant tab close — mitigated with an additional `visibilitychange` listener (fires reliably when a mobile browser is backgrounded, before the process might be killed) but not eliminated. Confidentiality improved; a small durability tradeoff was accepted to get there, not discovered later.

Not yet in scope: the Supabase session token itself (see T1's system diagram — it's `persistSession`-managed by supabase-js under its own plaintext `localStorage` key, separate from the app's own keys). A stolen live session has arguably a *larger* blast radius than cached patient data (it lets an attacker act as that medic against the live server), but bundling it into this same change would force the PIN gate in front of a brand-new device's very first action (an email invite link), before any PIN exists or there's local clinical data to protect yet — a separate bootstrapping problem, deliberately deferred as a fast follow-up now that the PIN mechanism it would reuse is proven.

### T3: Malformed or adversarial event payloads

A compromised, buggy, or malicious client could push malformed events, events for patients it shouldn't touch, or events attempting to claim a role/event-type combination it isn't authorized for.

*Mitigation status*: real and layered. `sync-log`'s "Atomic Individual Event Processing" quarantines malformed/unparseable events into `sync_ingestion_errors` rather than failing a whole batch or silently accepting bad data; `ROLE_ALLOWED_EVENT_TYPES` and RLS both gate event-type-vs-role; a dependency-blocked child event is quarantined, not inserted as an orphan. Verified live this session (real `FORBIDDEN_ACTOR_ROLE`/`MALFORMED_EVENT_ENVELOPE`/`BLOCKED_DEPENDENCY` rows already exist in `sync_ingestion_errors` from earlier testing, and are now visible in a dedicated command review panel rather than only a numeric count).

### T4: Privilege escalation at signup

Could a new signup grant itself an elevated role (e.g. `admin`, `cc`) via the invite metadata path?

*Mitigation status*: mitigated, but wasn't actually live until this session's RLS audit (`docs/RLS_AUDIT_v1.md`). `handle_new_user()` validates the requested role against the real `user_role` enum and is documented (`database/011_handle_new_user_reads_role_from_metadata.sql`) to set `is_active=false` for a missing/invalid role so the account fails closed rather than landing as a fully active, plausible-looking `medic`. The audit found the *live* function body omitted `is_active` from its insert entirely (silently taking the column default of `true`) — root cause unclear, but the documented behavior and the live behavior had diverged. Fixed by redeploying the function in `database/017_lock_out_inactive_profiles.sql`. (Role elevation for a *legitimate* account, e.g. promoting a medic to `pc`, is a separate, deliberate admin action outside signup, by design.)

### T5: Service-role key leakage

`export_live_incident.py` requires a Supabase service-role key (bypasses RLS entirely) via `SUPABASE_SERVICE_ROLE_KEY`. If mishandled — committed, logged, or shared insecurely — this is the single highest-blast-radius credential in the system, since it isn't scoped by role or incident like every other access path is.

*Mitigation status*: partial. The key is never hardcoded, is documented as env-var-only, and the script's default output (`live_incident.db`) is gitignored so an export itself can't be accidentally committed either. No secret-rotation policy, no scoped/short-lived key option, and no review of how an operator is expected to actually store the key locally.

### T6: Weak or previously-leaked user passwords

Supabase Auth's leaked-password protection (checks against HaveIBeenPwned) is currently **disabled** on the live project. A user could set a password already known to be compromised in an unrelated breach.

*Mitigation status*: none yet, and not currently actionable without a plan change. This is a dashboard-only toggle (Authentication → Policies → Password Security), not something applied via SQL migration — but it's also a Supabase **Pro-tier feature**, unavailable on the Free plan this project currently runs on. Enabling it requires upgrading the Supabase project first, which is a cost/plan decision for whoever administers it, not something to do casually before that decision is made.

### T7: Anon key exposure

The Supabase anon key is embedded directly in `index.html` (`SUPABASE_ANON_KEY`), visible to anyone who views the page source.

*Mitigation status*: not a gap — this is the intended Supabase architecture. The anon key identifies the *application*, not a user or a privilege level; RLS is the actual authorization boundary, and every RLS policy in this schema requires `authenticated` (a real logged-in JWT), not just `anon`. The risk this item actually represents is T1 (an RLS gap), not the key's visibility.

### T8: Onboarding scoping mistakes

An invited user can authenticate successfully but be deliberately left without an active profile (`is_active=false`) — either intentionally (as with a specific test account handled earlier this session) or by a real onboarding mistake (wrong role in the invite metadata, forgotten activation step).

*Mitigation status*: fails safe, not silently — but only as of `docs/RLS_AUDIT_v1.md`'s fixes. This claimed "`is_active=false` is checked everywhere (RLS, sync-log)" before this session; the audit found that was only true of the sync-log Edge Function's own explicit check (`supabase/functions/sync-log/index.ts:145`) — RLS itself did not check `is_active` anywhere, because `app.current_user_role()` and the `incident_memberships`-membership branch of `app.can_access_incident()`/`app.can_write_incident_event()` didn't filter on it. A deactivated profile was fully able to read/write everything RLS gates, not just bypass the one sync-log path. Fixed and verified live in `database/017_lock_out_inactive_profiles.sql` (see `docs/RLS_AUDIT_v1.md`'s "Fix applied" for the live impersonation test). The remaining gap is operational, not technical: there's no current admin UI or documented process for *noticing* a stuck/mis-scoped account other than someone checking manually.

## Residual Risks and Recommended Priority

Ranked by (severity × how concrete the evidence is), not just severity alone:

1. **Enable leaked-password protection (T6).** Now the top open item. Dashboard-only, but requires the Supabase project to be on a paid plan first (Free tier doesn't offer it) — a cost decision to make explicitly before onboarding real users, not something to defer indefinitely either.
2. **Service-role key handling review (T5).** Define where/how an operator is expected to store `SUPABASE_SERVICE_ROLE_KEY`, and whether a scoped/short-lived alternative is worth building before this tool sees real use.
3. **Everything in `docs/PRODUCTION_READINESS.md`'s Security and Privacy section not yet checked off** — secret management review and an incident response plan; audit retention policy and data minimization review are now real documents (`docs/AUDIT_AND_RETENTION_POLICY.md`, `docs/PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md`), incident response plan is not.

~~A systematic RLS/authorization audit (T1)~~ — **done**, see `docs/RLS_AUDIT_v1.md`. Two more real gaps were found (both in the `is_active`/account-deactivation path, fixed in `database/017_lock_out_inactive_profiles.sql`) and no cross-incident/cross-role escalation gaps remain outstanding as of this pass. Not a closed book forever — re-run the same checklist after any schema change that adds a table, policy, or `SECURITY DEFINER` function — but no longer the top-ranked open item.

~~Encrypted local storage (T2)~~ — **fully mitigated**, including the Supabase session token (the earlier "fast follow-up" — turned out not to need new bootstrapping design; every code path touching the Supabase client already runs after PIN unlock, confirmed by direct trace, not assumed). PIN-derived AES-256-GCM, `screen-pin-gate` on every fresh load, no remaining plaintext credential in `localStorage`.

## Explicitly Out of Scope Here

- Clinical/doctrine governance (triage rule correctness, tourniquet timing appropriateness) — that's `docs/PRODUCTION_READINESS.md`'s "Clinical and Operational Governance" section, a domain-expert review, not a security threat model.
- Physical/organizational security of devices, radios, or the incident command post itself.
- Denial-of-service / availability threats against Supabase's own infrastructure — out of this project's control surface.
