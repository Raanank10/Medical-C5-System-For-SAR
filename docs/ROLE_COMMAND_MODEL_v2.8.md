# Role-Based Medical Command Model V2.8

V2.8 extends [V2.7](ROLE_COMMAND_MODEL_v2.7.md) by formally modeling the rescue command chain — RPC (מ״מ, Rescue Platoon Commander) and RCC (מ״פ חילוץ, Rescue Company Commander) — which V2.7 did not cover, and by giving the "Doctor / Paramedic" senior-clinical-review concept (already described operationally in V2.7 §"Doctor / Paramedic") a real authenticated server role for the first time. Medic, חוג״ד, מ״פ רפואה, logistics, and Chamal are unchanged from V2.7; this document only covers what's new.

## Why RPC/RCC exist as separate roles

Rescue command and medical command are different chains of authority that both operate at the same incident. RPC/RCC are typically first on scene, before any medic — they see the building, the trapped victims, and the structural risk before anyone sees a pulse. V2.8 gives them a real system role instead of forcing their information through a medic or חוג״ד.

## RPC — מ״מ (Rescue Platoon Commander)

Tactical picture for their own platoon only: tag, triage color, zone, trapped/mobile status, evac status, and which medic is responsible (callsign only, never full name). No vitals, treatment, mechanism of injury, or patient identity — this role never needs clinical detail to do its job.

RPC does **not** submit medical reinforcement or resupply requests — that stays with חוג״ד/מ״פ רפואה.

RPC **can**:
- File a First Responder Quick Report (location, trapped, tourniquet — no clinical triage) for a patient not yet seen by a medic.
- Exercise site authority (see below) for their platoon's area.

## RCC — מ״פ חילוץ (Rescue Company Commander)

Same tactical scope as RPC, rolled up across every platoon in their company: triage counts, trapped counts, and evac status per platoon, plus visibility into open resupply requests for the rescue company's own logistics (not medical resupply, which stays with חוג״ד/logistics).

RCC has the same clinical-data restrictions and the same First Responder Quick Report and site-authority capabilities as RPC, scoped to the company instead of a single platoon.

## Site authority: final, without medical sign-off

This is the core authority decision in V2.8. As first responders, RPC/RCC can take the following actions **final, with no חוג״ד/מ״פ רפואה approval required**:

- Declare the incident official and set T0.
- Close or reopen the incident.
- Set building status: stable / unstable / progressive collapse / safe to enter.
- Confirm the site is clear.

חוג״ד and מ״פ רפואה are notified of each change on their own dashboards — they see it, they do not gate it. The reasoning: these are scene-safety and incident-declaration calls, which is rescue command's competency, not medical command's. Requiring medical sign-off on "is this building safe to enter" would put a medical role in the approval path for a decision they have no basis to evaluate, and would slow down exactly the call that most needs to be fast.

This currently exists only as a client-side capability check (the button set rendered per role). There is no server-side enforcement yet — see the "Known gap" note in [`CHANGELOG_v2.995.md`](CHANGELOG_v2.995.md). Before this ships anywhere beyond a demo, the RLS/auth work in Mission 2 of [`MULTI_AGENT_DEV_PLAN.md`](MULTI_AGENT_DEV_PLAN.md) must enforce this same restriction server-side, or a compromised/misconfigured client could call these actions as any role.

## PC can go hands-on

חוג״ד's server-side clinical write authority (`app.can_write_clinical_event()`, `ROLE_ALLOWED_EVENT_TYPES.pc`, `patients_insert`) has always matched medic's — the in-app read-only authorization matrix already documented this. What was missing was a client-side entry point: pc's dashboard had no button to create a new patient or reach the MSTART sweep/field workflow screen, so in practice pc could only treat patients already in its scope (via the shared `openPatient`/`openQuickVitals` path, which has never had a role check), not create new ones.

Fixed: pc's dashboard now has an explicit "טיפול ישיר / go hands-on" action offering the same "פצוע נוסף" quick-patient path and full MSTART/field-workflow screen medic uses (`startNewCasualtyInCurrentContext()`, `goTo('enroute')` — no new server logic, both already worked for any role). This stays additive, not a default: unlike medic/paramedic, pc still lands on its command dashboard by default (`startRoleDashboard()`'s auto-routing to the field screen is medic/paramedic-only) — pc goes hands-on by choice, when the platoon needs it, not as its primary mode.

## Physician and Paramedic — real server roles, cross-device conflict authority

V2.7's "Doctor / Paramedic" (senior clinical review: red/black patient review, death certification, response to חוג״ד/מ״פ רפואה requests) existed only as a client-side demo dashboard label, with no authenticated account backing it. V2.8 adds two real server roles, `physician` and `paramedic`, resolving that gap and giving F3 (cross-device concurrent-edit resolution, `docs/CONFLICT_RESOLUTION_DECISION.md`) the role-authority tie-break it needs.

**Physician** (`רופא`) has `מ״פ רפואה`'s full command-adjacent scope (incident/sector management, device presence, conflict-log and quarantine review, patient-identity write access) plus medic/pc-level clinical event write access, so a physician can actually participate in triage/status decisions rather than only reviewing them after the fact. Logs in through the existing "Doctor / Paramedic" dashboard.

