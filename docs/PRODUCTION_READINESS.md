# Production Readiness Path

C5 Sentinel-SAR is still a development prototype. This document names the gap between the current repo and any future production or pilot-ready system.

## Current Position

The repo currently contains:

- standalone HTML prototype
- shared domain-rule module
- SQL schema draft
- sync/API specification
- analytics/AAR package
- synthetic demo data
- development docs and validation checks

This is enough for workflow validation and engineering iteration. It is not enough for operational deployment.

## Required Before Production

### Engineering

- Split prototype into app/service packages.
- Add automated browser tests for New Patient, command dashboard, and AAR flows.
- Add unit tests for all domain rules.
- Add executable database migrations.
- Implement real local persistence.
- Implement sync push/pull with conflict and poison-event handling.
- Enforce idempotent sync by `device_id + local_event_id` at the database layer.
- Preserve dependency-aware sync ordering for offline batches such as Quick Patient followed by MIST handover.
- Implement `מסירה רפואית למד״א / כוח פינוי` handover with `PATIENT_HANDED_OVER` events and temporary signed QR tokens; explain MIST/ATMIST as mechanism, injuries, signs, and treatment.
- Implement Black triage fast exit with `PATIENT_TRIAGED_EXPECTANT` and no empty vitals/treatment payloads.
- Drive `patients.current_status` from event projections rather than manual status dropdowns.
- Ensure handover projection resolves patient-specific watchdog alerts and closes Quick Patient assessment debt.
- Keep Chamal/command dashboards on `incident_command_state`, refreshed by lifecycle events instead of live event-log joins.
- Add structured logging and audit traces.

### Security and Privacy

- Authentication and authorization model.
- Row-level access control.
- Encrypted local storage.
- Secret management.
- Audit retention policy.
- Data minimization review.
- Incident response plan.

### Clinical and Operational Governance

- Doctrine review for triage and reassessment thresholds.
- Review of tourniquet timing rules.
- Review of pediatric triage behavior.
- Human override requirements.
- Training materials.
- Failure-mode review.
- Approval boundaries for any pilot.

### Field Validation

- Gloved touch testing.
- Low-light and sunlight testing.
- One-handed workflow testing.
- Offline and intermittent-connectivity drills.
- Commander stale-data comprehension testing.
- Synthetic mass-casualty scenario rehearsals.

### Handover and Command Performance Guardrails

- A handover is complete only after a local `PATIENT_HANDED_OVER` event exists.
- A Black/expectant classification is complete after a local `PATIENT_TRIAGED_EXPECTANT` event exists.
- QR handover links must use temporary encrypted tokens and signatures; do not embed clinical files in the QR.
- Receiving units on other platforms consume the token through a backend endpoint.
- Duplicate handover packets must be treated as duplicate sync, not repeated status mutations.
- Open tourniquet/vitals reassessment alerts for a handed-over patient must be resolved with `resolved_by_event_id`.
- Command dashboard refresh should poll the precomputed state endpoint at a fixed interval, for example every 5 seconds.
- Throughput analytics should use the precomputed/state pipeline and `vw_command_incident_throughput_funnel`.

### v1.2 Field Experiment Guardrails

- Demo handover language must not imply a real QR transfer unless an actual scan target is generated and tested.
- Vitals count windows must support timer-guided 15s/30s counting for gloved, one-handed use.
- Alert acknowledgment is required so commanders can distinguish "unseen" from "seen and being handled."
- Field experiment runs must export `experiment_events.csv`, `patients_summary.csv`, `aar_metrics.json`, and `observer_notes.csv`.
- Static demos may use localStorage, but the UI must surface edit conflicts and assessment debt instead of pretending the data is complete.
- Logistics must use an append-only inventory ledger; negative stock is accepted and escalated, never blocked.

## Development Priority

The next production-aligned build work should happen in this order:

1. Keep the standalone demo stable.
2. Move clinical and operational rules into `src/domain/`.
3. Test those rules without a browser.
4. Add browser smoke tests for the core flows.
5. Add local event persistence.
6. Use the event log as the source for UI state and AAR analytics.
7. Split apps and services only after the workflow stabilizes.
