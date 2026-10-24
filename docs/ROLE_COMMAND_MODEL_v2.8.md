# Role-Based Medical Command Model V2.8

V2.8 extends [V2.7](ROLE_COMMAND_MODEL_v2.7.md) by formally modeling the rescue command chain — RPC (מ״מ, Rescue Platoon Commander) and RCC (מ״פ חילוץ, Rescue Company Commander) — which V2.7 did not cover, and by giving the "Doctor / Paramedic" senior-clinical-review concept (already described operationally in V2.7 §"Doctor / Paramedic") a real authenticated server role for the first time. Medic, חוג״ד, מ״פ רפואה, logistics, and Chamal are unchanged from V2.7; this document only covers what's new.

## Why RPC/RCC exist as separate roles

Rescue command and medical command are different chains of authority that both operate at the same incident. RPC/RCC are typically first on scene, before any medic — they see the building, the trapped victims, and the structural risk before anyone sees a pulse. V2.8 gives them a real system role instead of forcing their information through a medic or חוג״ד.

## RPC — מ״מ (Rescue Platoon Commander)

Tactical picture for their own platoon only: tag, evacuation priority (urgent / not urgent / not yet sorted; the triage colour itself is not shown since V2.99.63, see "Clinical data stays with the medical roles" below), zone, trapped/mobile status, evac status, patient identity (full name once reported/confirmed, otherwise the physical description used to locate an unidentified patient), and which medic is responsible (callsign only, never full name). No vitals, treatment, or mechanism of injury — this role never needs clinical detail to do its job, but it does need to know which physical person in the field is which patient, which is why identity (unlike vitals/treatment/mechanism) is in scope. See "Evacuation order visibility" below.

**Enforced by the database since `database/053` (V2.99.42).** An RPC reaches only its own platoon's sites and an RCC its own company's (plus any they opened or were assigned to), and RPC and RCC read only tactical event types: vitals, medication, treatment, injury and the MIST handover summary are hidden from both. Before `053` both rules existed only on the screen. Since `database/074` (V2.99.63) they also no longer read the patients table, the triage colour, tourniquets or the MDA classification at all: their patients come from `get_rescue_patient_board()`. See "Companies and platoons" below.

RPC does **not** submit medical reinforcement or resupply requests — that stays with חוג״ד/מ״פ רפואה.

RPC **can**:
- File a First Responder Quick Report (location, trapped, tourniquet — no clinical triage) for a patient not yet seen by a medic.
- Exercise site authority (see below) for their platoon's area.

## RCC — מ״פ חילוץ (Rescue Company Commander)

Same tactical scope as RPC, rolled up across every platoon in their company: priority counts (urgent / not urgent / not yet sorted), trapped counts, and evac status per platoon, plus visibility into open resupply requests for the rescue company's own logistics (not medical resupply, which stays with חוג״ד/logistics).

RCC has the same clinical-data restrictions (no triage colour, tourniquet, vitals, treatment or mechanism; identity is visible, same as RPC) and the same First Responder Quick Report and site-authority capabilities as RPC, scoped to the company instead of a single platoon.

## Evacuation order visibility (added after V2.8)

RPC/RCC need to know which patient is evacuated first and what the order is after that — they're coordinating the physical vehicles/routes for the same evacuation sequence חוג״ד/מ״פ רפואה are prioritizing clinically. Their dashboards show an ordered "סדר פינוי מומלץ" list built from the exact same ranking PC/CC already use (tourniquet-window-closing can outrank triage color; otherwise sorted by triage color) — deliberately the same function and the same order, not a separately-computed one, so rescue command and medical command never disagree about sequence.

Since V2.99.63 (`database/074`) none of that ranking's reasoning reaches RPC/RCC: the server computes the order in `get_rescue_patient_board()` and returns only each patient's place in it (1, 2, 3...) and its priority (urgent / not urgent / not yet sorted). The reason text, which named the tourniquet time, the colour or the vitals, is gone from their screens, and the score itself is not sent because it would show minutes on a tourniquet. Before V2.99.63 the tourniquet reason was shown verbatim and only the vitals-based reason was redacted.

## Clinical data stays with the medical roles (V2.99.63)

