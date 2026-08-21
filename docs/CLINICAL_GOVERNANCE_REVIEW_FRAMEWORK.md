# Clinical Governance Review Framework

`docs/ROADMAP.md` Phase 5 deliverable. **This document does not contain clinical sign-off, and is not written by a qualified medical/SAR doctrine authority.** Per `docs/OPERATIONS_SAFETY.md`: "the prototype may support documentation and visibility, but it must not replace medic judgment, commander judgment, medical doctrine, evacuation policy, organizational approval, [or] clinical governance." What follows is a complete catalog of every hardcoded clinical/timing parameter and algorithmic triage decision currently in the codebase, organized as the concrete checklist a real reviewer would need — not an assessment of whether any of these values are correct. Where this document expresses an opinion, it's about software behavior (does the system let a human override the algorithm, is the value documented, is it consistent across the codebase), never about clinical appropriateness.

## Method

Every numeric threshold and triage-decision rule in `src/domain/rules.js` (the single source of truth these parameters are supposed to have, per `docs/ARCHITECTURE.md`) was extracted with its exact current value and code location. Anything with clinical/doctrine implications is listed below regardless of how confident the code's own comments sound — a well-commented default is still a default that hasn't been signed off by anyone with the authority to do so.

## 1. MSTART Triage Classification

Two related but distinct functions exist — a reviewer needs to look at both, not just one:

- **`suggestedSweepColor()`** — the initial fast-sweep classifier (walking/breathing/perfusion/AVPU/trapped), used during the first pass across a scene before any vitals are taken.
- **`computeMstartTriage()`/`suggestMstartTriage()`** — the full-vitals classifier, used once actual vitals (RR, BP estimate, AVPU, SpO2) are recorded.

Current rules (exact, from `src/domain/rules.js`):

| Condition | Assigned color |
|---|---|
| `rr === 0` (not breathing) | Black |
| RR > 30 or (RR > 0 and RR < 10) | Red |
| BP estimate absent/carotid-only | Red |
| AVPU not "A" | Red |
| SpO2 < 94% | Red |
| BP estimate "weak"/"radial weak" (and none of the above) | Yellow |
| AVPU "A" + radial pulse + RR 10-30 | Green |
| Anything else (partial/ambiguous data) | Yellow (never auto-Green on incomplete data) |

**Questions for the reviewer**: are these exact numeric cutoffs (RR 10/30, SpO2 94%) the ones this organization's doctrine actually uses? Is "default to yellow on ambiguous data, never green" the correct conservative bias, or should some ambiguous cases default differently? Does the sweep classifier (pre-vitals) and the full classifier (post-vitals) disagree in any scenario in a way that would confuse a medic moving from one screen to the other?

## 2. Vitals Reassessment Cadence

`VITALS_INTERVAL_MS_BY_TRIAGE`: red every 10 minutes, yellow every 20, green every 30 (1-minute warning buffer before each). A patient with no triage yet defaults to the red/most-conservative interval.

**Questions for the reviewer**: are these intervals doctrine-correct for this organization's operating context? Is a 1-minute warning buffer enough lead time for a medic to actually act on it in a real MCI, or does it need to be longer given real cognitive load?

## 3. Tourniquet Reassessment Timing

`TOURNIQUET_NOTICE_MS`/`WARN_MS`/`CRITICAL_MS`: a 45-minute heads-up notice, 60-minute warning, 120-minute critical threshold, all measured from application.

**Questions for the reviewer**: these specific numbers were set explicitly by product direction earlier in this project's history (not derived from a cited doctrine source in the code itself) — does a real tourniquet-timing doctrine source exist that should be cited here, and do these numbers match it? A prior version of this code had 40-minute/60-minute thresholds that were corrected — worth double-checking there isn't a *third* number that's actually correct.

## 4. Pediatric Detection and High-Risk Medication Dosing

`PEDIATRIC_AGE_CUTOFF = 8` (under 8, or explicitly flagged as pediatric age group, triggers pediatric handling). `PEDIATRIC_HIGH_RISK_DOSE_LIMITS`: morphine 4mg max, fentanyl 50mcg max, compared against a weight estimate derived from age (`Math.max(4, age*2+8)` kg when age is known, else a conservative 4kg floor when age is unknown).

