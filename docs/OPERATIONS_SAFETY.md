# Operations and Safety Notes

C5 Sentinel-SAR is a development prototype. It is not a clinical decision system, not a certified medical device, and not approved for operational deployment.

## Non-Negotiables

- Do not use real patient-identifiable data.
- Do not use the prototype as the system of record in a real incident.
- Do not imply clinical authority beyond documented doctrine and human command.
- Do not remove audit history to make a workflow look cleaner.
- Do not hide stale data, sync failure, or missing-vitals states.

## Data Policy for This Repository

All data committed to this repo must be synthetic.

Avoid:

- real names
- real ID numbers
- real phone numbers
- real operational locations
- real unit rosters
- real medical records
- images that expose real patients or teams

Use:

- synthetic patients
- fictional sites
- generated timestamps
- simulated device IDs
- abstract operational labels

## Clinical Safety Framing

The prototype may support documentation and visibility, but it must not replace:

- medic judgment
- commander judgment
- medical doctrine
- evacuation policy
- organizational approval
- clinical governance

## Development Review Triggers

Require extra review before merging changes that affect:

- triage color assignment
- pediatric triage logic
- tourniquet timing
- vitals reassessment intervals
- handover status
- patient status transitions
- inventory criticality thresholds
- dead-man/device-silence thresholds
- sync conflict resolution
- audit/event retention

## Security and Privacy Direction

Before any real deployment conversation, the project needs:

- threat model
- authentication and role model review
- row-level security review
- encrypted local storage design
- audit log retention policy
- backup and incident response plan
- data minimization review
- medical/legal governance review
