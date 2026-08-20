# Phase 4 Plan: Split Into Implementation Packages

This is a working plan for `docs/ROADMAP.md` Phase 4, written for a fresh session to pick up with no memory of how it was produced. Phases 1-3 are done (see `docs/ROADMAP.md` and `docs/ARCHITECTURE.md`'s "Backend Deployment Status" for exactly what's real). Phase 4 is a different order of magnitude from anything done so far: it means actually splitting a 10,400-line single-file prototype into real, separately buildable/deployable packages. Read this whole document, and the docs it points to, before writing any code.

## How to Use This Document

- This is a **plan**, not a locked spec. Several decisions below are explicitly left open (marked **DECISION NEEDED**) because they're the user's call, not something to assume. Raise them with the user before starting the sub-phase they block — this repo's established working pattern (see recent PR history) is: research, present findings, ask before ambiguous/architecturally significant choices, implement, verify live, ship in small focused PRs, wait for explicit merge approval each time. Continue that pattern here; Phase 4 is exactly the kind of work where skipping the "ask" step is expensive to undo.
- Do the sub-phases roughly in order (4A → 4F). Each one is scoped to be its own PR (or several). Don't start 4E/4F before 4A-4D land — the later sub-phases depend on the earlier ones existing.
- **`index.html` (and `demo/rescue-app.html`) must keep working, unmodified in behavior, throughout all of Phase 4** until the explicit retirement decision in 4G. This is not optional scaffolding — it's the only thing anyone can currently demo, and `docs/ROADMAP.md`'s own "Guiding Constraint" says not to let new architecture slow down what already works. Build the new structure *alongside* it, prove it out, and only then talk about retiring the old one.
- Re-run `python scripts/check_repo.py`, `node tests/domain-rules.test.js`, and `npm run test:browser-smoke` before every PR in this phase, same as always — none of this work should be exempt from the existing validation suite, and check_repo.py will need updates as new directories appear (see 4A).

## Current State: What Phase 4 Actually Inherits

Concrete inventory, not the aspirational picture:

| Target (per `docs/ROADMAP.md`) | What exists today | Gap |
|---|---|---|
| `packages/domain` | `src/domain/rules.js` (318 lines) — real, tested (`tests/domain-rules.test.js`), but not a real npm package (no `package.json`, not importable by anything other than Node `require()` and a manually-synced inline copy in `index.html`/`demo/rescue-app.html`) | Needs real package structure. The manual-sync-plus-`check_repo.py`-drift-check pattern is a deliberate, working design for the no-build-step prototype — don't break it. |
| `packages/fixtures` | Two independent, unreconciled implementations: `index.html`'s inline demo-scenario generator (`loadDemoScenario()` and friends) and `analytics/c5_sentinel_sar_analytics_v1_1/seed_demo_db.py`. Different languages, different schemas, no shared source of truth. | Real design work, not a mechanical move — see 4B. |
| `services/sync-api` | `supabase/functions/sync-log/index.ts` (425 lines), deployed and real. Lives where the Supabase CLI's `functions deploy` command requires it to live (`supabase/functions/<name>/`). | Directory-move risk — see 4D, this one has a real tooling constraint. |
| `services/projectors` | `project_patient_state()`, a Postgres trigger function (`database/013_consolidate_patient_status_projection.sql`), not a separately deployable service at all. | **DECISION NEEDED** — see 4D. The ROADMAP.md phrasing may not map onto what actually exists. |
| `database/migrations` | 16 numbered draft SQL files (`database/001_...sql` through `016_...sql`), applied by hand via Supabase MCP tooling during development, no `up`/`down` framework. | Real gap — see 4C. |
| `analytics/` | Already a real, self-contained Python package (`db.py`/`kpis.py`/`charts.py`/`report.py`, pytest suite, `export_live_incident.py` for live data). | Mostly just needs recognizing as a monorepo workspace member — smallest gap of the eight. |
| `apps/field-mobile` | Doesn't exist. All field/medic UI is inside `index.html`. | Full build — see 4F, do this last. |
| `apps/command-web` | Doesn't exist. All command/pc/cc/chamal/logistics UI is inside `index.html`, already reading some real server-authoritative data (`get_incident_command_state`, `device_presence`, projected `patients` rows). | Full build — see 4E, do this before 4F. |

Root `package.json` currently exists solely for the Playwright browser-smoke-test dev dependency (`CLAUDE.md`) — it is not a monorepo root yet.

## Decisions Needed Before Starting (raise with the user, don't assume)