**This is the single highest-stakes item in this entire document.** A wrong pediatric age cutoff or a wrong dose limit is a direct patient-safety risk, not a UX inconvenience. **Questions for the reviewer**: is age 8 the correct pediatric/adult dosing boundary for this system's doctrine (many pediatric protocols use weight-based or different age cutoffs, e.g. 12, or "pediatric" defined by weight alone rather than age at all)? Are 4mg morphine / 50mcg fentanyl the actual correct maximum single-dose limits per the doctrine this system is meant to follow? Is the age-to-weight estimation formula (`age*2+8`) an actual accepted pediatric weight-estimation formula (this resembles a real clinical estimation heuristic but needs confirmation it's the one this organization uses, not just a plausible-looking guess), and is a 4kg floor for unknown-age patients appropriately conservative or dangerously low?

## 5. Black/Expectant Triage

`PATIENT_TRIAGED_EXPECTANT` is a fast-exit event (`docs/ARCHITECTURE.md`): bypasses remaining assessment forms, sets status to `deceased`, locked (a terminal status guard prevents any further status change — verified live this session, `docs/THREAT_MODEL.md`/`RLS_AUDIT_v1.md`). The *triggering* criteria are `rr === 0` in the algorithmic classifiers above, or a human command explicitly marking a patient black via the UI.

**Questions for the reviewer**: is "not breathing" alone (without an airway-opened check first) the correct black-triage trigger, or does doctrine require confirming airway obstruction has been ruled out before classifying black? (The sweep classifier's `breathing === "no"` branch does check `airwayOpened`/`breathingAfterAirway` before defaulting to black vs. red — confirm this sequencing matches real MCI triage doctrine, e.g. START/JumpSTART's actual airway-reposition-then-recheck step.)

## 6. Device-Silence / Dead Man's Switch Threshold

`DEVICE_SILENCE_MS = 10 minutes`. Not itself a clinical parameter, but it gates a safety-relevant alert (a medic who's gone silent for 10 minutes triggers a command-visible watchdog).

**Question for the reviewer**: is 10 minutes an operationally appropriate silence threshold for this environment, balancing "catch a real emergency quickly" against "false alarms from normal signal gaps in a collapsed structure"?

## What the System Already Does to Support Human Override

Not everything above is a rigid, unoverridable rule — cataloging what already exists matters for the reviewer's assessment of overall risk:

- `overrideSweepColor()`/`manualTriageOverride()` let a human explicitly override the algorithmic sweep/full triage suggestion, with a required `overrideReason` free-text field.
- `p.mstart.overrideReason` is tracked per-patient and counted in the AAR (`manualOverrideCount`), so overrides are visible in after-action review, not silent.
- None of the triage functions block a human from disagreeing with them — they produce a *suggestion* (`suggestMstartTriage`'s naming is deliberate), not an enforced final value.

**Question for the reviewer**: is the override affordance itself sufficient (a free-text reason, no second-person confirmation) for a decision this consequential, or does doctrine require a stronger control (e.g. a second reviewer's confirmation) for overriding an automated black/red classification specifically?

## Sign-Off Structure (for the actual reviewer to complete)

This document does not include a filled-in sign-off — that requires a qualified authority this session doesn't have. A real review should produce, at minimum: (1) for each numeric threshold above, either "confirmed correct per [cited doctrine source]" or "revise to X per [cited doctrine source]"; (2) for each triage-logic branch, either "confirmed correct" or a specific correction with rationale; (3) an explicit statement of what training/human-override requirements are needed before any real (non-synthetic) use, referencing `docs/PRODUCTION_READINESS.md`'s "Clinical and Operational Governance" section, which this document feeds into.

## Explicitly Out of Scope Here

- Whether the *UI* correctly displays these values to a medic under field conditions (gloves, low light, one-handed) — that's `docs/PRODUCTION_READINESS.md`'s Field Validation section, a usability question, not a doctrine-correctness one.
- Legal/regulatory approval for using algorithmic triage suggestions at all in a real deployment — an organizational/legal governance question, not a clinical-parameter one.
