# Tactical UI Guidelines

These guidelines capture the design intent for C5 Sentinel-SAR as a development and future-production system. The UI should support medics under pressure, not merely look polished.

## Panic-Mode Principles

- Use high contrast for every operationally important state.
- Keep touch targets large enough for stress, movement, rain, dust, and gloves.
- Prefer steppers, toggles, and large tap choices over free typing.
- Keep critical controls at least 56px by 56px. Since V2.99.56 (owner, 2026-10-22) the main field buttons (tap choices, primary and secondary actions, vitals steppers, AVPU, blood pressure) are 60-64px tall, every other field control is at least 56px, and small toggles, filters and links at least 44px; the body-map injury hotspots are about 49x44px.
- Show the current clinical clock when time changes the risk.
- Never communicate triage by color alone; pair color with text.
- A selected tap choice must be unmistakable at a glance, not a faint tint: since V2.99.59 (owner, 2026-10-22, AVPU on the MSTART card) a selected button gets a solid fill, an outer ring and a white check mark, so the choice reads without comparing colors.
- Nothing in a field screen may need sideways scrolling. The pulse and breathing count steppers (-5/-1/+1/+5) take the full row width and share it, with "ספירה:" and the multiplier on a small line above (V2.99.59): at least 56px per button on a 360px-wide phone.
- Treat stale data, missing data, and pending triage as first-class states.
- Do not block forward movement for optional or incomplete fields; save the record and surface missing data as a background alert.

## Phone Layout (owner, 2026-10-23)

Checked by `scripts/browser_mobile_layout_test.js` at 375x812 and 412x915, RTL, field mode on.

- One top nav, 60px tall: "ראשי", "מצב שטח" and an account menu ("חשבון": user management for admins, bug report, sign out), equal-size buttons with a one-line label. Nothing else floats over the top of a screen; each screen's own sticky header sits under the nav.
- Signed in, the nav shows the role and the email. "לא מקוון" (saved offline profile) comes first and is never cut short; only the email is.
- At most one floating control above a screen's bottom bar (the sweep's "+ פצוע | אותו אזור"), placed from the bar's height, and the screen reserves room for both so no content ends up under them.
- Inside a casualty card nothing is positioned out of flow and nothing is wider than the card. Below 480px the ID takes its own line and the triage banner stacks its text above its source pill. Mixed Hebrew/Latin labels ("אדום / RED") are isolated per direction.
- One red frame per card: the triage banner inside a card has no border of its own, and an unacknowledged alert pulses as a ring on the card's outline, without a blur around it.
- Missing-data chips have three tiers: red only for what changes care of a red casualty now (full or missing vitals, stale vitals, evacuation status, no reassessment), orange for a clock that is late or cannot run (stale vitals, tourniquet time or limb unknown), a neutral outline for the rest. All of them stay visible.
- No internal key (such as `stale_vitals`) is ever shown: every missing-data key has a Hebrew label in `DEBT_LABELS` (`tests/debt-labels.test.js`).

## New Patient Flow

The New Patient flow prioritizes speed and minimum safe capture.

Required early capture:

- access status
- massive bleeding / tourniquet status
- consciousness / AVPU
- pulse
- respiration
- optional SpO2
- blood pressure estimate
- initial triage

The flow should feel like tactical documentation, not a form. Each screen should answer one operational question.

The app should offer two entry paths:

- Quick Patient: 10-15 second casualty creation with location/access/triage and all other fields treated as optional debt.
- Extended Patient: full vitals, body map, interventions, and treatment detail.

Quick Patient records must create `needs_full_assessment = true` and a commander-visible incomplete-assessment alert.

Extraction status should be asked late, after vitals/triage, and should be binary:

- `trapped`: extraction team must physically free or move the casualty from the structure/vehicle/rubble.
- `not_trapped`: the casualty can be moved without a dedicated extraction task.

Avoid early `partial/full/no access` choices in the medic flow; those blur clinical access with rescue tasking and slow first registration.

Lifecycle status must be projected from events, not manually selected by the medic:

- quick patient created: `identified`
- tourniquet, medication, or airway action: `stabilizing`
- vitals recorded after immediate care: `observing`
- extraction movement: `extricating`
- `מסירת מצב רפואי לפינוי` (MIST handover) / evacuation asset scan: `handed_over`
- black triage fast exit: `deceased`

## Vitals Entry

Vitals should use counting steppers:

- pulse: count 15 seconds, multiply by 4
- respiration: count 30 seconds, multiply by 2

The UI must show the math confirmation near the control, for example:

- `20 פעימות ב-15 שניות = 80 BPM`
- `8 נשימות ב-30 שניות = 16 / דקה`

This gives the medic confidence that the app is calculating correctly.

## Pending Triage

`pending` is not `green`.

Pending means one of these:

- the patient has not been triaged yet
- the system does not have enough data to support a triage suggestion
- the patient was created through a fast capture path and still needs full assessment

