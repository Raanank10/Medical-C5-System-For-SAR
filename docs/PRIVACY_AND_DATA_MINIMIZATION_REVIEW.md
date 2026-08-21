# Privacy and Data Minimization Review

`docs/ROADMAP.md` Phase 5 deliverable. Reviews what the live schema (33 base tables, `information_schema.columns` as of this writing) actually collects, for what stated purpose, and whether it collects more than that purpose needs — not a legal privacy-law compliance opinion (GDPR/HIPAA-equivalent applicability needs real legal review, out of scope here) and not a restatement of `docs/OPERATIONS_SAFETY.md`'s "keep repo data synthetic" policy, which is a different thing from this.

## Method

Every table holding personal or operationally sensitive data was checked against one question: does this column serve the patient-care or incident-command purpose it's collected for, or does it collect more than that? Findings are grouped by data class, most sensitive first.

## Data Classes

### 1. Direct patient identity — `patients.optional_name`

The schema's own naming (`optional_name`, not `name`) already reflects a minimization decision: patients are identified primarily by `visual_id` (e.g. `P-004`), a synthetic per-incident tag, not a name. A real name is optional and only captured if actually known at the point of care.

**Finding**: correctly minimized already. No action needed — this is a case where the schema got it right, worth naming so it isn't accidentally "fixed" into collecting more.

### 2. Clinical data — `patients` (36 columns), `events.payload_json`, `tourniquets`, `inventory_ledger_v12`

Vitals, triage, injury zones, medication events, tourniquet application/reassessment history. This is the system's actual purpose — a triage/command tool needs this data to function, and none of it is collected beyond what MSTART triage, vitals reassessment, and handover doctrine actually require (cross-checked against `docs/C5_SENTINEL_SAR_MVP_SPEC_v1.2.md`).

**Finding**: not over-collected relative to purpose. The real question for this class isn't *whether* to collect it but *how long to keep it and who can read it* — covered in `docs/AUDIT_AND_RETENTION_POLICY.md`, not here.

### 3. Identity/contact data — `profiles.phone`, `profiles.unit_name`, `profiles.display_name`

`profiles.phone` is real personal contact information for every role holder (medic, commander, etc.), not just patients. Checked what actually reads it: nothing in `index.html`'s current UI displays or uses `phone` anywhere (grepped for `\.phone\b` usage across the client — no hits outside the schema/RLS layer itself). It's collected but not consumed by any current feature.

**Finding**: real over-collection relative to current use. Either a real feature needs it (e.g. an emergency contact-the-medic-directly command action, which doesn't exist yet) and that should be documented, or the column should be considered for removal — don't keep collecting personal contact data "in case it's useful later" without a named purpose. This is a decision for whoever owns the product direction, not something to silently drop, since a future feature might genuinely need it — but it should stop being collected-by-default without a stated purpose.

### 4. Location data — `incidents.location_name`/`address`, `patients.location_json`, `device_presence.current_location_json`, `sectors`

Operationally necessary for a SAR/MCI command tool — commanders need to know where patients and devices are. `device_presence.current_location_json` in particular is real-time personnel location tracking (where is medic X right now), which is a materially different sensitivity level than "where is a patient" — it's tracking the *responder*, not the casualty.

**Finding**: necessary for the stated purpose, but `device_presence` location tracking deserves its own explicit acknowledgment to anyone using this system operationally: real-time responder location is being collected. This isn't a minimization problem (the command use case genuinely needs it) but it is a *disclosure* problem — nothing currently tells a medic that their live location is visible to command roles. Recommend a one-line notice in the app itself (not just a doc), not a schema change.

### 5. External/cross-system data — `external_reports`, `external_patient_links`

`external_reports` captures data from *other organizations'* reporting (red/yellow/green/black counts, evacuation destination, free-text `notes`) with a `match_reason` jsonb field on `external_patient_links` explaining why a patient was auto/manually matched to an external report. The free-text `notes` field on `external_reports` has no schema-level constraint on content — it's exactly the kind of field that accumulates more than intended over time (a well-meaning field note that happens to include a real name, a radio callsign, an informal location description) precisely because it's unconstrained text from a different organization's data entry, not this system's own controlled UI.

**Finding**: real risk, not from what the schema requires but from what free text allows. No code-level fix changes this (you can't schema-constrain a notes field without losing its purpose) — this needs a documented data-handling norm (redaction/review before cross-org data is retained past the incident) rather than a technical control. Flag for whoever owns cross-agency data-sharing agreements.

### 6. Tester/feedback data — `tester_feedback_reports`

Captures `reporter_display_name`, `device_info`, a free-text `summary`/`expected` pair. Built for exactly the stated purpose (letting field testers report bugs — see this session's earlier work), and `device_info`/`app_version` are genuinely needed for triaging a bug report. No PII beyond what a bug tracker normally needs.

**Finding**: appropriately scoped for its purpose. No action.

### 7. Audit/operational trail — `conflict_log`, `sync_ingestion_errors`, `watchdog_alerts`, `events` (full history)

Covered in depth in `docs/AUDIT_AND_RETENTION_POLICY.md` — the privacy-relevant point here is narrower: `sync_ingestion_errors.raw_payload` stores the *entire rejected event payload*, which could include partial/malformed clinical data (that's the point — you need the bad payload to debug why it was rejected). This means a payload containing a real name typed into a free-text field (e.g. `patients.optional_name`, `events.payload_json`'s treatment notes) that then fails validation for an unrelated reason gets preserved verbatim in the quarantine table, readable by any command role in that incident, indefinitely (no retention policy today).

**Finding**: real minimization gap. A malformed-but-otherwise-normal clinical event doesn't need its `raw_payload` retained forever just because it initially failed — this is exactly the kind of data that should have a *shorter* retention window than successfully-processed clinical history, not the same or longer one. See `docs/AUDIT_AND_RETENTION_POLICY.md`'s recommendation.

## Summary of Findings

| # | Finding | Severity | Fix type |
|---|---|---|---|
| 1 | `patients.optional_name`/`visual_id`-first identification | None — already correctly minimized | N/A |
| 3 | `profiles.phone` collected but unused by any current feature | Real, low urgency | Product decision: name a purpose or stop collecting |
| 4 | `device_presence` real-time responder location has no in-app disclosure | Real, disclosure gap not a collection gap | UI copy, not schema |
| 5 | `external_reports.notes` free text can accumulate unintended PII from other orgs | Real, structural (free text) | Data-handling norm, not a technical fix |
| 7 | `sync_ingestion_errors.raw_payload` retains rejected clinical payloads indefinitely | Real, retention gap | See `docs/AUDIT_AND_RETENTION_POLICY.md` |

## Explicitly Out of Scope Here

- Legal applicability of GDPR/HIPAA-equivalent frameworks to a real deployment — needs actual legal review with a real jurisdiction and org structure, not something to guess at from the schema.
- Whether the *amount* of clinical data collected is doctrinally correct (that's `docs/PRODUCTION_READINESS.md`'s Clinical and Operational Governance section — a domain-expert review, not a privacy review).
- Cross-referencing this against `docs/THREAT_MODEL.md` for confidentiality *controls* (who can access what) — that document covers access; this one covers collection.
