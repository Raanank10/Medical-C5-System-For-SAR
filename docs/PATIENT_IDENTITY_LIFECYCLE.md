# Patient Identity Lifecycle

This is a concrete implementation of `docs/ROADMAP.md`'s "data minimization review" Phase 5 item, and extends `docs/AUDIT_RETENTION_POLICY.md`'s permanent-vs-prunable split down to the *field* level within a single patient record.

## The operational need

During a mass-casualty incident, command needs to reconcile a maximum-possible-trapped estimate (building occupancy, witness reports) down against who has actually been found, treated, and evacuated — a standard SAR missing-persons-reconciliation workflow. That requires a patient's name (or, more often, a free-text "identifying marks/clothing" description for someone who can't state their name) to be logged and **visible to other devices and roles during the incident** — not just cached on the originating medic's phone.

Once the incident's AAR is finalized, that identity data no longer serves an operational purpose and should be deleted. The clinical record — triage, vitals, treatments, and even "evacuated to Hospital X at 14:32" — is not personally identifying on its own once it's no longer tied to a name, and stays permanently, same as every other clinical audit record in this system.

**Identity capture is always optional, with no exception.** In a mass-casualty incident there is often no time to identify every patient. Nothing about creating, triaging, treating, or handing off a patient may ever require a name or description — both new fields are nullable, have no default requirement, and are never validated as required anywhere in the client.

## Why identity bypasses the event log

This system's entire write model is event-sourced: every clinical change is an immutable `events` row (`prevent_event_mutation()` blocks all UPDATE/DELETE, no exceptions), and `patients` is just a projection of that log. Confirmed by direct trace before building this: **no event type anywhere carries a real name or identity field today**, and `patients.optional_name` — the one identity-shaped column that already existed — was completely unused by any event type or client code.

Two designs were considered for identity: route it through an event too (consistent with everything else, but requires carving an exception into the event log's currently-absolute immutability), or give it its own direct write path that never touches `events` at all (keeps that guarantee at 100%, but is a deliberate departure from "everything is an event"). **The second was chosen** — identity is written directly to `patients.optional_name`/`patients.identifying_description` via `update_patient_identity()`, a `SECURITY DEFINER` RPC, and cleared the same way by `finalize_incident_aar()`. Neither function's write path ever passes through `events`.

## What gets deleted, and what doesn't

`finalize_incident_aar(incident_id)` (command roles only — `app.is_command_role()`, enforced server-side, not just in the UI):
1. Sets `incidents.aar_finalized_at`/`aar_finalized_by`.
2. Nulls `patients.optional_name` and `patients.identifying_description` for every patient in the incident.

Everything else on the patient record — `current_triage`, `last_vitals_at`, `handed_over_to`, tourniquet history, the full `events` timeline — is untouched. Verified live this session: a real transaction updated two patients' clinical fields (triage, vitals timestamp, handover destination) alongside their identity, ran `finalize_incident_aar()`, and confirmed identity was null while every clinical field survived unchanged.

## Two leaks fixed as part of connecting this

Found by direct trace of `index.html` before this work: neither is hypothetical, both existed in the shipped app.

1. `reassignPatient()` baked a patient's full display name (`displayPatientIdentity(p)`) as free text into the `detail` string of a `PATIENT_REASSIGNED_*` event — a permanent, immutable record. Fixed to reference the patient by `visualId`/tag only.
2. `exportExperimentLog()` (a local debug/observer-log export, not an official handover artifact) included `full_name`/`identity_status`/`temporary_description` in its output, ungated. Fixed by excluding identity fields from the export entirely — the export doesn't need identity to serve its purpose.

Connecting identity to a system that still had these leaks would have defeated the purge, so both were fixed first.

## How it works end to end

- **Capture**: an always-optional "זיהוי (אופציונלי)" section on the patient detail screen (`openPatient()`) — name and identifying description, pre-filled from whatever's already known, saved via `savePatientIdentity()`.
- **Sync**: `savePatientIdentity()` calls `update_patient_identity()` via Supabase RPC, but only when `currentUser` is set (logged in) — matching the same guard every other sync path in this app already uses (`syncPush()`, etc.). In local-demo (no-login) mode, identity simply stays local, already protected by this session's earlier PIN-encryption work. No retry queue: identity is low-frequency and not on the critical clinical path, so a failed sync just waits for the medic to reopen and resave.
- **Sharing across devices**: `optional_name`/`identifying_description` were added to `PROJECTED_PATIENT_COLUMNS`, so they ride the existing pull-projection mechanism (`pullProjectedPatientState`/`applyProjectedPatientState`) that already merges triage/status/vitals down from the server — no new sync mechanism was built. A `null` from the server (never identified, or already purged) correctly overwrites any locally-cached name, so a purge on one device propagates to every other device on the next pull rather than leaving a stale local copy behind.
- **Purge trigger**: a command-role "סיים AAR ומחק זיהוי" (finalize AAR and delete identity) button on the AAR screen, behind a `confirm()` dialog stating plainly what will and won't be deleted — same pattern as the existing local-storage-reset escape hatch. Local `patients[]` copies are cleared immediately on success, not left to wait for the next pull cycle.

## Explicitly not a legal clearance

This is engineered for privacy — minimize what's collected, share it only with people who need it, delete it once its purpose is served — but **it has not been reviewed by anyone qualified to say it satisfies Israeli law.** Medical data about identifiable people is "sensitive information" (מידע רגיש) under Israel's Protection of Privacy Law 5741-1981, with stricter handling requirements than ordinary personal data. Real deployment needs review by qualified Israeli privacy/health-data counsel and likely Ministry of Health sign-off — this is `docs/OPERATIONS_SAFETY.md`'s still-open "medical/legal governance review" item, and this document does not close it. The whole project remains documented as a prototype not approved for operational deployment.