Decided with the repo owner on 2026-10-23, after a live check of what each role could read. Enforced by the database (`database/074`), not only on the screen.

- **Logistics officer: bags, not patients.** It sees each medic bag's and PC truck's movements (which item, how many, when, the count left) and the supply requests, across every site it joins, as before. It no longer reads patients, tourniquets, watchdog alerts, external or pre-evacuation reports, clinical events, or the patient each item was used on: the stock comes from `get_incident_stock_movements()`, which leaves the patient out, and the events it reads are an allowlist (incident lifecycle, supply requests, stock moves between holders). Its screen no longer names a patient on a consumption line. Before this, `join_incident()` let it join any open site and then read every patient and clinical event there.
- **Rescue chain (מ״מ, מ״פ חילוץ): no clinical data at all.** They keep identity, location, trapped / access, evacuation status and the evacuation order. Triage reaches them only as a priority: **urgent** (red, or an active tourniquet), **not urgent** (yellow, green, black) or **not yet sorted** (never shown as not urgent). No colour, no tourniquet, no pulse / breathing / injury zones, no MDA classification, no vitals or treatments, no external-report colour counts and no pre-evacuation condition counts (`external_reports` and `incident_pre_evacuations` are now read through the clinical rule). Their patients come from `get_rescue_patient_board()`; they still write First Responder Quick Reports, including tourniquet yes/no, and see what they wrote themselves. The evacuation status shows on site / being evacuated / evacuated; a deceased patient is not told apart (that is a clinical status).
- **Medic: the whole site, with its own patients marked.** Scope stays the site (a medic needs every patient there for handovers and the MSTART sweep). The patients this medic registered or treated on this phone (created, vitals, treatment, medication, airway, tourniquet, triage, handover, supplies used) are marked "✓ טיפלתי" and listed first, then "פצועים נוספים באתר". The mark is per user and kept with the phone's encrypted patient store; it does not follow the medic to another phone.
- **Deceased last in the evacuation order** (owner, 2026-10-23). A patient whose status is deceased, or who is triaged black, always comes after everyone else, including patients not yet sorted, whatever else is recorded. Before this an active tourniquet still ranked a deceased patient first. Same rule on the phone (`isDeceasedForEvac` in `evacuationPriorityRank`, used by the PC / CC tiles and boards) and on the server (`get_rescue_patient_board()`); for the rescue chain such a patient shows as not urgent.
- `get_incident_command_state()` (red counts, missing vitals) refuses logistics, מ״מ and מ״פ חילוץ.
- Shared rule: `src/domain/rules.js` `rescueEvacPriority()`; the server computes the same.

Not covered, on purpose: free text and item lists in supply requests stay readable to logistics (written for logistics by the requester), and the events these roles may read still carry the patient's internal id, which they cannot resolve to a patient.

## Site authority: final, without medical sign-off

This is the core authority decision in V2.8. As first responders, RPC/RCC can take the following actions **final, with no חוג״ד/מ״פ רפואה approval required**:

- Declare the incident official and set T0.
- Close or reopen the incident. Since `database/040_close_incident_guard.sql` (V2.99.28) closing is blocked while any patient has not been handed over (or self-evacuated, or died). RPC/RCC still need no medical approval to close a fully handed-over incident, but they cannot override the block: only חוג״ד / מ״פ רפואה / חמ״ל / physician / admin can, with a mandatory reason that goes into the event log. This rule is enforced server-side (`close_incident()` plus a trigger), unlike the rest of this list.
- Set building status: stable / unstable / progressive collapse / safe to enter.
- Confirm the site is clear.

חוג״ד and מ״פ רפואה are notified of each change on their own dashboards — they see it, they do not gate it. The reasoning: these are scene-safety and incident-declaration calls, which is rescue command's competency, not medical command's. Requiring medical sign-off on "is this building safe to enter" would put a medical role in the approval path for a decision they have no basis to evaluate, and would slow down exactly the call that most needs to be fast.

