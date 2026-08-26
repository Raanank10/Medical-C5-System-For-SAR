# Field Usability Test Plan

`docs/ROADMAP.md` Phase 5 deliverable: a concrete testing protocol for `docs/PRODUCTION_READINESS.md`'s Field Validation section (gloved touch, low-light/sunlight, one-handed workflow, offline/intermittent-connectivity, commander stale-data comprehension, synthetic MCI rehearsals) — currently just a bullet list with no actual protocol behind it. **Synthetic scenarios and synthetic data only** (`docs/OPERATIONS_SAFETY.md`'s non-negotiable) — no real patient data, no real names, no real operational locations, in any test run under this plan.

## Why This Matters More Than It Looks

`docs/FAILURE_MODE_REVIEW.md`'s F4 finding is the direct motivation for one specific test in this plan (commander stale-data comprehension) — that review explicitly said the passive sync-freshness indicator's real-world sufficiency "hasn't been tested with real users under field-like attention conditions" and recommended testing before building a more aggressive alternative. This plan is how that testing actually happens, not more speculation about it.

## Test Sessions

### Session 1: Gloved / One-Handed / Low-Light Medic Workflow

**Objective**: does the medic-facing UI actually work under the physical conditions it's designed for, not just on a desk in good lighting.

**Setup**: tactical gloves (both a thin nitrile-equivalent and a thicker cold-weather glove, since touch-target tolerance differs), one hand only (the other simulated as occupied — holding a casualty, a radio, etc.), and both direct sunlight (screen glare) and low-light/near-dark conditions, tested as separate passes, not combined with gloves+one-hand+dark all at once initially (isolate variables first, combine only after each passes independently).

**Scenario script** (using `index.html`'s actual flows, synthetic patient data only):
1. Complete a full MSTART sweep classification (walking/breathing/perfusion/AVPU/trapped) for one synthetic casualty, one-handed, gloved.
2. Create a Quick Patient from an immediate life-saving action (tourniquet application) via the 1-tap sweep action.
3. Record a full vitals set using the stepper-based HR/RR counters (`docs/API_SURFACE_v1.2.md`'s "stepper" entry method — designed for exactly this condition; confirm it actually is faster/more reliable than an alternative under glove conditions, don't assume the design intent was achieved).
4. Log a tourniquet application including limb selection.
5. Complete a MIST handover for that patient.

**What to record**: task completion (yes/no) per step per condition, time-to-complete per step, every misclick/mistap (wrong element hit), every moment the medic had to remove a glove or use a second hand despite the constraint, and direct quotes/complaints, not just pass/fail. A step that "passes" in 45 seconds one-handed-gloved but would take 8 seconds two-handed-bare is still a finding worth recording, not a silent pass.

### Session 2: Offline and Intermittent-Connectivity Drill

**Objective**: verify the local-first sync architecture (`docs/ARCHITECTURE.md`, `docs/FAILURE_MODE_REVIEW.md`) actually behaves as designed under real network conditions, not just in a Playwright test against a controlled mock.

**Setup**: at least 2 devices on the same synthetic incident, real network connectivity toggled (airplane mode / a controlled Wi-Fi environment that can be cut), not simulated in devtools.

**Scenario script**:
1. Device A goes fully offline. Create 3-5 synthetic patients, record vitals, apply a tourniquet, all while offline — confirm the outbox accumulates correctly and the sync-freshness indicator reflects "offline," not silently showing stale "fresh" state.
2. Device A regains connectivity. Confirm the outbox actually drains (verify via the command view's device panel and the AAR timeline, not just "the app didn't crash").
3. Device B (which stayed online the whole time) confirms it eventually sees Device A's patients appear via `pullProjectedPatientState` — measure the actual latency, don't assume the documented 45-second interval holds under real conditions.
4. Deliberately create a concurrent-edit scenario matching `docs/FAILURE_MODE_REVIEW.md`'s F3 (two devices edit the same synthetic patient's triage within the same ~45-second window) and observe what actually happens on both screens — this is exactly the scenario F3 flagged as needing a product decision; a real drill run is evidence for that decision, not a substitute for it.
5. Extended-offline stress test specifically for `docs/FAILURE_MODE_REVIEW.md`'s F1 fix: keep Device A offline long enough to generate a large volume of synthetic events (approaching or exceeding the 500-entry outbox threshold) and confirm zero data loss on eventual reconnect — this is the real-world validation the Playwright reproduction couldn't fully provide (a live device under real storage/battery/OS conditions, not a headless browser).

**What to record**: exact reconnect-to-sync-visible latency (not just "it eventually worked"), any patient that didn't appear on Device B after a reasonable wait, the actual on-screen result of the concurrent-edit scenario (which edit won, was anything surfaced to either medic), and outbox entry counts before/after the extended-offline stress test.

### Session 3: Commander Stale-Data Comprehension

**Objective**: directly test `docs/FAILURE_MODE_REVIEW.md`'s F4 — does a commander under realistic attention/cognitive load actually notice the passive `.sync-pill` freshness indicator when it goes stale, or does a decision get made on dead data.

**Setup**: a commander-role participant running a synthetic command-dashboard session with enough simultaneous activity (multiple synthetic patients, active alerts, reinforcement requests) to create realistic divided attention — not a quiet, undistracted screen where a badge is easy to notice.

**Scenario script**:
1. Run a normal synthetic incident scenario for several minutes with the commander actively working (acknowledging alerts, assigning resources).
2. At an unannounced point, silently disconnect that device's network (or use Session 2's Device A offline state), letting the sync-freshness indicator go stale/offline without telling the participant.
3. Continue the scenario, introducing new synthetic patient events on *other* devices that the stale commander screen will not reflect.
4. Observe: does the commander notice the staleness indicator on their own, without being prompted? How long does it take? Do they make any decision in the interim that would have been different with current data? Ask directly afterward: "at what point did you realize your screen wasn't updating," and compare their answer to when it actually happened.