1. **Mobile app framework** — Expo (React Native) vs. staying a web-based PWA. `docs/ROADMAP.md` says "Expo or native," meaning this was never actually decided. Expo gets real offline/background capability and app-store distribution; a PWA keeps the existing HTML/CSS/JS skill investment and avoids app-store friction/review. This decision blocks 4F entirely — don't start it without an answer.
2. **Command-web framework** — the whole prototype has been deliberately framework-free vanilla JS (`CLAUDE.md`: "no new production dependencies until there's a clear module boundary"). Building `apps/command-web` is exactly that clear module boundary arriving — but React/Vue/Svelte/plain-JS-with-a-bundler are all still open. Command-web is lower-risk than field-mobile (no offline-first requirement, the backend reads it needs are already real and Supabase-JS-client-shaped), making it a reasonable place to try a framework for the first time in this codebase.
3. **Monorepo tooling** — npm workspaces (lowest friction, no new tool) vs. pnpm/Turborepo/Nx (more powerful, more surface area). Given this repo's consistent minimal-dependency bias, npm workspaces is the lower-risk default, but it's still a real decision with real tradeoffs (build caching, task orchestration) once there are 5+ packages.
4. **Database migration tooling** — the Supabase CLI has its own built-in migration commands (`supabase migration new`/`up`/`db push`), which is the most natural fit since this is already a Supabase project, vs. a general-purpose Node/Python migration tool, vs. a small custom runner. Recommend starting with the Supabase CLI's own tooling (least new surface area, and `mcp__Supabase__apply_migration`/`list_migrations` already work the same way this session's work did) unless there's a concrete reason it doesn't fit.
5. **`services/projectors`' actual scope** — see the table above. If nothing needs projection logic beyond what a Postgres trigger can express, this target may not need to exist as a separate deployable service at all. Confirm with the user what (if anything) is actually meant here before inventing a service to satisfy a roadmap bullet literally.
6. **When (or whether) to retire `index.html`** — not a Phase 4 sub-phase, a standing question to revisit at the end of 4F. `docs/ROADMAP.md`'s Guiding Constraint argues for keeping it as long as it's still the fastest way to validate the workflow and demo it to field reviewers.

## Sub-Phases

### 4A. `packages/domain` as a real package

Lowest risk, do this first — it's mostly formalization of something that already works.

- Add a real `package.json` to `src/domain/` (or move to `packages/domain/` — pick one, and update `tests/domain-rules.test.js`'s import path and `scripts/check_repo.py`'s `DOMAIN_RULES_FACTORY_MARKER` sync-check accordingly).
- **Do not remove or change the inline-copy-plus-drift-check pattern in `index.html`/`demo/rescue-app.html`.** That's how the no-build-step prototype consumes this logic today, and it must keep working. The new package is for the *new* apps (4E/4F) to import normally; the prototype keeps its manual-sync copy.
- Acceptance: `tests/domain-rules.test.js` still passes unmodified in behavior, `check_repo.py`'s domain-rules drift check still catches a deliberately-introduced mismatch (verify this, don't assume the path change didn't silently break the check), and the package is importable via a normal `require`/`import` from a throwaway Node script outside `src/`.

### 4B. `packages/fixtures` — reconcile two demo-data generators into one

Real design work. `index.html`'s `loadDemoScenario()` (JS, in-memory objects matching the client's patient shape) and `seed_demo_db.py`'s `SCHEMA`/data (Python, SQLite rows matching the analytics schema) currently describe *the same conceptual demo incident* in two disconnected, hand-maintained implementations.

