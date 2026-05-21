# Changelog v2.0

v2.0 moves the demo from a shared dashboard to a role-based medical command system.

## Added

- Role command home for:
  - Medic,
  - Medical PC,
  - Medical CC,
  - Doctor / Paramedic,
  - Logistics Officer,
  - Chamal / Operator,
  - Admin / Demo Controller.
- Role dashboards now show:
  - top situation summary,
  - responsibilities,
  - alerts requiring action,
  - owned objects,
  - requests/assignments,
  - allowed actions.
- Synthetic real-name model for users and patients.
- Patient identity status: confirmed, reported, or unknown.
- Patient assignment fields:
  - assigned medic,
  - assigned platoon.
- Same-platoon reassignment event: `PATIENT_REASSIGNED_WITHIN_PLATOON`.
- Cross-platoon reassignment event: `PATIENT_REASSIGNED_BETWEEN_PLATOONS`.
- Automatic non-emergency doctor death-certification request after black/not-salvageable patient save.
- Dedicated request type: `רופא — קביעת מוות / אישור מוות`.
- v2.0 role-command model documentation.

## Changed

- Demo launcher now starts from role selection, not dashboard filtering.
- Request taxonomy now separates:
  - doctor for treatment/senior decision,
  - doctor for death certification,
  - urgent/routine/coordination evacuation,
  - equipment-specific requests.
- Removed `צוות אלונקה` as a request type.
- Black triage confirmation text now says the medic is not officially declaring death.
- Experiment export includes patient identity and assignment fields.

## Release Intent

This release is for the next product/demo discussion. It is still synthetic and not operational software.
