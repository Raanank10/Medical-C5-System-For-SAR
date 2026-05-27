# Changelog V2.4

Demo V2.4 reshapes the product around the tactical timeline of a collapsed-building MCI.

## Medic Workflow

- Added optional ETA to the en-route screen.
- Added current zone context so new casualties inherit `Site -> Zone -> Patient`.
- Split medic work into MSTART sprint and monitoring/treatment hold.
- Changed the primary action from generic new patient creation to `MSTART — סריקה מהירה` and `פצוע נוסף באזור הזה`.
- Life-saving actions inside the rapid triage screen no longer close the patient; they remain part of the binary MSTART capture.
- A/V/P selection now implies the casualty is breathing unless no-breathing was explicitly selected.

## Monitoring

- Added automatic priority sorting for patient boards.
- Added a tile-level deterioration index using simple trend indicators.
- Full vitals remain in the monitoring/treatment phase.
- Blood pressure was returned to field palpation logic: radial above 80, carotid 60-80, absent below 60, with strong/weak quality.

## Command Picture

- En-route site data is treated as command-visible context for חוג"ד, חמ"ל, and מ״פ רפואה.
- Initial evacuated counts remain editable later.
- Added a demo button to clear patient data while keeping the board/site context.
- Added a stale-vitals reminder action from command to medic.
- Added a one-tap radio SITREP generator.

## Handover

- Reworded the handover as `מסירת מצב רפואי לפינוי`.
- Added a short explanation under MIST.
- Added Web Speech readout for the MIST handover text where supported.
- Added one-tap `הועבר למד״א — עכשיו`, which timestamps handover, logs `PATIENT_HANDED_TO_MDA`, and removes the patient from the active board.

## Death Certification

- A second black casualty at the same site escalates doctor death-certification urgency and surfaces the request to company command.
