# Decision Needed: Cross-Device Concurrent-Edit Resolution (F3)

This is an open decision, not a settled one — written up for the user to decide, the same way `docs/PHASE_4_PLAN.md`'s six framework/tooling decisions were made explicitly before that plan was finalized rather than assumed. `docs/ROADMAP.md`'s Phase 4 gate points here: this should be resolved before `apps/command-web`/`apps/field-mobile` exist, because it's currently a silent behavior, and splitting into two codebases would otherwise just reimplement that silence twice.

## The problem

`docs/FAILURE_MODE_REVIEW.md`'s F3 describes the current, real behavior: `pullProjectedPatientState`'s "local edit wins until pushed" rule is evaluated **per device, against that device's own outbox only**. It has no visibility into another device's concurrent edit.

Concretely: two devices (two medics, or a medic and a `pc`) each have a genuinely concurrent unsynced edit to the same patient — say Device A logs a triage override to red while Device B logs a medication administration. Both push independently. For fields `project_patient_state()` treats as single-column overwrites (`current_triage`, `current_status`), whichever event's trigger fires last on the server wins. Nothing is merged, nothing is surfaced to either medic, and the loser's specific intent (the triage override, in this example) is gone from projected state — though it's worth noting the *event itself* is never lost; it's still in the append-only event log and AAR timeline, just not reflected in the live projected `current_triage`.

`conflict_log`/`PATIENT_EDIT_CONFLICT_DETECTED` already exist, but only catch same-device conflicts (e.g. two browser tabs on one device comparing `lastModifiedAt` at open vs. save time) — not this cross-device case.

This is exactly the scenario `docs/FIELD_USABILITY_TEST_PLAN.md` Session 2 step 4 is designed to deliberately stage, and Session 4 (full MCI rehearsal) is likely to surface it naturally. A real drill run is evidence for this decision, not a substitute for making it — the drill can confirm the current silent-overwrite behavior actually happens as described, but it can't choose the right fix; that's a product call about what should happen when two medics genuinely disagree about a patient's status within the same ~45-second window.

## Options

**A. Last-write-wins, but surfaced.** Keep the current overwrite behavior for the projected single-column fields, but write a `conflict_log` entry (or a new event type, e.g. `PATIENT_FIELD_CONFLICT_DETECTED`) whenever `project_patient_state()`'s trigger overwrites a field that another event touched within a short window (e.g. 2 minutes). The command view surfaces this as a flag on the patient card. Nothing blocks either medic in the moment; the conflict becomes visible after the fact, to a `pc`/`cc` who can follow up. Lowest engineering cost, closest to current behavior, but still means a real triage override can be silently overwritten *from the acting medic's own point of view* until someone downstream notices the flag.

**B. Field-level, not row-level, merge.** Instead of one event's trigger overwriting the whole `current_triage`/`current_status` column, project a small ordered history per field (e.g. keep the last N triage-setting events per patient) so the server can distinguish "these two events touched different fields, both can apply" from "these two events touched the *same* field, one must win." Reduces false conflicts (the example above — a triage override and a medication administration — wouldn't need to conflict at all under this model, since they touch different fields) but is real schema/projection work, not a policy choice layered on top of what exists.

**C. Authority ordering.** Define an explicit priority order among roles/event types for genuinely same-field conflicts — e.g. a triage override from a `cc` always wins over one from a `medic`, or an explicit `PATIENT_TRIAGED_EXPECTANT` always wins over any other triage event regardless of timing. Requires deciding and documenting a real clinical/command authority hierarchy (touches `docs/ROLE_COMMAND_MODEL_v2.8.md` and possibly `docs/CLINICAL_GOVERNANCE_REVIEW_FRAMEWORK.md`'s domain, since it's encoding who is allowed to overrule whom, not just a data-merge rule) — the highest product complexity of the three, but the only one that reflects "some overrides should always win" rather than treating every conflict as a tie broken by timing.

**D. Do nothing new — accept current behavior, document it as a known limitation.** Keep last-write-wins with no surfacing beyond what `docs/FAILURE_MODE_REVIEW.md` already documents. Only defensible if the field usability drill (Session 2/4) shows this scenario is rare enough in practice, or severe enough consequences are judged acceptable at this prototype stage — this option itself needs the drill's evidence to justify, not just default inertia.

These aren't mutually exclusive in sequence — A is a reasonable interim step even if B or C is the eventual target, since it's the cheapest way to stop the failure from being *silent* while a fuller fix is designed.

## What this decision should produce

Once decided: update `docs/FAILURE_MODE_REVIEW.md`'s F3 entry from "Open" to reference this decision, update `docs/API_SURFACE_v1.2.md`/`docs/ARCHITECTURE.md` if a new event type or projection behavior is introduced, and add the chosen behavior as an explicit case in `docs/PHASE_4_PLAN.md`'s 4E/4D scope (this is exactly the kind of new API surface Phase 4's command-web build needs to implement correctly from the start, not retrofit later).

## Not decided here

This document lays out the problem and options; it does not pick one. Per this repo's established pattern (`docs/PHASE_4_PLAN.md`: "ask before ambiguous/architecturally significant choices"), the choice among A-D belongs to the user.
