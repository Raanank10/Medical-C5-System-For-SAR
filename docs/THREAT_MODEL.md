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

*Mitigation status*: partial. RLS exists everywhere it should (verified via `mcp__Supabase__get_advisors`), and the four known instances above are fixed and verified live. No systematic full-coverage audit has been done.

### T2: Lost or stolen field device exposes local data

`localStorage` (`patients[]`, `state.localEvents`, the sync outbox) is plaintext. A lost or stolen device in an MCI/SAR context — a realistic scenario, not an edge case — exposes every patient this device has touched, unencrypted, to anyone with filesystem/browser-storage access.

*Mitigation status*: none. This is `docs/PRODUCTION_READINESS.md`'s "Encrypted local storage" item, currently unstarted. A device-lock/passcode requirement is also not enforced by the app itself (it inherits whatever the OS/browser provides, if anything).

### T3: Malformed or adversarial event payloads

A compromised, buggy, or malicious client could push malformed events, events for patients it shouldn't touch, or events attempting to claim a role/event-type combination it isn't authorized for.

*Mitigation status*: real and layered. `sync-log`'s "Atomic Individual Event Processing" quarantines malformed/unparseable events into `sync_ingestion_errors` rather than failing a whole batch or silently accepting bad data; `ROLE_ALLOWED_EVENT_TYPES` and RLS both gate event-type-vs-role; a dependency-blocked child event is quarantined, not inserted as an orphan. Verified live this session (real `FORBIDDEN_ACTOR_ROLE`/`MALFORMED_EVENT_ENVELOPE`/`BLOCKED_DEPENDENCY` rows already exist in `sync_ingestion_errors` from earlier testing, and are now visible in a dedicated command review panel rather than only a numeric count).

### T4: Privilege escalation at signup

Could a new signup grant itself an elevated role (e.g. `admin`, `cc`) via the invite metadata path?

*Mitigation status*: mitigated. `handle_new_user()` validates the requested role against the real `user_role` enum; an invalid/missing role does not silently default to a plausible-looking role — it creates the profile with `is_active=false`, which every RLS policy and the sync-log function already check, so the account is locked out and obviously wrong rather than silently over-privileged. (Role elevation for a *legitimate* account, e.g. promoting a medic to `pc`, is a separate, deliberate admin action outside signup, by design.)

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

*Mitigation status*: fails safe, not silently. `is_active=false` is checked everywhere (RLS, sync-log), so a mis-scoped account is locked out rather than granted default/wrong access. The gap is operational, not technical: there's no current admin UI or documented process for *noticing* a stuck/mis-scoped account other than someone checking manually.

## Residual Risks and Recommended Priority

Ranked by (severity × how concrete the evidence is), not just severity alone:

1. **A systematic RLS/authorization audit (T1).** Four real instances found incidentally in one session is a strong signal, not noise. This should be a deliberate, complete pass — every policy, every `SECURITY DEFINER` function — before any pilot discussion, not something left to keep surfacing one bug at a time.
2. **Encrypted local storage (T2).** No mitigation exists today, and the threat scenario (lost/stolen field device) is realistic for the exact operational context this system targets.
3. **Enable leaked-password protection (T6).** Dashboard-only, but requires the Supabase project to be on a paid plan first (Free tier doesn't offer it) — a cost decision to make explicitly before onboarding real users, not something to defer indefinitely either.
4. **Service-role key handling review (T5).** Define where/how an operator is expected to store `SUPABASE_SERVICE_ROLE_KEY`, and whether a scoped/short-lived alternative is worth building before this tool sees real use.
5. **Everything in `docs/PRODUCTION_READINESS.md`'s Security and Privacy section not yet checked off** — secret management review, audit retention policy, data minimization review, and an incident response plan, none of which currently exist as real documents.

## Explicitly Out of Scope Here

- Clinical/doctrine governance (triage rule correctness, tourniquet timing appropriateness) — that's `docs/PRODUCTION_READINESS.md`'s "Clinical and Operational Governance" section, a domain-expert review, not a security threat model.
- Physical/organizational security of devices, radios, or the incident command post itself.
- Denial-of-service / availability threats against Supabase's own infrastructure — out of this project's control surface.