This started as a client-side capability check only (the button set rendered per role; see the "Known gap" note in [`CHANGELOG_v2.995.md`](CHANGELOG_v2.995.md)). Since V2.99.44 (`database/060`, WP-8) T0, building status and site clear are enforced and shared server-side: `project_incident_site_authority()` changes the shared state (`incident_site_authority`, read by every phone in the incident) only for rpc/rcc/admin, reading the role from `profiles`; the same event from pc/cc/chamal/physician is kept in the event log and changes nothing. The first T0 and the first site clear win; the newest building status wins. Close/reopen is enforced by `close_incident()`/`reopen_incident()` as above, and the incident type by `incidents_update` RLS.

## Incident type and medic assignment on the Movement screen (V2.99.23)

The medic Movement screen (`screen-enroute`, "מסך תנועה - הכנת זירה") used to show a hardcoded "structural collapse" alert banner. It now offers the same four incident types as the RPC/RCC site-authority panel (קריסת מבנה / טיל, ירי המוני, תאונת דרכים, פיצוץ), with the same expected-injury brief, so a medic who is first on scene can set up the incident themselves.

Incident type follows the site-authority rule above: **rescue (RPC/RCC) wins.**

- A medic may set the type while none is set, or replace a type a medic set earlier.
- Once RPC/RCC set the type, a medic pick that differs is never applied. It is logged as `INCIDENT_TYPE_MISMATCH_REPORTED` and surfaces to חוג״ד/מ״פ רפואה as an `INCIDENT_TYPE_MISMATCH` alert ("פער בסוג אירוע: חובש מול חילוץ"). Rescue can still overwrite a medic-set type at any time.

**Building collapse with any incident type (V2.99.29).** Only "missile strike" used to carry the crush/trapped expectations, although an explosion, a shooting or an accident can also bring a building down. The Movement screen's building-state section ("סוג מבנה / מצב ראשוני") now sits directly under the incident type and acts as the collapse flag: full collapse, partial collapse or "standing with trapped" marks the site as collapsed (as does RPC/RCC's "progressive collapse" building status). For any type except missile strike (which already includes it), the injury brief then adds the crush / trapped / Crush Syndrome part and the type reads "<type> + קריסת מבנה" on the Movement screen and on the PC/CC/rescue site rows. Choosing "unknown" clears the medic's flag. Local-demo / same-device only, like the incident type itself (see below).

**Building section only for missile strike, type-specific questions for the rest (V2.99.57).** Owner request: the building-state section opened for every type, which made no sense for a road accident or a shooting in the open. It now opens by itself only for "קריסת מבנה / טיל". For any other type (or before a type is chosen) the medic is asked one question, "מבנה נפגע / לכודים במבנה?": "כן" opens the same section, so the V2.99.29 collapse flag and crush brief still work for a collapse after an explosion, a shooting or an accident; "לא" closes it and clears the medic's collapse flag (rescue's "progressive collapse" status still counts, and a note says so). A collapse already reported keeps the section open after a type change. Since V2.99.63 the "קומה / אגף" and "דירה / כניסה" fields follow the same rule: shown for a missile strike or after "כן", hidden otherwise, and hidden values are left out of the arrival record. Each other type gets its own optional tap questions, kept per type so switching types never mixes answers:

- ירי המוני: מצב הירי (ירי פעיל / מחבל נוטרל / לא ידוע), זירה (שטח פתוח / מבנה או חלל סגור).
- תאונת דרכים: מספר כלי רכב, מעורבים (רכב פרטי / אוטובוס / משאית / הולך רגל, several allowed), לכודים ברכב, שריפה / דליפת דלק.
- פיצוץ: מקום (שטח פתוח / חלל סגור), חשש לפיצוץ משני, חשד לחומ"ס, שריפה פעילה.

Some answers show a red safety line on the Movement screen (active shooter, trapped in a vehicle, fire / fuel leak, enclosed-space blast, secondary device, hazmat, active fire). These are generic scene-safety reminders, not clinical rules, and need the owner's / clinical governance review like any other wording. A second tap clears a wrong pick. The answers stay on the device (`siteData.incidentDetails`, `siteData.buildingInvolved`) and are recorded in the local-only `SITE_ARRIVAL_CONFIRMED` payload (`building_involved`, `incident_type`, `incident_details`); nothing new is pushed to the server and no new event type exists.