- Options to evaluate (don't default to the first one without comparing): (a) one JSON/YAML fixture format that both a JS loader and a Python loader read, (b) generate one from the other at build time, (c) leave them separate but document why they're allowed to diverge. Given `docs/OPERATIONS_SAFETY.md`'s synthetic-data-only rule applies to both, and `scripts/check_repo.py`'s drift-detection precedent for domain rules, a shared-source-of-truth approach (a) is the most consistent with how this repo already handles the "two copies of the same logic" problem — but verify the actual field sets line up closely enough to make that worthwhile before committing to it.
- Acceptance: both `index.html`'s demo mode and `seed_demo_db.py`'s output are verifiably generated from (or checked against) the same fixture source, not just visually similar.

### 4C. `database/migrations` — real migration tooling

- Pick a tool (see Decision 4 above), then convert the 16 existing numbered SQL files into that tool's format without changing their content or order — this is a mechanical wrapping, not a rewrite. `database/001_postgresql_schema_v1.1.sql`/`archive/v0.6`/`archive/v0.7` stay as historical archive, not converted (per `CLAUDE.md`: "Preserve historical versions under `archive/` rather than deleting superseded docs/schema").
- Acceptance: applying the full migration history to a fresh empty Postgres database via the new tool produces a schema equivalent to the current live Supabase project's schema (verify with a real diff, not by eye — `information_schema` comparison or `pg_dump --schema-only` on both sides).

### 4D. `services/sync-api` (and resolve the `services/projectors` question)

- **Real constraint to solve first**: the Supabase CLI requires Edge Functions to live at `supabase/functions/<name>/` to deploy them. Moving `supabase/functions/sync-log/` to `services/sync-api/` outright would break `supabase functions deploy` unless the CLI is reconfigured or a symlink/build-copy step is added. Resolve this concretely (test an actual deploy from the new location, don't assume) before moving anything.
- Resolve the `services/projectors` scope question (Decision 5) with the user before doing any work under that name.
- Acceptance: a real deploy of the relocated function succeeds and passes the same live verification this session used for `sync-log` (push/pull round trip, idempotent duplicate resubmission, a blocked-dependency case) — don't take "the code compiles" as sufficient.

### 4E. `apps/command-web` — build before field-mobile

Command-web is the better first real app to build: no offline-first requirement, and the backend it needs (`get_incident_command_state` RPC, `device_presence`, projected `patients` reads, `sync_ingestion_errors`) is already real, RLS-scoped, and consumable directly via a normal Supabase JS client — no new backend work required to get started.

- Scope: the pc/cc/chamal/logistics command views currently in `index.html` (`renderCommander`, `renderCcHeroDashboard`, `renderLogisticsOfficer`, the command panels built this session — device presence, server-state snapshot, poison-event/high-risk review).
- Resolve Decision 2 (framework) before starting.
- Acceptance: feature parity with `index.html`'s command views for at least one full role (recommend `cc`, since it has the richest panel set), verified against the same live Supabase project, not a mock.

### 4F. `apps/field-mobile` — do this last

The hardest, highest-risk piece: offline-first local persistence, background sync, MSTART sweep flow, gloved/one-handed UX, real device presence/heartbeat. Do this after 4A-4E so the domain package, migration tooling, and sync-api relocation are already proven, and after building command-web has surfaced real lessons about the chosen monorepo/build tooling under lower stakes.

- Resolve Decision 1 (Expo vs. PWA) before starting.
- Scope: everything currently in `index.html`'s medic-facing flows (Quick/Extended patient creation, the legacy step-based flow, vitals/tourniquet timers, the local outbox/sync push-pull, `device_presence` heartbeat).
- Acceptance: a full offline round trip (create a patient with no network, reconnect, verify it syncs and appears via `pullProjectedPatientState` on a second device) works end to end on whatever platform was chosen, not just in a simulator/emulator if the answer was native.

### 4G. Retirement decision (not a build sub-phase)

Once 4E and 4F are each at real feature parity with their corresponding slice of `index.html`, revisit Decision 6 with the user explicitly. Don't let this happen by default/neglect — either `index.html` gets a deliberate sunset (with a documented cutover point) or a deliberate "stays as the reference/demo build indefinitely" decision, not silent abandonment of one or the other.

## Risks Specific to This Phase

- **Silent behavior drift between `index.html` and the new apps.** The single biggest way this phase could go wrong: `apps/command-web`/`apps/field-mobile` reimplementing triage/vitals/handover logic slightly differently than `index.html`, with nothing catching the divergence. `packages/domain` (4A) exists specifically to prevent this for the rules it covers — make sure every new app actually imports it rather than re-deriving similar-looking logic, and extend `scripts/check_repo.py`-style drift detection to cover the new apps if there's ever a second inline copy of anything.
- **RLS/authorization gaps recurring in new code paths.** `docs/THREAT_MODEL.md`'s T1 names this as the most concrete, evidenced risk in the codebase — four real instances were found in Phase 3 alone, each incidentally. New apps calling the database directly (rather than through `index.html`'s already-audited call sites) is exactly the kind of new surface where a fifth instance would appear. Budget real review time for this, don't assume RLS "just works" because it worked for the prototype.
- **Scope creep into a full rewrite.** Phase 4 is a split, not a rewrite — behavior, terminology, and role/command logic should carry over from what's documented in `docs/C5_SENTINEL_SAR_MVP_SPEC_v1.2.md`, `docs/API_SURFACE_v1.2.md`, `docs/ROLE_COMMAND_MODEL_v2.8.md`, and `docs/TACTICAL_UI_GUIDELINES.md`, not get "improved" opportunistically along the way. If something genuinely needs to change, that's a separate, explicit decision with the user, not a side effect of restructuring.

## Definition of Done for Phase 4

All of: `packages/domain` is a real importable package with `index.html` still working unmodified via its own synced copy; `packages/fixtures` has one reconciled source of demo data; `database/migrations` runs the full schema history through real migration tooling with a verified-equivalent result; `services/sync-api` is deployed from its new location and re-verified live; the `services/projectors` question is resolved one way or the other (not left ambiguous); `apps/command-web` has real feature parity for at least one command role against the live backend; `apps/field-mobile` has a real verified offline-sync round trip; and the `index.html` retirement question (4G) has been explicitly decided, not defaulted.