Visual requirements:

- pending must use a hollow or dashed treatment
- pending must use explicit text
- pending must never share the green/minor visual treatment
- command views must surface pending patients as incomplete work

## Black Triage Fast Exit

Black/expectant triage must not force the medic through vitals, interventions, or medical handover forms.

When Black is selected:

- require a large double-confirmation target before routing to summary
- set tactical status to deceased/expectant
- clear full-assessment debt
- write a lightweight local `PATIENT_TRIAGED_EXPECTANT` event
- avoid empty vitals or treatment payloads

## Pediatric Medication Guardrail

For children under age 8, the UI must not require exact weight before treatment. Use age group or age estimate locally, warn on adult-range doses, require double confirmation, and write override metadata into the event payload. The save action still completes locally; risk is escalated through watchdog alerts and AAR review.

## Patient Detail Order (V2.99.60)

Owner request: vital signs come first. The patient detail screen ("פרטי פצוע") reads top to bottom in the order a medic needs it in the field, following the monitor convention of large color-coded numbers plus how fresh they are:

1. Safety banners (sync rejection, shared "בטיפול" acknowledgment).
2. Hero card, framed in the triage color (dashed muted frame while triage is pending, never green): triage, status, age band, "עדכן מדדים", how old the vitals are and when the next reassessment is due (red when overdue or missing), the tourniquet clock, then pulse and SpO2 gauges with large colored values, RR, BP and AVPU, and the deterioration / priority recommendation.
3. Vitals trend.
4. Elderly warning, injury and location, treatments (this device and other devices).
5. Evacuation, late MDA update, manual triage override, optional identity.
6. Timeline.

The title shows the patient number (`visualId`, e.g. P004-DK), not the internal UUID.

## Tourniquet Clock

Once a tourniquet is recorded, it becomes a persistent clinical timer.

The timer must stay visible in:

- patient card
- patient detail view
- commander row
- AAR / incident summary

The timer is not passive history. It is an active risk clock.

The phone alerts on its own clock (D1, repo owner, 2026-10-20), with or without a server connection: at 45, 60 and 120 minutes from application, once per level per tourniquet, it vibrates (where the browser supports it) and shows a banner that stays until tapped and opens the patient (`checkTourniquetTimeAlerts`, rule `tourniquetAlertToRaise` in `src/domain/rules.js`). It does not wait for the server's reassessment watchdog. Limits of a web page: iOS Safari has no vibration API, and a locked phone or a backgrounded browser pauses the page, so the alert fires when the app is opened again (only the current level, not every level missed).

Since V2.99.58 the server raises the same levels too (`database/072`, WP-12), every minute, with no phone needed, into `watchdog_alerts`, along with red/yellow vitals overdue. A phone lists a server alert only when it does not already raise the same one from its own data, and marks it "(שרת)"; it never replaces the phone's own alert or its timer.

## Logistics Resupply Queue

The resupply queue (`supply_requests`, real and cross-device — `docs/API_SURFACE_v1.2.md`'s "Logistics Resupply Queue API") is the one place a logistics officer sees a request from a medic or PC on a different device. It must stay a genuine cross-device queue, not silently fall back to the local-only demo state (`reinforcementRequests`) it replaced — the whole point of building it was that the old board only ever showed the current device's own local copy.

Status must always be legible at a glance, matching the tourniquet clock's "not passive history" principle: `requested`/`approved` (needs a dispatch decision), `dispatched` (runner + ETA assigned, in transit not yet confirmed), `in_transit`, `delivered`. A request with no runner assigned must never look the same as one that's actively moving.

Burn-rate/stockout predictions (`evaluateSupplyBurn`, surfaced on the Logistics Hub via `forLogistics()`) are recommendations, not automatic reorders — same `RECOMMENDATION_LABEL` / "Recommendation only – Human decision required" framing as every other role's decision-support panel. Never auto-dispatch a runner or auto-create a resupply request from a burn-rate prediction alone.

Kit templates (`kit_templates`/`kit_template_items`) are editable only when the incident is genuinely known to be non-active (`draft`/`staging`/`closed`) — an unknown status (not yet pulled, or offline) must be treated as locked, never as an implicit "assume it's fine to edit." This is a fail-safe default, not a UX nicety: getting it backwards would let someone reconfigure kit contents while an incident is live.

## Local-First Interaction

The medic should never wait for the network while standing over a patient.

UI expectations:

- local write first
- immediate screen transition
- visible sync freshness
- no blocking spinner for primary capture
- failed or delayed sync shown as status, not as user failure

## Production Watch Items

Before field pilots, validate:

- sunlight/high-glare readability
- low-light readability
- gloved touch accuracy
- one-handed use
- Hebrew RTL layout under stress
- degraded connectivity behavior
- stale-data comprehension by commanders
- medic trust in MSTART suggestions and override flow
