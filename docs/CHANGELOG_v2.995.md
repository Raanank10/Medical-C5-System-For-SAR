# Changelog V2.995

Built outside git since V2.994 (Create Demo V2.994 focus collapse workflow) and merged in as a single update. No changes to `src/domain/rules.js` or triage math — this release is entirely new authority/workflow surface for the rescue command chain.

## First Responder Quick Report (RPC / RCC)

A Rescue Platoon Commander (מ״מ) or Rescue Company Commander (מ״פ חילוץ) — first on scene, before any medic arrives — can now log a bare-minimum patient report: location/landmark, trapped yes/no, tourniquet applied yes/no (+ limb). No clinical triage is captured or inferred.

- Creates a patient record with `triage: 'pending'`, `needsFullAssessment: true`, `identityStatus: 'unknown'`, empty vitals, and an event trail (`FIRST_RESPONDER_REPORT`) recording who reported it and from which role.
- If an RCC files the report, they must first select which platoon within their company it applies to.
- The record waits for a medic to perform the real MSTART assessment; it does not get a triage color from this flow.

## Rescue-chain site authority (RPC / RCC act without medical sign-off)

New functions give RPC/RCC final authority — no PC/CC approval required — over site-level status, on the reasoning that rescue command is the one making real-time safety calls at the scene:

- `rescueOpenOfficialIncident` — declares the incident official and sets T0 if not already set.
- `rescueToggleIncidentClosed` — closes or reopens the incident.
- `rescueUpdateBuildingStatus` — sets building status: stable / unstable / progressive collapse / safe to enter.
- `rescueConfirmSiteClear` — confirms the site is clear.

Each action writes a `siteData.lastRescueStatusChange` entry (who, what, when) and a corresponding local event (`OFFICIAL_INCIDENT_OPENED_BY_RESCUE`, `INCIDENT_CLOSE_TOGGLED`, `BUILDING_STATUS_UPDATED`, `SITE_CLEAR_CONFIRMED`). PC (חוג"ד) and CC (מ״פ רפואה) see the change surfaced as a status line on their own dashboards on next render — they are notified, not asked to approve.

## Tactical patient panel (RPC / RCC)

Read-only rollups scoped to the viewer's own platoon (RPC) or company (RCC, broken down per platoon): triage counts, trapped count, evac status, and the responsible medic's callsign only. Explicitly excludes vitals, treatment, mechanism of injury, and patient identity — consistent with the "Limited" access level already defined for these roles in the authorization matrix.

## Role model and authorization matrix

- `ROLE_DEFS`, `ROLE_LABELS`, and `AUTH_MATRIX` now fully model `rpc`, `rcc`, and `admin` (previously the matrix only wired in 5 of the 8 defined roles; `admin` existed as a role but had no matrix row/columns at all).
- Two new matrix rows: "View tactical patient panel" and "View raw data / source code / run demo controls."
- See [`ROLE_COMMAND_MODEL_v2.8.md`](ROLE_COMMAND_MODEL_v2.8.md) for the full authority model.

## Fixes

- Clearing/deleting a site now blanks the `site-name-input`, `site-address`, and `site-description` DOM fields directly. Previously these plain inputs kept stale text on screen, which could silently repopulate a "deleted" site the next time `saveSite()` ran.
- Fixed a stale call to `renderReports()` that should have been `renderExtReports()`.

## Known gap carried forward

The RPC/RCC site-authority actions above are the first place role authority is enforced purely client-side, with no server-side check behind it. This matters more than most UI-only gaps because the whole point of the feature is that it's a final, unapprovable action — right now nothing stops a modified client from calling `rescueConfirmSiteClear` as any role. Flagged for Mission 2 (RLS enforcement) in [`MULTI_AGENT_DEV_PLAN.md`](MULTI_AGENT_DEV_PLAN.md): this action set needs an explicit RLS/policy check tied to `user_role`, not just a hidden button.
