# Changelog v1.2

Field experiment hardening release for the development prototype.

## Added

- Field Experiment Synthetic Scenario Mode metadata in the demo UI.
- Exportable experiment artifacts:
  - `experiment_events.csv`
  - `patients_summary.csv`
  - `aar_metrics.json`
  - `observer_notes.csv`
- Observer notes capture for controlled field testing.
- Pulse and respiratory countdown controls for 15s/30s count windows.
- Alert acknowledgment action: "Acknowledged / in treatment" without changing triage.
- Assessment-debt visibility on the commander patient list.
- Local patient edit conflict detection using `lastModifiedAt` and a conflict log.
- Offline inventory-ledger consumption events from treatment actions.
- v1.2 PostgreSQL inventory ledger/read-model and negative-stock alert contract.

## Changed

- Removed the hard Google Fonts dependency from the static demo and moved to local/system fallback stacks.
- Corrected MIST wording: the static demo now logs MIST locally instead of implying an actual QR handoff.
- Rapid AVPU now preserves more signal with `A / V / P+U` instead of only `A / not-A`.
- Rapid flow moves location immediately after the intake selector, before binary vitals.
- Tourniquet time fields validate `HHMM` ranges before accepting the time.

## Safety Notes

- Critical state changes trigger vibration when supported by the device.
- Black triage remains behind the panic double-confirm guardrail.
- Save actions remain non-blocking; missing data becomes assessment debt rather than a disabled route.
