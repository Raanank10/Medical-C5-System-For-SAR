# Audit and Retention Policy

`docs/ROADMAP.md` Phase 5 deliverable. Proposes retention windows and audit-trail guarantees for the live schema's data — currently, nothing in this system deletes or archives anything. Every table grows forever. This is a proposal to review and adopt, not something already implemented; adopting it is real engineering work (scheduled jobs, archival storage, deletion logic with its own audit trail) that hasn't been scoped or built.

## Current State

No retention policy exists today. Confirmed by inspection: no scheduled jobs, no TTL/expiry columns except the narrow, purpose-specific ones already in the schema (`patients.handover_token_expires_at`, `patient_handover_tokens.expires_at` — token expiry, not data retention), and no deletion code paths anywhere in `index.html`, the `sync-log` Edge Function, or the SQL migrations. Every row ever written stays forever.

## Principle

Retention should be driven by *why the data exists*, not a single blanket window. This system has at least three genuinely different categories, and treating them identically is itself a minimization failure (`docs/PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md`'s finding #7 is a specific instance of this: quarantined/malformed data currently gets the *same* indefinite retention as successfully-processed clinical history, when it should get less).

## Proposed Retention Classes

### Class A: Clinical/event history of record — long retention, append-only, never silently deleted

`events` (the full clinical event log), `patients`, `tourniquets`, `inventory_ledger_v12`, `watchdog_alerts`, `patient_handover_tokens` (post-expiry, for the audit record of what was issued and consumed, not the live token itself).

This is the actual medical/incident record. Real-world SAR/EMS record retention requirements are jurisdiction- and organization-specific (**needs real legal/medical-records governance input — not something to assert a specific number of years for here**), but the *principle* is clear regardless of the exact number: this class should never be silently deleted, only formally archived under a documented process, and any deletion must itself be an audited event (who deleted what, when, under what authority), not a bare `DELETE`. `docs/OPERATIONS_SAFETY.md`'s "do not remove audit history to make a workflow look cleaner" already states this as a non-negotiable — this class is exactly what that rule protects.

### Class B: Operational/audit trail — medium retention, purpose expires with the incident

`conflict_log`, `device_presence`, `device_sync_state`, `sync_ingestion_errors` (**for successfully-diagnosed and resolved entries** — see Class C for the raw-payload carve-out), `aar_context_notes`, `external_reports`, `external_patient_links`.

This data's purpose is operational awareness *during* an incident and after-action review *shortly after* — a `device_presence` heartbeat from three incidents ago has no ongoing operational value once the incident that produced it is closed and its AAR is generated. Recommend: retain in full through incident close + AAR generation, then either archive (move out of the hot operational tables, keep for historical AAR/analytics purposes) or apply a defined retention window (e.g. N months post-close) — the exact window is a policy decision, not a technical one, but *some* defined window belongs here, unlike Class A.

### Class C: Quarantined/malformed data — short retention, narrower than Class A even though it's event-adjacent

`sync_ingestion_errors.raw_payload` specifically (not the whole table — `error_code`/`error_message`/`dependency_status`/timestamps are cheap, low-sensitivity, and useful to keep as Class B). The raw payload of a rejected event can contain partial clinical free text that never became part of the actual patient record (that's *why* it was rejected), which means it's PII-adjacent risk with none of Class A's "this is the record of care" justification for keeping it forever.

Recommend: once a `sync_ingestion_errors` row is marked `resolved_at` (or after a defined short window, e.g. 30-90 days, whichever comes first), null out `raw_payload` specifically while keeping the row's diagnostic metadata (`error_code`, `error_message`, `dependency_status`, timestamps) for the operational audit trail. This directly addresses `docs/PRIVACY_AND_DATA_MINIMIZATION_REVIEW.md` finding #7 without losing the ability to answer "how often does this error code happen" from the retained metadata.

### Class D: Ephemeral/no real retention value beyond immediate use

Nothing currently in the live schema clearly belongs here — `local_event_queue` (an *analytics-schema-only* concept, `seed_demo_db.py`'s SQLite schema, representing a device's own unsynced local queue) is the closest fit, but it doesn't exist server-side at all (by definition — the server never sees a device's still-local queue). Noted for completeness; no live-schema action needed.

## Deletion Must Be Audited, Not Silent

Whatever retention window gets adopted, the deletion/archival mechanism itself needs to write an audit record (what was deleted, when, by what process, under what policy) — otherwise "we have a retention policy" quietly becomes "we have an unaudited data-destruction process," which is a worse property than having no policy at all for anything in Class A. This is a real design requirement for whichever future session implements this, not optional polish.

## What This Document Does Not Do

- Does not implement anything. No scheduled job, deletion code, or archival storage exists yet — this is the policy proposal Phase 5 asks for, not the Phase 4-adjacent engineering work to build it.
- Does not name specific retention durations for Class A/B — those need real organizational/legal input (medical record retention law varies by jurisdiction; an operational SAR unit's own records policy may differ from a hospital's). The document names the *classes* and the *principle* so that whoever provides the real numbers has a structure to slot them into, rather than starting from nothing.
- Does not cover backup/disaster-recovery retention (a separate, infrastructure-level policy) — `docs/PRODUCTION_READINESS.md`'s "backup and incident response plan" item, still open.