**Paramedic** (`פראמדיק`) has the same field/clinical authority as physician — the same drugs and procedures, including confirming a high-risk clinical override (e.g. a pediatric medication dose outside the normal safe range) — with one exception: official death certification stays physician-only. Paramedic stays a field role otherwise, same patient-creation/vitals/treatment/triage-status write access and field workflow screen as medic, not physician's broader command-adjacent scope (incident/sector management, device presence, patient identity). In practice paramedic's clinical event-write list already matches medic's exactly (both get the same `CLINICAL_EVENTS`), so "same as physician" mostly shows up as a rank distinction in the tie-break below plus the `high_risk_override_insert` fix (`database/023`) rather than a new capability most of the time.

**Physician clinical death confirmation — real, not narrative.** A physician can tap a one-time "אשר מוות (קליני, לא רשמי)" action on any black/deceased patient from the physician dashboard, recording `PATIENT_DEATH_CONFIRMED` (`database/024`-`026`): who confirmed and when, on the `patients` row and in a dedicated `death_confirmations` audit table, both physician-only at the RLS layer (the table's own insert policy, *and* — the actual enforcement point, since the projection trigger is `SECURITY DEFINER` and would otherwise bypass that table's RLS — a physician-only carve-out on `events_insert_by_role` itself). This is deliberately **not** official/legal death certification, which stays entirely out of this repo's scope; it's a second, physician-exclusive clinical fact layered on top of the medic's existing field black-tag (`PATIENT_TRIAGED_EXPECTANT`), which every clinical role continues to set exactly as before. The pre-existing `doctor_death_cert` reinforcement-request flow is unrelated narrative UI, unchanged by this.

**Client-side, physician and doctor are one identity, not two.** Earlier builds mapped the server `physician` role onto a separate client dashboard key, `doctor`, as a reuse shortcut. That was later recognized as an unnecessary duplication of the same role and consolidated: the client now uses `physician` as the single key throughout (role config, labels, dashboard routing, the in-app Roles & Authorization matrix). `docs/AUTH_AND_ROLE_MODEL.md` has the full detail.

**Role-authority tie-break**: when two devices genuinely collide on the same patient field within a short window, the higher-ranked role wins: **physician > paramedic > cc (מ״פ רפואה) > pc (חוג״ד) > medic**. Every such override is logged and surfaced to command, never silent — see `docs/CONFLICT_RESOLUTION_DECISION.md` for the full mechanism.

## First Responder Quick Report

A deliberately minimal intake form, distinct from the medic's MSTART sweep:

- Fields: location/landmark, trapped (yes/no), tourniquet applied (yes/no, + limb if yes). RCC additionally selects which platoon the report belongs to.
- Produces a patient record with `triage: 'pending'` and `needsFullAssessment: true` — it explicitly does not assign a triage color. Clinical classification stays medic-only, consistent with V2.7's ticket contract ("How was the color set? MSTART automatic, manual, override, or deterioration update" — a first-responder report is none of these).
- Intended use: a trapped or unseen casualty gets a record and a location in the system the moment rescue finds them, instead of waiting for a medic to physically reach them before they exist in the incident picture at all.

## Roles table (additions to V2.7)

| Role | Owns | Explicitly excluded |
|---|---|---|
| RPC (מ״מ) | Tactical picture for own platoon; site authority for own area; first-responder reports | Vitals, treatment, mechanism, identity; medical reinforcement/resupply requests |
| RCC (מ״פ חילוץ) | Tactical picture rolled up across own company's platoons; site authority for own area; first-responder reports; rescue-company resupply visibility | Vitals, treatment, mechanism, identity; medical reinforcement requests |
| Physician (רופא) | מ״פ רפואה's full command-adjacent scope plus clinical event write access; senior review; real physician-only clinical death confirmation (`PATIENT_DEATH_CONFIRMED`, distinct from official/legal certification, which stays out of scope); top rank in the F3 conflict-authority tie-break | Creating new patient records (same restriction as מ״פ רפואה) |
| Paramedic (פראמדיק) | Same field/clinical authority as physician (drugs, procedures, high-risk override confirmation); same patient-creation/vitals/treatment/triage-status scope as medic otherwise; ranks above מ״פ רפואה in the F3 conflict-authority tie-break | Physician-only clinical death confirmation; physician's command-adjacent scope (incident/sector management, device presence, patient identity) |
| Admin | Full technical access: raw data, scenario load/clear, experiment export, version/sync checks | Not an operational command role — demo/test-running only, same as V2.7 |

## Authorization matrix

The full 10-role × 22-action matrix (all roles, all actions) lives in-app at the "Roles & Authorization" screen, generated from `ROLE_DEFS` / `AUTH_MATRIX` in `index.html`. This document covers the *why* behind the RPC/RCC/Admin columns; the matrix itself is the source of truth for the *what*, since duplicating a growing table into a second document is exactly the kind of copy that drifts (see the `src/domain/rules.js` vs. inlined-copy drift noted in [`MULTI_AGENT_DEV_PLAN.md`](MULTI_AGENT_DEV_PLAN.md)). Physician and paramedic each have their own dedicated matrix column now, derived from their real, already-shipped RLS/event-type authority rather than guessed — the previous state (physician aliasing a merged "doctor" column, paramedic entirely absent from the matrix) is resolved.

Every row, including "Confirm patient death," shows `admin:'yes'` — admin's blanket bypass is a deliberate, explicit product decision (not just the Edge Function default): admin exists to verify the system works from the inside and read the logs, so it should never be the one role blocked from exercising any real action. `database/026`'s initial `PATIENT_DEATH_CONFIRMED` carve-out briefly left admin blocked (an oversight, caught by live testing rather than assumed correct) and was fixed in `database/027_events_death_confirmed_admin_bypass.sql` to restore admin alongside physician.
