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
- One control per action on a screen (owner, 2026-10-23): the sweep screen's only "add casualty" control is that floating button. It is always up on the sweep screen, for whoever runs the sweep (a חוג״ד can too), and never shown on any other screen.
- Inside a casualty card nothing is positioned out of flow and nothing is wider than the card. Below 480px the ID takes its own line and the triage banner stacks its text above its source pill. Mixed Hebrew/Latin labels ("אדום / RED") are isolated per direction.
- One red frame per card: the triage banner inside a card has no border of its own, and an unacknowledged alert pulses as a ring on the card's outline, without a blur around it.
- Critical chips are solid white with dark-red text and a "!", overdue chips have a "⏱" (owner, 2026-10-23): a red chip on a red card measured 3.6-4.6:1 and looked almost the same as an orange one. The icons also keep the tier from being shown by colour alone.
- Missing-data chips have three tiers: red only for what changes care of a red casualty now (no measured vitals, stale vitals, evacuation status, no reassessment, tourniquet time unknown), orange for a clock that is late or cannot run (stale vitals, tourniquet time or limb unknown, on any casualty that is not red), a neutral outline for the rest. All of them stay visible.
- "No vitals" is one key, `missing_vitals` ("אין מדדים מלאים", owner 2026-10-23): it clears only once all five vital signs were measured, on any phone: an exactly counted pulse and breathing rate (a range button is not enough), SpO₂ or "אין מד סטורציה", AVPU, and blood pressure / perfusion. AVPU and perfusion the medic answered in MSTART count as observed; answers inferred from walking do not. The server's `last_vitals_at` alone does not clear it. The server follows the same rule since `database/073` (live 2026-10-23): `needs_full_assessment` clears only once the casualty's vitals events together hold all five, and a casualty created through the full flow no longer counts as assessed before any vitals. It replaces `full_vitals`, which no code ever cleared, and `missing_treatment` is no longer shown (it flagged every casualty who needed no treatment).
- Nothing nobody measured is recorded or shown as measured (owner, 2026-10-23). MSTART "breathing yes" leaves the breathing rate empty; the quick flow invents no rate from breathing or AVPU and no pulse rate from a pulse location. SpO₂, once switched on, starts at 98 only as a starting point and records nothing until changed or its number is tapped to confirm; "אין מד סטורציה" records that no oximeter was available. The range buttons on the patient flow's vitals screen ("10-30", "60-100", ...) record the range itself, never a stand-in number (16, 80); triage uses the range's band, and an exact count replaces it. A vitals counter (vitals sheet and patient flow) starts at 20 / 15 s or 8 / 30 s only as a starting point: it shows "לא נספר" and records nothing until the medic changes it, picks a bracket, or taps the number to confirm. A vitals sheet saved with nothing counted or chosen is refused, and a patient flow with nothing measured sends no `VITALS_RECORDED`, because either would restart the reassessment clock and tell the server vitals were taken. A breathing rate that was not counted never triggers a "deterioration" recommendation by itself. The patient screen and MIST say "נושם — לא נספר" and tag values taken from MSTART ("(MSTART)") or inferred from walking ("(נגזר מהליכה)"); the vitals sheet does not pre-select an AVPU or perfusion inferred from walking.
- The patient screen's bar shows only "עדכן מדדים" and "יצא לנקודת פינוי", then "הגיע לנקודת פינוי" while the casualty is on the way (WP-18), then handover once the casualty is at the evacuation point, with the rest under "עוד". Every screen with a bottom bar leaves room equal to the bar's measured height, so nothing at the end of a page stays under it.
- A recorded tourniquet's limb can be corrected, or an entry recorded by mistake cancelled, from the patient screen as well as from the sweep card. Cancelling asks first, because it stops that tourniquet's 45/60/120-minute alerts. Only roles that may write clinical events get these controls.
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

