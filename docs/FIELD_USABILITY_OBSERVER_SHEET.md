# Field Usability Observer Sheet

A companion to `docs/FIELD_USABILITY_TEST_PLAN.md` — one fillable recording template per session, built directly from that plan's own "What to record" lines (nothing invented here). Use this alongside the app's own in-app capture: the "📝 הערת צופה לניסוי" button on the medic dashboard (`observerNotes()`) and the AAR screen's "ייצוא סיכום" export (`exportExperimentLog()`, produces `rescue_incident_export.json` with embedded `observer_notes.csv` etc.). This sheet is the paper/parallel backup — useful when the observer's own hands are also gloved, or when a second observer is watching a screen they're not logged into.

**Synthetic data only, every session** (`docs/OPERATIONS_SAFETY.md`) — no real names, no real locations, no real casualties.

---

## Session Header (fill once per session)

| Field | Value |
|---|---|
| Session # (1-4) | |
| Date | |
| Location | |
| Observer name | |
| Participant(s) / role(s) | |
| Device(s) + OS | |
| App version (`APP_VERSION` shown on screen) | |
| Scenario used | |
| Start time | |
| End time | |

---

## Session 1: Gloved / One-Handed / Low-Light Medic Workflow

Run conditions as **separate passes first** (glove type × one-handed × light), combine only after each passes independently. Copy this step table once per condition pass.

**Condition this pass**: Glove type: ☐ thin nitrile ☐ thick cold-weather — Hand: ☐ one-handed (other simulated occupied) — Light: ☐ direct sunlight ☐ low-light/near-dark — ☐ combined pass

| # | Step | Completed? (Y/N) | Time to complete | Misclicks / mistaps (count + what was hit) | Glove removed / 2nd hand used? |
|---|---|---|---|---|---|
| 1 | Full MSTART sweep (walking/breathing/perfusion/AVPU/trapped) for one synthetic casualty | | | | |
| 2 | Quick Patient via 1-tap immediate life-saving action (tourniquet) | | | | |
| 3 | Full vitals set via stepper HR/RR counters | | | | |
| 4 | Tourniquet application incl. limb selection | | | | |
| 5 | MIST handover for that patient | | | | |

**Direct quotes / complaints** (verbatim, not paraphrased):

```



```

**Note**: in this app's current build, steps 2 and 4 collapse into a single tap when a tourniquet-limb button is used directly from the sweep screen (confirmed live 2026-08-26) — record whether that matched what the participant expected, or whether they looked for a separate "apply tourniquet" action instead.

---

## Session 2: Offline and Intermittent-Connectivity Drill

| Item | Value |
|---|---|
| Reconnect → sync-visible latency (exact, not "eventually worked") | |
| Any patient missing on Device B after a reasonable wait? Which one? | |
| Concurrent-edit scenario (F3): which edit won? | |
| Was the losing edit surfaced to either medic? How? | |
| Outbox entry count — before extended-offline stress test | |
| Outbox entry count — after reconnect | |
| Any data loss on reconnect? | |

**Narrative notes**:

```



```

---

## Session 3: Commander Stale-Data Comprehension

| Item | Value |
|---|---|
| Time device went stale/offline (observer's clock, not disclosed to participant) | |
| Time-to-notice (or "never noticed within test window") | |
| What drew their attention? ☐ the sync-pill badge itself ☐ an external cue (specify) ☐ prompted by observer | |
| Any in-scenario decision made on data that was, by then, stale? What decision? | |
| Participant's own answer to "when did you realize your screen wasn't updating?" | |
| Gap between their answer and the actual time (from row 1) | |

**Narrative notes**:

```



```

---

## Session 4: Synthetic Mass-Casualty Scenario Rehearsal

Not a fixed script — log injects and emergent issues as they happen.

| Time | Inject / event | What happened | Role(s) affected | New finding (Y/N) — if Y, cross-ref Session 1-3 field or note as new |
|---|---|---|---|---|
| | | | | |
| | | | | |
| | | | | |

**Recurrence check** — did any Session 1-3 finding reappear naturally here (not staged)?

```



```

---

## After the Session

1. Any note logged via the in-app "📝 הערת צופה לניסוי" button is already timestamped and tied to `device_id`/`phase` — no transcription needed for those.
2. Transcribe this paper sheet's findings into the in-app observer note panel (or directly into the relevant doc below) before the paper copy is set aside.
3. Route findings per `docs/FIELD_USABILITY_TEST_PLAN.md`'s "What Findings Feed Into":
   - Triage/vitals/tourniquet/dosing UX → `docs/TACTICAL_UI_GUIDELINES.md`
   - Sync/offline findings → `docs/FAILURE_MODE_REVIEW.md` / `docs/PHASE_4_PLAN.md`
   - Session 3 result → directly resolves `docs/FAILURE_MODE_REVIEW.md`'s F4 open question
   - Any new Session 4 failure mode → new entry in `docs/FAILURE_MODE_REVIEW.md`, not left only in these notes