חוג״ד can also assign a medic to an existing incident ("שייך לאירוע" on each medic panel in the PC medic-load board), with an optional address and note. An assigned medic's Movement screen shows who assigned them and what is already known: incident type and who set it, rescue site status, patients already registered at the site, and the PC's address and note. The address and note are pre-filled into the editable fields, but only into empty ones, so nothing the medic typed is overwritten. A medic correction to a pre-filled value is logged on arrival as `SITE_PREFILL_CORRECTED` with the old and new values.

**Local demo mode:** as described above, single-device. Signed in, assignment now syncs across phones on real incidents; see "Cross-device PC → medic assignment on real incidents (V2.99.30)" below. `MEDIC_ASSIGNED_TO_INCIDENT`, `INCIDENT_TYPE_MISMATCH_REPORTED`, `SITE_PREFILL_CORRECTED` and `INCIDENT_TYPE_SET` stay outside `SYNC_ELIGIBLE_EVENT_TYPES` (never pushed).

## Briefing demo and guided tour (V2.99.25)

The 60-second PC/CC briefing ("הצג תדריך מ״פ / חוג״ד ב־60 שניות") is back on the launcher, now as a **sandboxed** demo. Every test phone shares one live database, and the old sequence also started by wiping the phone's local data, so the scripted fake patient could reach other phones or delete real local patients. Now:

