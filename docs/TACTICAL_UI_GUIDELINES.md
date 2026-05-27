# Tactical UI Guidelines

These guidelines capture the design intent for C5 Sentinel-SAR as a development and future-production system. The UI should support medics under pressure, not merely look polished.

## Panic-Mode Principles

- Use high contrast for every operationally important state.
- Keep touch targets large enough for stress, movement, rain, dust, and gloves.
- Prefer steppers, toggles, and large tap choices over free typing.
- Keep critical controls at least 56px by 56px.
- Show the current clinical clock when time changes the risk.
- Never communicate triage by color alone; pair color with text.
- Treat stale data, missing data, and pending triage as first-class states.
- Do not block forward movement for optional or incomplete fields; save the record and surface missing data as a background alert.

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

## Tourniquet Clock

Once a tourniquet is recorded, it becomes a persistent clinical timer.

The timer must stay visible in:

- patient card
- patient detail view
- commander row
- AAR / incident summary

The timer is not passive history. It is an active risk clock.

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
