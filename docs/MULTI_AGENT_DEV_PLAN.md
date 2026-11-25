# Multi-Agent Development Plan (C5 Sentinel-SAR)

How work on this repo is planned, built and reviewed with Claude Code. Rewritten 2026-11-25: the first version (now [archive/docs/MULTI_AGENT_DEV_PLAN_v1.md](../archive/docs/MULTI_AGENT_DEV_PLAN_v1.md)) planned four builder agents and four missions for a backend that did not exist yet. The backend has been live for weeks, the missions are done or folded into [GAP_CLOSURE_PLAN.md](GAP_CLOSURE_PLAN.md), and no agent was ever defined. This version records what is actually used.

## 1. Who does what

- **The owner** sets scope and priority, makes every clinical decision, verifies RLS against real accounts, applies SQL live, and approves every merge. None of this is delegated.
- **One Claude Code session per work package** builds the whole vertical slice: `index.html`, `src/domain/rules.js`, `database/*.sql`, `sync-log`, tests and docs together. The pattern is research, present findings, ask before ambiguous or architecturally significant decisions, implement, verify, small PR, wait for merge approval.
- **Review agents** (section 2) are read-only. The session runs them on its own diff before asking the owner to merge. They find problems; they decide nothing.

### Why there are no builder agents

The first plan split building by area (front-end, medical logic, sync, logistics). That does not fit this repo: almost every feature touches the 20,000-line `index.html`, a migration, `sync-log`, a browser test and several docs at once. Splitting one slice across agents means conflicting edits to one file and lost context between them. Revisit this after the Phase 4 split ([PHASE_4_PLAN.md](PHASE_4_PLAN.md)) gives the code real module boundaries.

## 2. Review agents (`.claude/agents/`)

| Agent | Run it when the diff touches | What it checks |
|---|---|---|
| `clinical-rules-reviewer` | `src/domain/rules.js`, its inlined copy in `index.html`, triage, vitals, tourniquet, pediatric/dose, deterioration, evacuation-wait alerts, patient status | Rules and tests change together, boundaries and units, missing data stays visible, pending never green, alert levels, role authority, docs updated. Clinical judgment calls are marked "needs owner clinical decision", never approved by the agent. |
| `rls-sync-reviewer` | `database/*.sql`, `supabase/functions/*`, `src/domain/event-contract.json`, sync push/pull, role or incident scope | The `app.*` access convention from [RLS_AUDIT_v1.md](RLS_AUDIT_v1.md), `SECURITY DEFINER` hygiene, spoofed roles, idempotency, poison-event quarantine, late offline pushes, audit history, migration hygiene. With the Supabase connector it compares the repo with the live project through read-only tools; it has no SQL tool and writes the SQL for the owner to run. |
| `docs-drift-checker` | Any feature or fix, before merge | The docs that govern the change were updated; CLAUDE.md facts (version, line count, migration range, test list) and status markers in ROADMAP and GAP_CLOSURE_PLAN match the repo. Live claims are listed for the owner to confirm. |

All three are read-only (they report; the session fixes), and none replaces the owner's gates: clinical sign-off for medical logic, real-account verification for RLS.

### How they get used

- **By rule:** CLAUDE.md tells every session to run the matching agent before asking for merge, and to put each agent's verdict in the PR description. This is the reliable path; do not rely on the session choosing to delegate on its own.
- **By asking:** in any Claude Code session, "run the clinical-rules-reviewer on this branch" (or `@clinical-rules-reviewer` in the CLI). `/agents` in the CLI lists and edits them.
- **Cost:** each run starts a fresh context and reads the docs again. Run them once per PR when the diff is ready, not after every edit.
- **Supabase tools:** `rls-sync-reviewer` lists the connector's tools as `mcp__Supabase__*`, the name in the owner's cloud sessions. In a session where that connector has another name or is not connected, the agent reviews from the repo only and says so.

## 3. Parallel branches: migration numbers and versions

Most merge pain in the history came from two branches picking the same next migration number or `APP_VERSION` (the files now numbered 043-046, 049-050, 054, 074, 076-077, 088 and 094 were all renumbered at merge; see the notes in [RLS_AUDIT_v1.md](RLS_AUDIT_v1.md), [ARCHITECTURE.md](ARCHITECTURE.md) and [GAP_CLOSURE_PLAN.md](GAP_CLOSURE_PLAN.md)). Rules:

- `python scripts/check_repo.py` fails when two `database/*.sql` files share a number (only the v1.1/v1.2 pairs of `001`/`002` are exempt). Pull-request CI runs on the merge with `main`, so a clash shows up on the PR before it merges.
- Take the migration number and the version from `main` as late as possible, when the PR is ready, and merge `main` again right before asking for merge.
- A migration already applied live keeps its live name; record the repo number and live name in the docs as the existing notes do. Never rename a live migration.

## 4. Shared state

There is no message bus and no standing team. The shared state is git (commits and PRs are the integration gate), CI (`repo-check` and `browser-and-smoke-tests`), the docs (especially [GAP_CLOSURE_PLAN.md](GAP_CLOSURE_PLAN.md) for work packages and owner decisions, dated "owner, YYYY-MM-DD"), and the owner's notes. Medical-logic and RLS changes are never auto-merged.

## 5. History

Things the first version recorded that are still true and still referenced:

- **The `rules.js` / inlined-copy drift** (the SABCDE airway check present in one copy and not the other) was the reason for "single source of truth for domain rules". `scripts/check_repo.py` now fails if the two copies differ.
- **Cloud sync over mesh networking** was decided because cellular networks hold up in real operations. Peer-to-peer mesh stays deferred, and this section is where the decision is recorded, so a proposal to add it has to argue against it. (The first version planned a line in ARCHITECTURE.md as well; it was never added.)
- **"CHAMAL" is the command system role and dashboard**, not a network protocol.