- The current local state is snapshotted first.
- While the sandbox is open, `getSupabaseClient()` returns `null`, so no pull, push, presence or other server read or write happens at all. `saveDemoState()` and `saveActiveRecoveryState()` are no-ops, and `saveLocalEvent()` never touches the outbox.
- A purple "הדגמה · לא נשמר ולא נשלח לשרת" banner with a "סיום הדגמה" button stays on screen for the whole run.
- Ending the demo cancels pending steps, closes any sheet a step opened (e.g. the tourniquet's supply sheet, which could otherwise write supply events about a demo patient), and restores the exact snapshot.

"סיור מודרך במסכי חוג״ד / מ״פ" is a read-only, 15-step walkthrough that highlights the real PC and CC dashboard panels and explains each one. It creates no data.

## Cross-device PC → medic assignment on real incidents (V2.99.30)

Signed in, a PC (or any command role: pc/cc/chamal/admin/physician) can assign a real medic or paramedic account to **the incident the PC is currently in**, from "שייך חובש לאירוע" on the medic-load board, with an optional address and note. It works across phones and needs **no schema, RLS or Edge Function change**. It uses only existing tables and access rules, verified live against the real PC, medic and rescue accounts on a real open incident, inside transactions forced to roll back so nothing persisted.

PC phone:
1. Writes the address to `incidents.address` and the note to `incidents.metadata.medic_assignments[<medic profile id>] = {note, assigned_by_name, assigned_at}`. The assigner's name goes in metadata because a medic cannot read other profiles. An update that changes no row fails loudly instead of silently.
2. Then upserts the medic's `incident_memberships` row (`assigned_by` = PC, `created_at` = now). That membership is also what lets the medic enter and push into the incident.

Medic phone:
- Reads its newest membership with `assigned_by` set, plus that incident's row, at login, on every 45-second incident refresh and when the Movement screen opens.
- **Not in any incident yet:** goes straight into the assigned one and opens the Movement screen.
- **Already working in another incident:** sees a "שובצת ע״י … לאירוע …" banner with "עבור לאירוע" / "לא עכשיו". It is never moved silently mid-treatment. A dismissed banner stays dismissed on that phone until a newer assignment arrives.
- **In the assigned incident:** the Movement screen shows who assigned them, the note, rescue status and patient count, and pre-fills the address and note into the editable fields.

Incident type now follows the server:
- The incident's `incident_type`, set when it was opened or later by rescue, is applied to the Movement screen on every phone in the incident. Before this, `activateIncident()` reset it and a medic always saw "סוג אירוע טרם נבחר".
- Rescue (`rpc`/`rcc`) changing the type writes `incidents.incident_type` + `metadata.incident_type_set_by`.
- The server type wins over a type picked locally on a phone, consistent with "rescue wins" above. A medic's own pick and the mismatch alert stay on the medic's phone, because medics may not update an active incident (verified: 0 rows).

Known limits:
- `metadata` is read-modify-write, so two writers in the same instant can drop one change.
- `MEDIC_ASSIGNED_TO_INCIDENT` remains a local log entry only; the membership row is the source of truth.
- Local demo mode (not signed in) keeps the single-device assignment described earlier.

## Evacuation tracking and casualty board by location (V2.99.33)

- **Handover** ("הועבר למד״א — עכשיו") opens a short sheet: destination hospital (free text with suggestions) and MDA's classification (קל / נפגע חרדה / בינוני / קשה / אנוש / נקבע מותו). Both are optional, because they are often unknown at handover. The confirm button is the same one-tap handover.
- **Later update** of destination / MDA classification: pc, cc, chamal, physician, admin (`PATIENT_EVACUATION_UPDATED`), from the patient card or the board's "עדכן" button. A medic or paramedic records them only at handover. The update never changes triage or status. If MDA's classification differs from field triage, the board shows "⚠ שונה ממיון שדה" for information only.
- **Casualty board by location** ("לוח נפגעים לפי מיקום"): on the PC and CC role dashboards and the command screen panel, with the same scope as the command screen (below). For each site it shows casualties on scene grouped by zone, evacuated casualties grouped by destination with MDA's classification, the initial-evacuation counter and external-report totals per source. An unknown zone or destination is shown as such, never hidden. Zones now sync between phones (`PATIENT_LOCATION_UPDATED`).
- **Command scope follows the hierarchy** (decided with the repo owner): מ״פ רפואה (company) is senior to חוג״ד (platoon). On the command screen the CC, חמ״ל and other command roles see every site, including the "all sites" tab. The PC sees only its own platoon's site (demo: PLT-A = SITE_A, PLT-B = SITE_B), cannot switch to another platoon's site, and sees only that site's reinforcement requests and its own platoon's recommendations, as its role dashboard already did. Before V2.99.33 this was inverted: the PC saw every site and the CC was pinned to one. Signed in, only the active incident is loaded as a site, so the PC's scope is that incident. Since `database/045` this is also a server-side security scope: a PC reaches only incidents it opened or was assigned to (plus its own platoon's medic drafts, which it confirms), cannot self-join another platoon's site, and assigns only its own platoon's medics. The CC (and chamal/physician/admin) keeps every incident, assigns PCs to sites, and manages the platoon roster from the "מחלקות — שיוך חובשים לחוג״ד" panel on its dashboard. Medics and paramedics also enter only incidents they were assigned to or drafted. Since `database/053` (V2.99.42) companies and platoons are real units with their own site lists: see "Companies and platoons" below.
- **External reports** add איחוד הצלה (United Hatzalah) as a source, with ידידים (Yedidim) kept separate, and איחוד הצלה is also on the initial-evacuation source chips. Reports from pc/cc/chamal/physician/admin sync to `external_reports` and appear on every command device. Other roles keep them on their own device, as before.

## Casualties evacuated before the medical force arrived (V2.99.36)

Requested by the repo owner: casualties who left the site before any medical staff arrived (taken by MDA, United Hatzalah, civilians, ...) are recorded without opening patient records, and it must be clear who evacuated them, where to, and in what condition.

- **Report shape:** rows of {count, condition (קל / בינוני / קשה), who evacuated (מד״א, איחוד הצלה, ידידים, כב״א, משטרה, צה״ל, אזרחים, פינוי עצמי, אחר), destination}, plus an optional note. Entered from the "פינוי מוקדם" sheet on the Movement (en-route) screen, the site screen, or the PC/CC board "פונו לפני הגעת כוח רפואי". The condition totals feed the same site counters as before (light = green, moderate = yellow, severe = red).
- **Who may write it:** the first medical staff on site (medic, paramedic, physician, pc, cc; admin per D7) sends the first report, which then locks. After that only חוג״ד (pc) and מ״פ רפואה (cc), plus admin, may change it. The first medic cannot edit their own report once sent; a PC/CC fixes it. `src/domain/rules.js` `canWritePreEvacuationReport`.
- **"First" means first to sync** (decided with the repo owner): when two medics enter a report offline, the one whose report reaches the server first owns it. The other version is kept in the event log, does not change the report, and shows on the PC/CC board as "דיווחים נוספים נדחו", with its content listed in the sheet. The losing medic's phone switches to the server report and says it was not accepted.
- Each device shows who entered the report and who last changed it.
- chamal sees the report where its screens already show site counters but cannot write it. Since V2.99.63 (`database/074`) rpc, rcc and logistics no longer read it: its condition split (light / moderate / severe) is clinical.
- The "expected number" of casualties (requirement 3) was deferred by the repo owner.