**What to record**: time-to-notice (or "never noticed within the test window"), what specifically drew their attention to it if they did notice (the badge itself, or an external cue like "that request I approved doesn't show up"), and whether any in-scenario decision was made on data that was, by that point, stale. This is the evidence `docs/FAILURE_MODE_REVIEW.md`'s F4 needs before deciding whether a more aggressive interrupt is the right fix or would just cause alert fatigue.

### Session 4: Synthetic Mass-Casualty Scenario Rehearsal

**Objective**: full end-to-end rehearsal — not a single-flow test, a realistic multi-role, multi-patient, multi-device scenario approximating a real MCI's pace and volume, to surface issues that only appear under real load and real multi-role coordination (a medic's screen changing because a `pc` acted, a logistics request colliding with an active resupply, etc.).

**Setup**: as many real roles as can be staffed (at minimum: 2+ medics, 1 `pc`, 1 `cc` or `chamal`, 1 `logistics`), a synthetic incident scenario with a realistic casualty count for whatever scale this organization actually plans for, run at a realistic pace (not slowed down for the test's convenience).

**Scenario script**: not a fixed script — this session should be scenario-driven (a synthetic MCI narrative with injects: new casualties discovered, a resource shortage, a patient deteriorating, a comms disruption) rather than a checklist, since the point is to surface emergent issues a step-by-step script wouldn't produce. Use `analytics/c5_sentinel_sar_analytics_v1_1/seed_demo_db.py`'s existing synthetic scenario as a starting template, not a from-scratch design — `seed_mci_rehearsal_scenario_v1.py` in that same package is exactly that, built to this session's minimum-staffing bar: 26 synthetic casualties across 3 sites (a primary structural-collapse building, a partial-collapse building, and a walking-wounded assembly point), 3 medics (one per site), 1 `pc`, 1 `cc`, 1 `logistics`. It includes a deteriorating red patient, an overdue tourniquet, a pediatric high-risk-medication flag, a Dead Man's Switch (one medic going silent), a dependency-blocked sync error pair, and a stock item going negative — injects to react to during the rehearsal, not to script around. Run `python seed_mci_rehearsal_scenario_v1.py` to regenerate it before a session (its timestamps are seeded relative to run time, so a stale checkout will show as fully overdue) and see that package's README for how to load it.

**What to record**: everything from Sessions 1-3 that recurs, plus anything genuinely new that only appeared under multi-role/multi-device load — this session is where `docs/FAILURE_MODE_REVIEW.md`'s F3 (concurrent edits) is most likely to occur naturally rather than being deliberately staged, and worth recording as a real occurrence, not just the staged Session 2 version.

## What Findings Feed Into

- Anything touching triage/vitals/tourniquet/dosing UX (not the doctrine values themselves — see `docs/CLINICAL_GOVERNANCE_REVIEW_FRAMEWORK.md` for that) feeds back into `docs/TACTICAL_UI_GUIDELINES.md`.
- Sync/offline findings feed into `docs/FAILURE_MODE_REVIEW.md` and `docs/PHASE_4_PLAN.md` (a real storage-durability requirement for `apps/field-mobile` if Session 2 surfaces a gap beyond what F1's fix already covers).
- Session 3's result directly resolves the open question in `docs/FAILURE_MODE_REVIEW.md`'s F4.
- Any newly-discovered failure mode from Session 4 should be added to `docs/FAILURE_MODE_REVIEW.md` as a new entry, not left only in test notes.

## Explicitly Out of Scope Here

- This plan does not itself run any test session — it's the protocol, not the results. Running it requires real participants, real devices, and real scheduling this document can't provide.
- Clinical-outcome validation (did the triage decisions made during the rehearsal match doctrine) is `docs/CLINICAL_GOVERNANCE_REVIEW_FRAMEWORK.md`'s domain, not this one's — Session 4's rehearsal will surface real triage decisions, but judging their correctness needs the qualified reviewer that framework calls for.
