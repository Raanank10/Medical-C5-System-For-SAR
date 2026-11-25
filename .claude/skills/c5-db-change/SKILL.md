---
name: c5-db-change
description: Any change to the C5 Sentinel-SAR Supabase backend - SQL migration, RPC or Postgres function, table, column, enum, trigger, RLS policy, or the sync-log Edge Function. Covers read-only inspection first, the owner's approval gate, numbering, the SECURITY DEFINER rules, how to apply, and verifying live. Also use for read-only checks of what is applied live.
---

# Database, RPC and sync-log changes in C5 Sentinel-SAR

Sources: `CLAUDE.md` ("Owner rules", event-sourced data model), `docs/GAP_CLOSURE_PLAN.md` ("Rules for every WP", "Live access note", "Numbering in this round", WP-35), `docs/DEVELOPMENT.md` ("Validating SQL Drafts", "Event Contract"), `docs/RLS_AUDIT_v1.md`. If they disagree with this file, the source wins.

## Hard gates

1. **Read-only first.** Inspect before proposing: `list_tables`, read-only `execute_sql`, `list_migrations`, the function's current definition (`select pg_get_functiondef('app.fn_name'::regproc)`), and the repo file that created it. Live and repo can differ (WP-35: many files were applied in the SQL editor and have no migration row; live names do not always match repo numbers).
2. **Owner approval before anything live.** Present the plan, the full SQL and the deploy order, then wait for an explicit OK in the conversation. Applies to every RPC, function, table, column, enum, trigger and policy change and to every `sync-log` deploy. Read-only queries need no approval.
3. **Find before delete.** Dropping or renaming a function, column, table, policy or enum use needs evidence first: `grep -rn` across `index.html`, `supabase/`, `database/`, `scripts/`, `analytics/`, plus a read-only query for live dependents (`pg_depend`, policies and triggers that reference it). Prefer archive or rename over drop (D2 precedent: `inventory_ledger_v11_archived`).
4. **Drill data is real.** Never delete, reset or "clean" incident, patient or event rows in the live project. Tests that write live run inside a transaction that is rolled back.

## Writing the change

- A new numbered file in `database/`, never an edit to an applied one. Take the next free number from `main` right before merging (parallel sessions have collided). Older `_v1.1` and `archive/` files are history: do not touch.
- Every new trigger or `SECURITY DEFINER` function: `security definer`, `set search_path`, and `revoke execute ... from public, anon, authenticated` (pattern: `database/046`).
- The event log and audit tables stay append-only for every role, admin included.
- Invalid or dependency-blocked events go to `sync_ingestion_errors` (poison event quarantine). Never design sync logic that fails a whole batch on one bad event.
- A new synced event type goes into four places in one change: the `event_type` enum (this migration), `ROLE_ALLOWED_EVENT_TYPES` in `supabase/functions/sync-log/index.ts`, `SYNC_ELIGIBLE_EVENT_TYPES` in `index.html`, and `src/domain/event-contract.json`.
- The client must keep working if the migration is not applied yet (separate queries, tolerate missing columns), as `044` did.
- Run `python scripts/check_repo.py` (balanced parens and `$$` blocks, `references` targets resolve). It is not a SQL parser; Postgres is the only full validation (`docs/DEVELOPMENT.md`).

## Applying (only after approval)

1. Order: migration, then the `sync-log` Edge Function, then the client.
2. Apply with the Supabase connector (`apply_migration`) or the Supabase CLI, named after the repo file (`094_pc_review_requests`). Never paste into the dashboard SQL editor: pastes leave no migration row, and a long file pasted from a phone was cut off mid-function (`090`, 2026-11-20).
3. Run `get_advisors` (security and performance) right after, and report any new finding.

## Verifying live

- Probe every object the file creates (columns, functions, triggers, enum values, grants), read-only.
- RLS: impersonate each affected role inside a transaction that is rolled back, with real profiles, as in `docs/RLS_AUDIT_v1.md`. Check both what a role can do and what it must not.
- Record the result where the plan says (the WP's status row; WP-35's applied-live table when relevant). Do not add migration-list rows to make history look complete.

## Report back

What was inspected, the SQL, what the owner approved, what was applied and how, advisor output, and the live verification with its queries. Say clearly which parts were verified live and which only in stubbed tests.