## Companies and platoons (V2.99.42)

Structure confirmed with the repo owner on 2026-10-20: 1 מ״פ רפואה, 3 מ״פ חילוץ, 3 חוג״ד, 9 מ״מ, and one ambulance team.

```
Same command level:  מ״פ רפואה (cc, one) ── ambulance team        מ״פ חילוץ A, B, C (rcc, one per company)
                         ┆ medical guidance                           │ attached (command)
                         ┆                                            ├─ חוג״ד (pc) of the company
                         └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘    (medical guidance from מ״פ רפואה)
                                                                      ├─ מ״מ A1 ── medics (attached; medical guidance from the חוג״ד)
                                                                      ├─ מ״מ A2 ── medics
                                                                      └─ מ״מ A3 ── medics
Ambulance team: 1 pc + 1 physician or paramedic + 3 medics, belongs to מ״פ רפואה, sent by assignment.
```

Two kinds of line (owner, 2026-10-22): every medic is attached to a מ״מ and takes medical guidance from the company's חוג״ד; every חוג״ד is attached to a מ״פ חילוץ and takes medical guidance from מ״פ רפואה. מ״פ רפואה and the מ״פ חילוץ are on the same command level. In the data, a medic is placed in its מ״מ's platoon (`database/065`) and its company follows from the platoon.

- **Each rescue company** has one מ״פ חילוץ, one חוג״ד and three platoons, each led by a מ״מ, with its medics attached. The חוג״ד is the medical commander of that rescue company: it guides the company's medics and may assign any of them (from any of its platoons) to any site of the company or any site it belongs to, but no medic from another company or from the ambulance team (`database/065`). A medic still enters only sites it opened or was assigned to.
- **The ambulance team** (one חוג״ד, one physician or paramedic, three medics) is its own unit under מ״פ רפואה and goes where it is assigned.
- **A site belongs to at most one company, and to one platoon of it.** A site opened by a unit member belongs to the opener's unit (a מ״מ's site to its platoon). There are no drafts any more (D10, `database/064`): a medic's or paramedic's site takes the opener's company, and the company's חוג״ד or מ״פ חילוץ chooses its platoon from the incident-opened banner (`set_incident_platoon`). Until then every מ״מ of the company sees the banner (header fields only, `064d`); after it, only the chosen platoon's מ״מ, who can then enter the site. Since `065` a medic is attached to a platoon, so a medic's site normally takes that platoon at opening and only that platoon's מ״מ is informed; the choice is needed only for a medic with no platoon (for example one placed directly in a company). Company-level command can move any site; a מ״פ חילוץ can move a site between its own platoons.
- **Who sees what:** מ״פ רפואה, חמ״ל, admin, the physician and the paramedic see every site. A חוג״ד and a מ״פ חילוץ see their own company's sites; a מ״מ its own platoon's. Everyone also sees sites they opened, drafted or were assigned to. A medic still enters only sites it was assigned to or drafted.
- **Who manages units:** only company-level command (מ״פ רפואה, חמ״ל, physician, admin), from the "פלוגות ומחלקות — שיבוץ" panel on the CC dashboard: add rescue companies and the ambulance team, add platoons, place each person (a מ״מ in a platoon; a חוג״ד, מ״פ חילוץ, medic, paramedic or physician in a company), and set which unit works the current site. Every change is kept in an audit log.
- **Signed in, the dashboards use the real units.** מ״פ רפואה gets one tile per rescue company; a מ״פ חילוץ gets one tile per platoon of its company; חוג״ד, מ״מ and מ״פ חילוץ see their unit's name. Because only the active site is loaded, its patients count under that site's unit. A site with no unit shows under "ללא שיוך", never hidden. Local demo mode keeps the fictional PLT-A / PLT-B.

