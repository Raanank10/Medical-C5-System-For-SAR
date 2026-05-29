# Changelog V2.6

Demo V2.6 turns RESCUE further away from a patient-chart form and toward a field notebook replacement: medic work is sweep-first, command sees sweep debt and resource bottlenecks, and the UI uses stronger tactical contrast.

## V2.6 Medic-First Field Flow

- The medic operational center is reduced to three areas: `סריקה`, `הפצועים שלי`, and `מוקד / אזור`.
- Added a persistent medic context line showing site, zone, sweep status, medic name, and local sync/outbox state.
- The MSTART sweep remains separate from monitoring: no full vitals, no identity fields, no evacuation destination, and no injury map during the first pass.
- Sweep completion now reports immobile casualties, unknown identity count, missing full vitals, and elapsed time from arrival to sweep completion.
- Legacy wording such as `טיפול מיידי`, `פצוע חדש`, and `שמור מדדים` was cleaned up so the primary story is scan, mark, treat, and monitor.

## V2.6 Tactical UI

- Patient cards now use thicker high-contrast triage borders/backgrounds: red, yellow, green, and black are obvious at a glance.
- Field mode keeps larger controls and stronger contrast for sunlight, darkness, gloves, and one-handed use.
- The sweep screen empty state reinforces the rule: no name, ID, or full vitals are required during MSTART.

## V2.6 חוג"ד And מ״פ רפואה Boards

- Added a חוג"ד assessment-debt board: missing full vitals, unknown identity, unknown trapped status, missing evacuation status, tourniquet limb missing, and no reassessment.
- Strengthened the MSTART sweep board with active/completed zone summaries, airway count, immobile count, unknown identity count, and direct action buttons.
- Renamed the company center to `תמונת משאבים פלוגתית` and added explicit cross-platoon recommendations for overloaded platoons, delayed paramedic requests, and post-sweep monitoring gaps.

## Carried Forward From V2.5 Action-First Sweep

- Reordered the MSTART casualty card so life-saving procedures are first, followed by walking, breathing, pulse/perfusion, AVPU, trapped/mobility, suggested color, override/note, and next casualty.
- Selecting `הולך` now auto-fills breathing yes, radial strong pulse, AVPU A, not trapped, and green MSTART with visible auto-fill chips.
- Contradictory inputs clear walking/green and show warnings for no breathing, AVPU V/P/U, abnormal pulse, or trapped/immobile status.
- Breathing-no now prompts airway opening, breathing recheck, and suspected-not-salvageable confirmation without calling it official death.
- Tourniquet capture now asks limb quickly and records missing limb as assessment debt when unknown.

## Carried Forward From V2.5 Supply UX

- Every supply-consuming treatment opens a fast `ציוד נצרך` bottom sheet with item, casualty, medic kit remaining, PC truck stock, and correction/resupply buttons.
- Cancelling or changing supply quantity creates correction events without blocking treatment.
- Supply use is now included in patient timeline/AAR, in addition to the append-only outbox.

## Carried Forward From V2.5 Field Mode And AAR

- Added `מצב שטח` toggle for larger buttons, stronger contrast, and thumb-friendly primary actions.
- Added patient-board filters for red, trapped, tourniquet, airway, no full vitals, stale vitals, unknown identity, low supplies, and current zone.
- AAR now surfaces supply consumption, resupply delay, sweep completion, first tourniquet, first airway, and unresolved assessment debt.

## Medic Workflow

- Added optional ETA to the en-route screen.
- Added current zone context so new casualties inherit `Site -> Zone -> Patient`.
- Split medic work into MSTART sprint and monitoring/treatment hold.
- Added a dedicated `סריקת MSTART` screen instead of routing the medic into a generic patient form.
- Added temporary casualty markers (`TMP-*`) with `phase: mstart_sweep`, unknown identity, inherited zone, and explicit assessment debt.
- Changed the primary action from generic new patient creation to `MSTART — סריקה מהירה` and `פצוע נוסף באזור הזה`.
- Life-saving actions inside the rapid triage screen no longer close the patient; they remain part of the binary MSTART capture.
- A/V/P selection now implies the casualty is breathing unless no-breathing was explicitly selected.
- Added `סיימתי סריקת MSTART באזור הזה`, creating a sweep-completed event and moving the medic to monitoring.

## Monitoring

- Added automatic priority sorting for patient boards.
- Added a tile-level deterioration index using simple trend indicators.
- Full vitals remain in the monitoring/treatment phase.
- Blood pressure was returned to field palpation logic: radial above 80, carotid 60-80, absent below 60, with strong/weak quality.

## Command Picture

- En-route site data is treated as command-visible context for חוג"ד, חמ"ל, and מ״פ רפואה.
- Initial evacuated counts remain editable later.
- Added חוג"ד board section for active/completed MSTART sweeps, severity counts, trapped count, tourniquets, airway interventions, and missing full vitals.
- Added a truck-first logistics model: medic supply use creates `SUPPLY_CONSUMED` events, חוג"ד sees whether the request is available in the truck, and shortages escalate to מ״פ רפואה / logistics.
- Added a medic-only `חסר לי ציוד` sheet instead of a logistics dashboard, plus low/empty stock warning chips that never block treatment.
- Added PC truck stock, resupply statuses, and חוג"ד actions for approving from truck, sending, marking collected/delivered, or escalating unavailable stock.
- Added מ״פ רפואה visibility for truck shortages, escalated equipment requests, and shortage impact on active red/yellow treatment.
- Added a demo button to clear patient data while keeping the board/site context.
- Added a stale-vitals reminder action from command to medic.
- Added a one-tap radio SITREP generator.

## Monitoring Language

- Post-triage vitals no longer silently re-run MSTART.
- Deterioration now creates `DETERIORATION_PRIORITY_RECOMMENDED` and asks the medic/PC to update priority, keep priority, request חוג"ד review, or request paramedic/doctor support.

## Handover

- Reworded the handover as `מסירת מצב רפואי לפינוי`.
- Added a short explanation under MIST.
- Added Web Speech readout for the MIST handover text where supported.
- Added one-tap `הועבר למד״א — עכשיו`, which timestamps handover, logs `PATIENT_HANDED_TO_MDA`, and removes the patient from the active board.

## Death Certification

- A second black casualty at the same site escalates doctor death-certification urgency and surfaces the request to company command.
