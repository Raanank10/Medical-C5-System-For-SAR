# Multi-Agent Development Plan (RESCUE / C5 Sentinel-SAR)

This is a real execution plan for how a solo developer drives this build using Claude Code's actual agent/task/memory mechanics — not a description of autonomous AI agents shipping code unsupervised. See "Grounding" below for why that distinction matters.

## 0. Grounding

Two corrections to the brief this plan was requested from, made explicit so they don't get silently re-litigated:

1. **No agent here is autonomous.** Claude Code can run subagents (via the `Agent` tool, optionally backed by reusable definitions in `.claude/agents/*.md`) for a single bounded task at a time. Every subagent's output is a diff or artifact that a human reviews before it counts as done. There is no standing team of AI workers building this app unattended. The "agents" below are scoped roles a developer invokes deliberately, not independent actors.
2. **CHAMAL is not a networking protocol.** In this repo's own docs (`docs/ARCHITECTURE.md`), CHAMAL refers to the command dashboard. The documented architecture is cloud sync (`/sync/log` → Postgres event log → projector → command snapshot), decided over local-first mesh because real-world experience is that cellular networks hold up during actual operations. Peer-to-peer mesh is deferred, not built now — see Mission 2.

**A concrete finding that sets Mission 1's priority:** `src/domain/rules.js` (the tested, canonical domain module) and the domain-rules code inlined directly into `index.html` (lines ~1933–2044) have drifted. `src/domain/rules.js`'s `suggestMstartTriage` includes an airway safety check:

```js
if (sabcde.B === "abnormal" && sabcde.A !== "managed") {
  return { triage: "black", reason: "ללא נשימה לאחר פתיחת נתיב אוויר", reasons: [] };
}
```

The copy actually shipped inside `index.html` does not have this check — it has a comment in its place: `// SABCDE airway path removed — use breathing field in MSTART sweep (step1) for non-breathing → black.` That means `tests/domain-rules.test.js` is validating airway-triage behavior that the running app does not exhibit. This needs an explicit decision (which behavior is correct) before any other mission builds on top of it. It is exactly the failure mode "single source of truth for domain rules" is meant to prevent, and it already happened once.

## 1. Multi-Agent System Hierarchy

**Principal Orchestrator: you, not an AI.** You own scope, priority, and — non-negotiably for a triage app — clinical sign-off. Continuity across sessions comes from the memory system already in place plus `TaskList`, not from an agent remembering things on its own.

**Claude Code (per session): the one who actually invokes subagents and is accountable for what merges.** Not a separate entity from your perspective — a tool you direct.

**Sub-agents:** none exist yet as `.claude/agents/*.md` definitions in this repo; creating them is the first concrete step. Each is invoked for one bounded task and reviewed before merge.

| Agent | Scope | Primary tools | Review gate |
|---|---|---|---|
| **Front-End & UI/UX** | Mobile-first tactical layout in `index.html`, Field Mode performance, rapid-tap telemetry | `Explore` first (find existing patterns before adding new ones), then implementation | Manual browser QA (`/verify`). If the change touches the MSTART sweep flow specifically, it also needs the Medical Logic gate below — that boundary is exactly where the drift above happened. |
| **Medical Logic & Triage Engine** | `src/domain/rules.js` **exclusively** as source of truth: MSTART/JumpSTART state machine, pediatric dosing guardrails, vitals/tourniquet timers, priority calc | Direct edits + `tests/domain-rules.test.js` in the same diff | **Never auto-merged.** You manually review every change against MSTART/JumpSTART references before it's "done." `index.html` must load this module's logic, not inline a second copy — this is the fix for Mission 1. |
| **Real-Time Sync & Networking** | Deploy `database/001_postgresql_schema_v1.2.sql`, implement `/sync/log` per `docs/API_SURFACE_v1.2.md`, wire Supabase Auth to the `user_role` enum, enforce the 24 drafted RLS policies, local-first outbox for brief connectivity gaps | `general-purpose` agent for implementation | RLS is **verified by you** with real logged-in test accounts attempting cross-role access — not agent-asserted. Given this is casualty/personnel data, this is the one gate that can't be delegated even in spirit. Mesh/P2P transport is explicitly out of scope now; recorded as a future addition (see Mission 2). |
| **Logistics & Resource** | Supply metrics, low-stock triggers, reinforcement matching, burn rates — real existing surface (`evaluateSupplyBurn`, `renderPcResupplyBoard`, `logisticsCompanies`, `renderLogisticsTaskBoard`), not greenfield | `Explore` to map current logic, then implementation | Manual QA against a scripted supply-depletion scenario |

**Communication protocol.** There is no message bus between agents because there's no standing team. The actual shared state is:
- `memory/` + `MEMORY.md` — durable facts and decisions (already set up)
- `TaskList` — the live work queue, standing in for "what is any agent working on"
- git commits — the integration/merge gate
- the test suite (domain-rules tests, soon Playwright, soon pytest) — the regression gate

Anything more elaborate (agent-to-agent negotiation, a shared blackboard) would be process overhead with no team to justify it.

## 2. Phased Development Roadmap (Missions)

### Mission 1 — Foundation Lock-In (domain rules as single source of truth, real tests)

