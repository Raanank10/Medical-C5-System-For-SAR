# Failure-Mode Review: Stale Data and Sync Conflicts

`docs/ROADMAP.md` Phase 5 deliverable. Walks the real failure modes of the sync/local-persistence architecture (`docs/ARCHITECTURE.md`'s "Backend Deployment Status", `docs/ROADMAP.md` Phase 3) against what actually happens in the code today, not what the design intends. One real, previously-unknown data-loss bug was found and fixed while writing this — see F1.

## F1: Outbox cap could silently drop unsynced clinical data (found and fixed here)

**The failure**: `persistOutbox()` capped the local sync outbox at 500 entries via a blind `slice(-500)` — keep the last 500 array elements, evict the rest, with zero awareness of which entries had actually synced yet. On a long enough offline stretch (the exact scenario this whole local-first architecture exists for — extended offline operation during an MCI), the oldest entries evicted could be real, still-unsynced clinical events (`TOURNIQUET_APPLIED`, `MEDICATION_ADMINISTERED`, vitals), not just old already-synced history. No error, no warning — the data would simply never reach the server, and nothing in the UI would indicate it happened.

**Verified real, not theoretical**: reproduced with a Playwright test simulating 700 unsynced events accumulating (a device offline long enough to generate more events than the cap) — the old `slice(-500)` logic would keep only the most recent 500, silently discarding the oldest 200 unsynced clinical events.

**Fixed**: `persistOutbox()` now evicts only already-synced entries when trimming, and never evicts an unsynced one — if unsynced entries alone exceed 500 (a genuinely extreme offline period), the outbox is allowed to grow past the cap rather than lose data. That's a deliberate tradeoff (accept local storage growth over silent data loss), stated explicitly in the code, not assumed. Verified with three cases: normal mixed capping preserves all unsynced entries; an extreme 700-unsynced-only scenario preserves all 700; a boundary case with unsynced entries mixed among older synced ones still preserves every unsynced entry.

**Residual risk**: the outbox itself is still a single client-side array capped at "however large unsynced growth gets," with no separate durability guarantee beyond `localStorage` (now encrypted at rest, `docs/THREAT_MODEL.md` T2, but still a single browser storage location with the platform's usual eviction-under-memory-pressure behavior — see F2).

## F2: Browser/OS storage eviction under memory pressure

`localStorage` (even encrypted) can be cleared by the browser/OS under storage pressure, or by a user clearing site data, or by a WebView crash-and-restart on a low-end device. Unlike F1 (a bug in this codebase's own logic), this is a platform-level risk inherent to the architecture choice of `localStorage` as the persistence layer at all.

**Current mitigation**: none beyond what F1's fix provides (protecting against this codebase's own logic making the problem worse). No detection exists for "storage was cleared out from under a live session" — the app would simply see empty state on next load, indistinguishable from a genuinely fresh device.

**Recommendation**: this is the real argument for `docs/PHASE_4_PLAN.md`'s `apps/field-mobile` eventually using a more durable storage layer (IndexedDB at minimum, real on-device SQLite for a native/Expo build) rather than `localStorage`. Not something to retrofit into the single-file prototype — `index.html` stays on `localStorage` per Phase 4's "keep the prototype working unmodified" principle — but a real requirement for whatever replaces it.

## F3: Concurrent edits to the same patient from two devices

The pull-side projection policy (`pullProjectedPatientState`, `docs/ROADMAP.md` Phase 3) is "local edit wins until pushed" — a device with an unsynced local edit to a patient skips applying incoming server state for that patient until its own edit clears. This is evaluated **per-device, against that device's own outbox only** — device A's pending edit has no effect on what device B sees or does.

**Failure scenario**: two devices (e.g. two medics, or a medic and a `pc`) both have genuinely concurrent unsynced edits to the same patient — say, one records a triage override while the other logs a medication. Both push independently. The server processes both as separate events (this is fine — the system is event-sourced, not last-write-wins on a single mutable row for most fields); but for fields where `project_patient_state()` does overwrite a single column (e.g. `current_triage`, `current_status`), whichever event's trigger fires last wins, with no merge and no conflict surfaced to either medic.

**Current mitigation**: partial. `conflict_log` and the `PATIENT_EDIT_CONFLICT_DETECTED` event exist for same-device concurrent-edit detection (comparing `lastModifiedAt` at modal-open time vs. save time) but this only catches conflicts within *one device's* local storage (e.g. two browser tabs), not genuine cross-device concurrent edits — those are silently resolved by "whichever trigger fired last," with the loser's specific field-level intent gone, not merged or flagged.

**Recommendation**: this was a real, unaddressed gap, not just a documentation note — now decided, not yet built. `docs/CONFLICT_RESOLUTION_DECISION.md` records the chosen resolution: field-level projection (so unrelated-field edits never conflict) plus a role-authority tie-break for genuine same-field collisions (physician > cc > pc > medic), with every authority-rule override logged and surfaced rather than silently lost. Building it is real schema/trigger work on `project_patient_state()`, deliberately deferred to `docs/PHASE_4_PLAN.md`'s command-web/field-mobile split rather than done now — see that decision doc for the full reasoning and one open prerequisite (the "physician" role in the chosen order doesn't exist in the live server role enum yet).

## F4: Stale command-dashboard data goes unnoticed

The command view's sync-freshness indicator (`.sync-pill`, fresh/stale/offline) and the new server-state panel (`get_incident_command_state`, `database/014`) both refresh on a 45-second interval. Nothing *forces* a commander to notice a "stale" or "offline" badge — it's a passive UI element among many on a dense command screen.

**Failure scenario**: a commander's device loses connectivity but the app continues showing the last-fetched state without any commander action required to acknowledge staleness. If that commander is making evacuation-priority or resource-allocation decisions based on a screen that silently stopped updating minutes ago, the failure is a decision made on dead data, not a visible error.

**Current mitigation**: the badge exists and is real (not decorative — driven by actual push/pull success/failure), but it's passive, not an active interrupt. `docs/PRODUCTION_READINESS.md`'s "Commander stale-data comprehension testing" (Field Validation section) is exactly the open item that would answer whether this passive signal is actually sufficient in practice — it hasn't been tested with real users under field-like attention conditions.

**Recommendation**: don't build a more aggressive interrupt (a modal, a forced acknowledgment) without that field-validation data first — an over-aggressive staleness alert has its own failure mode (alert fatigue, commanders learning to dismiss it reflexively). This is a genuine "test before building more" case, not a pure engineering gap.

## F5: A handover event created but never synced

`PATIENT_HANDED_OVER` is created locally first (per the whole local-first design) and queued in the outbox like any other event. If the originating device is destroyed, lost, or simply never regains connectivity after the handover is logged, the server-side record of that patient's status never reaches `handed_over` — the live system continues believing the patient is in whatever status they were in before, indefinitely.

**Current mitigation**: none beyond the general outbox durability improved by F1's fix (the event won't be silently evicted from the outbox anymore, but it still won't sync if the device never comes back online). `patient_handover_tokens`/QR-based handover (`docs/PRODUCTION_READINESS.md`'s "Implement handover with signed QR tokens" — still `[~]`, not fully verified end to end per that doc) is the intended mechanism for the *receiving* organization to have independent confirmation that doesn't depend on the originating device ever syncing again, but that flow isn't fully built/verified.