## PC can go hands-on

חוג״ד's server-side clinical write authority (`app.can_write_clinical_event()`, `ROLE_ALLOWED_EVENT_TYPES.pc`, `patients_insert`) has always matched medic's — the in-app read-only authorization matrix already documented this. What was missing was a client-side entry point: pc's dashboard had no button to create a new patient or reach the MSTART sweep/field workflow screen, so in practice pc could only treat patients already in its scope (via the shared `openPatient`/`openQuickVitals` path, which has never had a role check), not create new ones.

Fixed: pc's dashboard now has an explicit "טיפול ישיר / go hands-on" action offering the same "פצוע נוסף" quick-patient path and full MSTART/field-workflow screen medic uses (`startNewCasualtyInCurrentContext()`, `goTo('enroute')` — no new server logic, both already worked for any role). This stays additive, not a default: unlike medic/paramedic, pc still lands on its command dashboard by default (`startRoleDashboard()`'s auto-routing to the field screen is medic/paramedic-only) — pc goes hands-on by choice, when the platoon needs it, not as its primary mode.

## Physician and Paramedic — real server roles, cross-device conflict authority

V2.7's "Doctor / Paramedic" (senior clinical review: red/black patient review, death certification, response to חוג״ד/מ״פ רפואה requests) existed only as a client-side demo dashboard label, with no authenticated account backing it. V2.8 adds two real server roles, `physician` and `paramedic`, resolving that gap and giving F3 (cross-device concurrent-edit resolution, `docs/CONFLICT_RESOLUTION_DECISION.md`) the role-authority tie-break it needs.

**Physician** (`רופא`) has `מ״פ רפואה`'s full command-adjacent scope (incident/sector management, device presence, conflict-log and quarantine review, patient-identity write access) plus medic/pc-level clinical event write access, so a physician can actually participate in triage/status decisions rather than only reviewing them after the fact. Logs in through the existing "Doctor / Paramedic" dashboard.

**Paramedic** (`פראמדיק`) has the same field/clinical authority as physician — the same drugs and procedures, including confirming a high-risk clinical override (e.g. a pediatric medication dose outside the normal safe range) — with one exception: official death certification stays physician-only. Paramedic stays a field role otherwise, same patient-creation/vitals/treatment/triage-status write access and field workflow screen as medic, not physician's broader command-adjacent scope (incident/sector management, device presence, patient identity). In practice paramedic's clinical event-write list already matches medic's exactly (both get the same `CLINICAL_EVENTS`), so "same as physician" mostly shows up as a rank distinction in the tie-break below plus the `high_risk_override_insert` fix (`database/023`) rather than a new capability most of the time.

**Physician clinical death confirmation — real, not narrative.** A physician can tap a one-time "אשר מוות (קליני, לא רשמי)" action on any black/deceased patient from the physician dashboard, recording `PATIENT_DEATH_CONFIRMED` (`database/024`-`026`): who confirmed and when, on the `patients` row and in a dedicated `death_confirmations` audit table, both physician-only at the RLS layer (the table's own insert policy, *and* — the actual enforcement point, since the projection trigger is `SECURITY DEFINER` and would otherwise bypass that table's RLS — a physician-only carve-out on `events_insert_by_role` itself). This is deliberately **not** official/legal death certification, which stays entirely out of this repo's scope; it's a second, physician-exclusive clinical fact layered on top of the medic's existing field black-tag (`PATIENT_TRIAGED_EXPECTANT`), which every clinical role continues to set exactly as before. The pre-existing `doctor_death_cert` reinforcement-request flow is unrelated narrative UI, unchanged by this.

**Client-side, physician and doctor are one identity, not two.** Earlier builds mapped the server `physician` role onto a separate client dashboard key, `doctor`, as a reuse shortcut. That was later recognized as an unnecessary duplication of the same role and consolidated: the client now uses `physician` as the single key throughout (role config, labels, dashboard routing, the in-app Roles & Authorization matrix). `docs/AUTH_AND_ROLE_MODEL.md` has the full detail.

