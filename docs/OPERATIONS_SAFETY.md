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

Before any real deployment conversation, the project needs (`docs/ROADMAP.md` Phase 5):

- [x] threat model — `docs/THREAT_MODEL.md`
- [~] authentication and role model review — real Supabase Auth + RLS implemented and verified (`docs/ARCHITECTURE.md`), but not yet reviewed as a standalone design document
- [x] row-level security review — systematic full-coverage audit done: `docs/RLS_AUDIT_v1.md` (86 policies across 32 tables, 21 `SECURITY DEFINER` functions, all checked against the live database, not just migration files). Four real gaps found and fixed live across this audit and the threat model that preceded it (`database/013`, `014`, `015`, `016`, `017`).
- [x] encrypted local storage design — AES-256-GCM behind a device PIN (PBKDF2-derived, never persisted); `screen-pin-gate` gates every fresh load. `docs/THREAT_MODEL.md` T2. The Supabase session token itself is a deliberately deferred follow-up.
- [x] audit log retention policy — `docs/AUDIT_AND_RETENTION_POLICY.md`. Proposal only (four retention classes, deletion-must-be-audited principle); no retention window or deletion code is implemented, and real durations need legal/records-governance input this doc doesn't invent.
- [ ] backup and incident response plan
- [x] data minimization review — `docs/PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md`
- [ ] medical/legal governance review