**Recommendation**: real gap, correctly already tracked in `docs/PRODUCTION_READINESS.md` rather than newly discovered here — cited so this review doesn't imply it's unaddressed elsewhere. Completing and verifying the QR handover flow end to end is the actual fix, not something this review can resolve by itself.

## Summary

| # | Failure mode | Status |
|---|---|---|
| F1 | Outbox cap could silently drop unsynced data | **Fixed** in this review (verified with 3 Playwright cases) |
| F2 | Platform-level `localStorage` eviction | Open — architectural, addressed by Phase 4's move away from `localStorage` for new apps |
| F3 | Cross-device concurrent edits to the same patient | Decided, not yet built — hybrid field-level-merge + role-authority resolution, `docs/CONFLICT_RESOLUTION_DECISION.md`. Build deferred to `docs/PHASE_4_PLAN.md` |
| F4 | Passive stale-data indicator may go unnoticed | Open — needs field-validation data before deciding whether to make it more aggressive |
| F5 | Handover event created but never synced | Open — already tracked in `docs/PRODUCTION_READINESS.md`, the QR-token flow is the real fix |

Only F1 was fixed as part of this review; F2-F5 are documented findings requiring either Phase 4 architecture work, product decisions, or field-validation data this review doesn't have access to — flagging them accurately matters more than pretending they're resolved.