**Role-authority tie-break**: when two devices genuinely collide on the same patient field within a short window, the higher-ranked role wins: **admin > physician > paramedic > cc (מ״פ רפואה) > pc (חוג״ד) > medic** (admin added in `database/048`: admin may do everything). Every such override is logged and surfaced to command, never silent — see `docs/CONFLICT_RESOLUTION_DECISION.md` for the full mechanism.

## First Responder Quick Report

A deliberately minimal intake form, distinct from the medic's MSTART sweep:

- Fields: location/landmark, trapped (yes/no), tourniquet applied (yes/no, + limb if yes). RCC additionally selects which platoon the report belongs to.
- Produces a patient record with `triage: 'pending'` and `needsFullAssessment: true` — it explicitly does not assign a triage color. Clinical classification stays medic-only, consistent with V2.7's ticket contract ("How was the color set? MSTART automatic, manual, override, or deterioration update" — a first-responder report is none of these).
- Intended use: a trapped or unseen casualty gets a record and a location in the system the moment rescue finds them, instead of waiting for a medic to physically reach them before they exist in the incident picture at all.

## Roles table (additions to V2.7)

| Role | Owns | Explicitly excluded |
|---|---|---|
| RPC (מ״מ) | Tactical picture for own platoon; patient identity (name/description, for physical identification); recommended evacuation order for own platoon; site authority for own area; first-responder reports | Triage colour (priority urgent / not urgent only), tourniquet, vitals, treatment, mechanism; medical reinforcement/resupply requests |
| RCC (מ״פ חילוץ) | Tactical picture rolled up across own company's platoons; patient identity (name/description); recommended evacuation order across the company; site authority for own area; first-responder reports; rescue-company resupply visibility | Triage colour (priority urgent / not urgent only), tourniquet, vitals, treatment, mechanism; medical reinforcement requests |
| Physician (רופא) | מ״פ רפואה's full command-adjacent scope plus clinical event write access; senior review; real physician-only clinical death confirmation (`PATIENT_DEATH_CONFIRMED`, distinct from official/legal certification, which stays out of scope); top rank in the F3 conflict-authority tie-break | Creating new patient records (same restriction as מ״פ רפואה) |
| Paramedic (פראמדיק) | Same field/clinical authority as physician (drugs, procedures, high-risk override confirmation); same patient-creation/vitals/treatment/triage-status scope as medic otherwise; ranks above מ״פ רפואה in the F3 conflict-authority tie-break | Physician-only clinical death confirmation; physician's command-adjacent scope (incident/sector management, device presence, patient identity) |
| Admin | Full technical access: raw data, scenario load/clear, experiment export, version/sync checks | Not an operational command role — demo/test-running only, same as V2.7 |

## Authorization matrix

The full 10-role × 22-action matrix (all roles, all actions) lives in-app at the "Roles & Authorization" screen, generated from `ROLE_DEFS` / `AUTH_MATRIX` in `index.html`. This document covers the *why* behind the RPC/RCC/Admin columns; the matrix itself is the source of truth for the *what*, since duplicating a growing table into a second document is exactly the kind of copy that drifts (see the `src/domain/rules.js` vs. inlined-copy drift noted in [`MULTI_AGENT_DEV_PLAN.md`](MULTI_AGENT_DEV_PLAN.md)). Physician and paramedic each have their own dedicated matrix column now, derived from their real, already-shipped RLS/event-type authority rather than guessed — the previous state (physician aliasing a merged "doctor" column, paramedic entirely absent from the matrix) is resolved.

Every row, including "Confirm patient death," shows `admin:'yes'` — admin's blanket bypass is a deliberate, explicit product decision (not just the Edge Function default): admin exists to verify the system works from the inside and read the logs, so it should never be the one role blocked from exercising any real action. `database/026`'s initial `PATIENT_DEATH_CONFIRMED` carve-out briefly left admin blocked (an oversight, caught by live testing rather than assumed correct) and was fixed in `database/027_events_death_confirmed_admin_bypass.sql` to restore admin alongside physician.