**Objective & Scope:** Resolve the `rules.js` / `index.html` drift found above. Make `src/domain/rules.js` the only place triage and dosing logic lives — `index.html` must reference it, not inline a copy. Retire the seven `scripts/smoke_v2_9x_*.js` string-matching scripts (they assert substrings exist in the HTML, not that behavior is correct) and replace with real Playwright browser tests.

**Assigned agents:** Medical Logic Agent (drift resolution, decided in consultation with you — this is a clinical call, not an engineering one), Front-End Agent (wire `index.html` to load the module instead of duplicating it).

**Feature focus:** MSTART fast-scan classification, pediatric dosing guardrails, vitals/tourniquet timers.

**Adaptability buffer:** `rules.js` is pure functions with no UI dependency. A future protocol change (new drug, new triage branch, JumpSTART-specific logic) is an additive function with its own test — it cannot silently touch rendering code, because nothing in `index.html` should contain triage logic anymore.

**Definition of Done:** zero inline duplicate of triage/dosing logic in `index.html`; the SABCDE airway-check divergence is explicitly resolved (kept or dropped) with both the module and its tests reflecting the same decision; Playwright covers en route intake → MSTART fast scan → full vitals entry → tourniquet timer → pediatric dose block; CI runs the Playwright suite alongside the existing domain-rule tests.

### Mission 2 — Cloud Backbone (schema, auth, RLS, sync API)

**Objective & Scope:** Deploy the already-drafted Postgres schema, wire real Supabase Auth mapped to `user_role`, enforce the 24 drafted RLS policies against real accounts, implement `/sync/log` push/pull per `docs/API_SURFACE_v1.2.md`.

**Assigned agents:** Sync & Networking Agent (schema deploy, API implementation), you (RLS verification — non-delegable).

**Feature focus:** en route intake events flowing device → event log → projector → command snapshot; local-first outbox as resilience for brief gaps only.

**Adaptability buffer:** the event-sourced schema means new event types — including a future mesh transport — are additive rows/enum values, not migrations that touch existing data. This is where mesh/P2P sync is explicitly parked: recorded as a deferred future addition riding on the same event log, not re-architected from scratch later. Add one line to `ARCHITECTURE.md`'s "Planned Production Split" section marking this so a future "let's add mesh" proposal has to argue against a recorded decision instead of silently reopening it.

**Definition of Done:** real login works end to end; a live cross-role access attempt is blocked by RLS; one synthetic incident's full event lifecycle round-trips correctly through sync → event log → projector; a duplicate event submission is proven idempotent.

### Mission 3 — Command Surface + Logistics (commander matrix, resource tracking)

**Objective & Scope:** Commander overview matrix and logistics/supply tracking running against real synced data instead of local demo-seed data.

**Assigned agents:** Front-End Agent (matrix UI, stale/last-seen indicators), Logistics & Resource Agent (burn-rate, low-stock triggers on top of existing logic), Sync Agent (projector views like `vw_command_incident_throughput_funnel`).

**Feature focus:** commander overview matrix, data-freshness indicators (already specified under "Data Freshness" in `ARCHITECTURE.md`).

**Adaptability buffer:** command UI reads only projector/snapshot views, never raw events — new KPIs or matrix columns are additive SQL views, not schema changes.

**Definition of Done:** dashboard reflects real multi-device incident state within a defined sync-latency bound; a disconnected test device correctly shows as stale; a scripted supply-depletion scenario correctly fires a low-stock trigger.

### Mission 4 — Real Drill + AAR + Job-Search Package

**Objective & Scope:** Run one real or realistic drill, process its actual event log through the AAR/analytics pipeline, and produce the job-search deliverables.

**Assigned agents:** Logistics & Analytics Agent (KPI engine, pytest suite for `analytics/`), you (drill execution — not delegable), general-purpose agent (draft prose for the case study/RICE writeup for you to edit, not publish verbatim).

**Feature focus:** post-action AAR diagnostics, full vitals history review, sync-gap reporting.

**Adaptability buffer:** analytics reads only from the event log/projector layer, so future event types or KPIs don't require reworking the AAR generator — just new queries.

**Definition of Done:** one real drill fully processed through the AAR pipeline; SQL portfolio queries run against that real data (not seed data); a RICE-style prioritization writeup published; a dashboard built from the real drill data.

## 3. Change-Management Protocol

- Every scope change — addition or removal — is written to `memory/` and `TaskList` **before** any agent starts on it. That written state, not a runtime negotiation between agents, is what "orchestrator routing" actually means here.
- **Additions:** create a task tagged to the mission it belongs to. If it doesn't fit an existing mission's boundary, that's a signal the mission boundaries need redrawing, not that the feature should be forced in.
- **Removals:** mark the task cancelled with a one-line reason in memory rather than deleting it silently. This avoids re-litigating the same idea later and doubles as material for the job-search case study ("here's what we cut and why").
- **Medical logic changes are always human-reviewed against tests and never auto-merged**, regardless of schedule pressure. This is a hard constraint on the workflow itself, not an agent policy that can be waived.
- **Architecture decisions** (cloud-vs-mesh being the live example) get one line recorded in the relevant doc (`ARCHITECTURE.md`) so a future proposal has to explicitly argue against a recorded decision instead of silently reopening it.
- **The actual merge gate is git + the test suite** (domain-rule tests now, Playwright and pytest as they land in Missions 1 and 4). There is no separate agent-approval workflow beyond that — for a one-person team, anything more would be process for its own sake.