Extended Patient's treatment step is ordered by MARCH-PAWS (V2.99.62): M massive hemorrhage, A airway, R respiration, C circulation, H hypothermia / head injury, then P pain, A antibiotics, W wounds, S splinting. Each letter shows "טופל" (a treatment in it, or for M the step 3 immediate tourniquet), "נבדק - ללא טיפול" (the medic marked it checked) or "לא תועד". It is documentation only: no letter blocks saving, changes triage or raises an alert, and undocumented letters are shown as such on the summary, never hidden. Choosing a treatment withdraws that letter's "no treatment needed"; "no treatment needed" cannot be set on a letter that has a treatment. Each treatment is sent as its own event (A's as `AIRWAY_MANAGED`, the rest as `INTERVENTION_RECORDED`, tourniquets and pain medications on their existing events) with `march_section`, and the create event carries `march_review`. TXA and antibiotics are recorded as given, without a dose: MARCH-PAWS adds no drug-dose calculation (owner 2026-10-23). The existing morphine and Actiq (fentanyl) handling is kept unchanged (owner 2026-10-24): the medic sets the morphine dose (default 5 mg; 0.5 mg steps for a child), Actiq is a fixed 100 mcg, and for a child the app estimates weight from age (age x 2 + 8 kg, at least 4 kg), shows and pre-fills the suggested pediatric dose, and asks for a double confirmation above it (see the pediatric dosing rule below). New treatments do not change patient status (owner 2026-10-23). Cric and needle decompression can be recorded only by a paramedic or a physician (owner 2026-10-23): for any other role the buttons are dimmed, marked "פרמדיק / רופא", and a tap is refused with a toast. The server enforces it too (owner 2026-10-23): `sync-log` refuses such an event from any other role with `FORBIDDEN_ACTOR_ROLE` (the phone shows a sync rejection), and `events_insert_by_role` refuses a direct insert (`database/075`).

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

## Patient Detail Order (V2.99.65)

Owner request: vital signs come first. The patient detail screen ("פרטי פצוע") reads top to bottom in the order a medic needs it in the field, following the monitor convention of large color-coded numbers plus how fresh they are:

1. Safety banners (sync rejection, shared "בטיפול" acknowledgment).
2. Hero card, framed in the triage color (dashed muted frame while triage is pending, never green): triage, status, age band, "עדכן מדדים", how old the vitals are and when the next reassessment is due (red when overdue or missing), the tourniquet clock, then pulse and SpO2 gauges with large colored values, RR, BP and AVPU, and the deterioration / priority recommendation.
3. Active tourniquets with the limb / record correction (when any), then the vitals trend.
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

The rescue chain (מ״מ, מ״פ חילוץ) does not see it (owner, 2026-10-23, `database/074`): tourniquet status is clinical. A patient with an active tourniquet still shows to them as **urgent** and comes first in their evacuation order, from the same ranking medical command uses.

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

Sync freshness means the last answer from the server, not the last local save (V2.99.62). Signed in, every sync pill and the command strip show it: under 2 minutes "מחובר לשרת" (green), up to 5 minutes "עדכון אחרון מהשרת" (orange), beyond that, with no network or with no answer yet "אין קשר לשרת" (red), plus the number of events still waiting to be sent. The limits live in `serverContactFreshness` in `src/domain/rules.js`. Local demo mode says "מצב דמו · ללא שרת" and never claims a connection.

## PC / CC Command Panel

Since V2.99.62 the PC (חוג"ד) and CC (מ״פ רפואה) panels are a sticky status strip above four tabs instead of one long scroll.

- Tabs, right to left: תמונת מצב, פעולה, כוחות, ציוד. Tap only, no swipe. Entering the panel always opens תמונת מצב; automatic re-renders (sync, acknowledgements) keep the tab the commander is on.
- תמונת מצב: per site, how many patients by triage colour (red, yellow, green, black, trapped), split into stages that must never be merged: still at the extraction site, on the way to the site's evacuation point (נקודת פינוי), at the evacuation point waiting for an MDA ambulance (with minutes since arrival and the longest wait; shown, not alerted on, until the owner sets a threshold), and evacuated by MDA / handed over (WP-18). A patient sent to the evacuation point counts as "on the way" until a medic, paramedic, physician or PC records the arrival; never shown as arrived without one. The company's own ambulance carries the doctor between the company's sites and is not a patient evacuation resource. The evacuation point is where the PC truck stands; the PC's own site shows the truck stock there. Then the evacuation funnel and the evacuation priority list (platoon for PC, company for CC), which is the evacuation-to-hospital list: it keeps patients at the evacuation point (marked "בנקודת פינוי" with the wait) or on the way to it ("בדרך לנקודת פינוי") until MDA takes them, next to ranked patients still at the extraction site ("באתר החילוץ").
- "Evacuation not closed" counts on the command panels (CC metrics, the bottleneck card and suggestion, the company resource row, the evacuation bottleneck recommendation) count red/yellow patients until MDA takes them, split into two parts: still at the extraction site, and waiting for MDA at the evacuation point (owner, 2026-10-23). A patient at the evacuation point is never counted as evacuated, and the sector risk score and the operational pressure gauge count them the same way.
- Evacuation advice follows where patients wait (owner, 2026-10-24). At the evacuation point the shortage is civilian ambulances: any red waiting, or two or more patients, raises "ask for more civilian ambulances" for both PC and CC (both can ask). At the extraction site the rescuers carry patients to the evacuation point and medical staff treat them there, trapped patients included; CC can send more medics or the physician's ambulance. The evacuation list's hint for a trapped patient is "treat before extraction, waiting for extraction", for a free one "the rescuers move them to the evacuation point; short of civilian ambulances? ask for more". The app never tells a commander to assign an ambulance: the company ambulance only carries the doctor between sites.
- CC's תמונת מצב opens with one table of every open incident: a row per incident, columns red / yellow / green / black / pending / total, and a total row (owner, 2026-10-25). Signed in, other incidents come from one read of their patients (the CC may read every open incident), refreshed with the incident list every 45 seconds and marked with its age; the CC's own incident is counted from the phone so unsent patients are not missed. Every registered patient counts, evacuated ones included.
- The strip, on every tab: server contact, the longest active tourniquet timer, unresolved blocked events (tap opens the full command screen's blocked-events panel), triage totals, and the alerts.
- No alert may be visible only inside a tab. Every alert routed to the role (the alert pipeline, including server watchdog alerts) is in the strip, one line per patient, coloured by its most severe alert, most severe first. Collapsed, the strip shows the top line and "+N התראות"; tapping opens the rest inside the strip.
- Tab badges count patients (a site-level alert counts once), from the same alert list; the UI only maps alert types to tabs and adds no rule logic.
- The full command screen (חפ״ק) is reached from the "מסך בקרה מלא (חפ״ק)" button at the bottom of כוחות.
- MARCH is not on the command panels: it belongs to the medic's and, when going hands-on, the PC's patient flow (backlog B2 in `GAP_CLOSURE_PLAN.md`).

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
