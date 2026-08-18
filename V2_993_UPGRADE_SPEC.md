You are working on my RESCUE / Medical C5 System for SAR.



Repository:

https://github.com/Raanank10/Medical-C5-System-For-SAR



Goal:

Create Demo V2.993 as a MEDIC SPEED + CC HERO DASHBOARD + LOGISTICS ACTION BOARD + DEMO POLISH patch.



Current app:

The current uploaded demo is labeled “Demo 2.992V”.

APP\_VERSION may be “2.99.2”.

Before editing, verify all actual version labels in the code.



This is not a rewrite.

This is not backend/auth/sync work.

This is not database work.

Do not delete legacy code.

Do not break MSTART sweep.

Do not break tourniquet logic.

Do not break multiple-tourniquet logic.

Do not break failed-tourniquet logic.

Do not break black/death-certification flow.

Do not break PC dashboard.

Do not break CC dashboard.

Do not break logistics.

Do not break AAR.

Do not remove old startNewPatient / guardedNewPatient / step1-step8 yet.



Core product principle:

The medic treats first. The app quietly builds the command picture from every small action.



Product goal:

V2.992 is a strong system demo.

V2.993 should become a commander-grade story demo.



Medic:

Faster, fewer distractions, one clear next action.



PC:

Keep the existing task-board strength.



CC:

Hero-first decision dashboard, not a data dump.



Logistics:

Action cards: what to send, where, why, urgency, and recommended action.



Demo:

One golden thread from Medic → PC → CC → Logistics → AAR.



────────────────────────────

0\. Mandatory safe process

────────────────────────────



Before changing files:



1\. Analyze and report:



\* current APP\_VERSION

\* all visible version labels

\* current renderMstartSweep structure

\* current visible medic MSTART choices

\* current same-zone FAB behavior

\* current CC dashboard render order

\* current CC hero dashboard sections

\* current logistics dashboard sections

\* current localStorage keys used by the app

\* current step1-step8 references

\* current startNewPatient / guardedNewPatient call sites

\* current event/treatment names for tourniquet, pressure dressing, hemostatic gauze if present

\* current inventory/logistics state structure



2\. Do not apply changes until approval.



First response must include:



\* findings

\* proposed minimal diff

\* smoke test plan

\* risk analysis

\* rollback plan

\* “Waiting for approval.”



3\. After approval:



\* apply one batch at a time

\* run syntax/static checks after each batch

\* do not touch unrelated code



Required checks:



\* node --check on extracted inline JS if possible

\* git diff --check

\* python scripts/check\_repo.py if available

\* node tests/domain-rules.test.js if available

\* manual browser smoke checklist if automated UI tests do not exist



────────────────────────────



1\. Version-label cleanup

&#x20;  ────────────────────────────



Current visible format may include:



\* “Demo 2.992V”

\* “ROLE // 2.992V”

\* “Role-Based Medical Command System 2.992V”



Change to clean version label:



Target:

Demo V2.993



Update consistently:



\* APP\_VERSION = "2.99.3"

\* demo kicker: "Demo V2.993"

\* role header: "ROLE // V2.993"

\* role system strip: "Role-Based Medical Command System V2.993"

\* role context line

\* AAR/version text if present

\* README/demo notes only if they exist in the same repo and are clearly versioned



Acceptance:



\* No visible “2.992V” remains.

\* No mixed version labels remain.

\* No accidental V3.0 bump.



────────────────────────────

2\. Medic speed: make MSTART casualty card faster

────────────────────────────



Current MSTART card is good, but still slightly too much cognitive load.



Keep this order:



1\. Top triage band

2\. M — דימום מסכן חיים

3\. Walking

4\. Breathing yes/no

5\. Conditional airway prompt

6\. Pulse/perfusion

7\. AVPU

8\. Mobility/trapped

9\. Tourniquet cards

10\. Assessment debt

11\. Details/override/body map

12\. Sticky פצוע הבא / סיים סריקה



Make these changes:



A. Make “פצוע הבא” visually dominant



In the sticky bottom actions:



\* “פצוע הבא” should be the primary/larger/default action.

\* “סיים סריקה” should remain visible but secondary.



Suggested layout:



\* 65% width: פצוע הבא

\* 35% width: סיים סריקה



Acceptance:

After marking one casualty, the medic’s eye goes immediately to “פצוע הבא”.



B. Collapse override controls



The current detailed MSTART explanation / override controls should be collapsed by default.



Label:

“עקיפה ידנית / פירוט מיון”



Inside:



\* current triage explanation

\* override reason input

\* red/yellow/green/black override buttons



Do not remove override ability.

Only hide it from the primary sweep surface.



Acceptance:

The medic does not see manual override controls unless deliberately opened.



C. Keep body map collapsed



Body map / injury location / extended assessment must remain collapsed at the bottom.



Label:

“פציעות / מיקום בגוף / הערכה מורחבת”



Acceptance:

Body map is never required during MSTART.



D. Remove visible uncertainty options



Visible breathing choices must remain only:



\* נושם

\* לא נושם



After airway:



\* כן

\* לא



Visible mobility/trapped choices:



\* לא לכוד / ניתן להזזה

\* לכוד / לא ניתן להזזה



Optional under “עוד”:



\* אין גישה להערכה



Do not show as primary choices:



\* לא בטוח

\* לא ידוע

\* unknown

\* unsure



Internal null/unknown states may remain as “not assessed yet”.



Acceptance:

Primary medic card has no uncertainty buttons.



────────────────────────────

3\. Do not let AVPU overwrite breathing=no

────────────────────────────



Rule:

AVPU may suggest breathing, but must never silently overwrite a deliberate breathing=no.



Behavior:



\* If AVPU=A or AVPU=V and breathing is null:



&#x20; \* show note:

&#x20;   “AVPU A/V — כנראה נושם, אשר נשימה”

&#x20; \* optionally highlight breathing=yes as suggested

&#x20; \* do not silently commit breathing=yes unless there is a separate helper state such as breathingAssumption



\* If AVPU=A/V and breathing=no:



&#x20; \* do not overwrite breathing=no

&#x20; \* show contradiction warning:

&#x20;   “AVPU A/V סותר ‘לא נושם’ — בדוק מחדש”



\* If AVPU=P/U:



&#x20; \* do not infer breathing

&#x20; \* show:

&#x20;   “בדוק נשימה בנפרד”



Acceptance:

AVPU never erases breathing=no.



────────────────────────────

4\. Medic speed: strengthen same-zone fast add

────────────────────────────



Current same-zone FAB exists. Strengthen it, do not rebuild it from scratch unless missing.



Button:

“+ פצוע | אותו אזור”



Rules:



\* Appears after close/save casualty marker.

\* Opens a new casualty marker in same site/zone.

\* Disappears outside medic sweep.

\* Disappears when opening PC/CC/logistics/AAR.

\* Times out after 90 seconds.

\* Must not create duplicate casualties accidentally.

\* Must not cover sticky פצוע הבא / סיים סריקה.

\* In field mode, it should be large enough for one-handed use.



Acceptance:

Medic can add the next casualty in one tap.



────────────────────────────

5\. Event-derived logistics telemetry

────────────────────────────



Do not add manual inventory controls to the medic’s primary MSTART surface.



The medic records treatment.

The app derives logistics impact.



Rules:



\* Applying a tourniquet decrements tourniquet stock by 1.

\* Applying a second tourniquet decrements tourniquet stock by 1 again.

\* Marking a tourniquet ineffective does NOT restore stock.

\* Canceling a tourniquet entry as “טעות הקלדה” SHOULD reverse the stock deduction if that deduction was already applied.

\* Applying pressure dressing decrements pressure dressing stock by 1.

\* Applying hemostatic gauze decrements hemostatic gauze stock by 1 only if there is an explicit treatment action for hemostatic gauze.

\* Manual triage override must NOT decrement stock.

\* No logistics popup may appear during active MSTART sweep.



Use existing treatment/action/event names where possible.

Do not invent new event names before searching existing code.



Acceptance:

Medic actions silently create logistics telemetry without adding inventory work to the medic UI.



────────────────────────────

6\. Demo logistics thresholds

────────────────────────────



Use demo thresholds only.

Do not describe them as doctrine.



Tourniquets:



\* critical: <= 2

\* warning: <= 5

\* recommended minimum per PC truck: 12



Pressure dressings:



\* critical: <= 4

\* warning: <= 8



Hemostatic gauze:



\* critical: <= 2

\* warning: <= 5



If existing thresholds already exist, report them first and propose whether to adjust.



Acceptance:

CC and Logistics dashboards generate predictable low-stock recommendations.



────────────────────────────

7\. Logistics action board upgrade

────────────────────────────



Logistics should not interrupt medic.



Top logistics section:

“משימות לוגיסטיקה עכשיו”



Each logistics card should show:



\* item

\* source

\* destination

\* urgency

\* clinical reason

\* recommended action

\* action buttons if current app already supports request statuses



Examples:



1\. “חסמים נמוכים — רכב חוג״ד א׳”

&#x20;  “2 חסמים נותרו · 2 פצועים עם דימום פעיל”

&#x20;  “המלצה: העבר 10 חסמים מרכב מחלקה ב׳”



2\. “גזה המוסטטית חסרה”

&#x20;  “בקשת ציוד פתוחה מעל 4 דקות”

&#x20;  “המלצה: שלח מהמחסן הפלוגתי / הסלם למ״פ”



Acceptance:

Logistics officer knows what to send, where, and why.



────────────────────────────

8\. CC hero dashboard must be first and dominant

────────────────────────────



Current CC dashboard may already have a hero section:

“מ״פ רפואה — החלטות עכשיו”

“מה להזיז, לאן, ולמה”



Make it truly dominant.



When role === "cc":

The first visible content after the header should be:



1\. CC hero dashboard

2\. Top 3 recommendations

3\. Decision cards

4\. Platoon comparison table

5\. Quick CC actions

6\. Only then metrics/details/lists



Do not show generic role metrics above the hero dashboard for CC.



Required title:

“מ״פ רפואה — החלטות עכשיו”



Required subtitle:

“מה להזיז, לאן, ולמה”



Hero decision cards:



A. Move medic

Example:

“העבר חובש ממחלקה ב׳ למחלקה א׳”

Reason:

“מחלקה א׳: 6 פצועים · 2 אדומים · 3 לכודים · 2 חסמים”

Action:

“סמן כהחלטה”



B. Assign paramedic / doctor

Example:

“שייך פראמדיק לפצוע אדום עם חסם פעיל”

or:

“שייך רופא לבקשת קביעת מוות”

Action:

“שייך רופא / פראמדיק”



C. Evacuation bottleneck

Example:

“2 אדומים ממתינים לפינוי מעל 8 דקות”

Action:

“הסלם פינוי”



D. Equipment bottleneck

Example:

“חסמים נמוכים ברכב חוג״ד א׳ · 2 דימומים פעילים”

Action:

“בקש לוגיסטיקה / העבר ציוד”



E. Death-certification queue

Example:

“חשד לנפטר · ממתין לרופא · לא דחוף”

Action:

“שייך רופא כשבטוח לגישה”



Acceptance:

CC understands the top 3 decisions in 5 seconds without scrolling.



────────────────────────────

9\. CC dashboard: reduce noise below hero

────────────────────────────



After the hero dashboard, collapse lower sections by default where appropriate.



Keep visible:



\* platoon comparison

\* open resource requests

\* evacuation bottlenecks

\* death-cert queue

\* equipment bottlenecks



Collapse or move lower:



\* raw patient list

\* generic responsibilities

\* generic objects

\* generic action lists

\* long status matrices



Acceptance:

CC screen does not feel like a data dump.



────────────────────────────

10\. PC remains task-board focused

────────────────────────────



Do not weaken PC.



PC top section should remain:

“משימות חוג״ד עכשיו”



Must include:



\* red without full vitals

\* active tourniquet

\* ineffective tourniquet / bleeding continues

\* trapped red

\* sweep completed without monitoring assignment

\* silent/overloaded medic

\* suspected deceased waiting doctor

\* evacuation status missing



Acceptance:

PC knows next 3 actions in under 10 seconds.



────────────────────────────

11\. Safe scoped demo reset

────────────────────────────



Do not use localStorage.clear().



Before implementing reset:



\* search all localStorage.getItem/setItem/removeItem references

\* list actual app-owned storage keys

\* identify which keys are demo state

\* preserve unrelated preferences where possible



Create:

DEMO\_KEYS\_TO\_PURGE = \[actual verified demo-state keys only]



The reset action should clear:



\* demo patients

\* demo requests

\* demo logistics state

\* demo AAR/timeline

\* demo alerts

\* active scenario state

\* role scenario flags



Do not clear:



\* unrelated browser storage

\* non-demo preferences

\* future auth/session keys

\* field-mode preference unless explicitly part of demo reset



Add confirmation:

“פעולה זו תנקה את נתוני הדמו בלבד. להמשיך?”



Acceptance:

Reset returns the demo to a clean state without destroying unrelated settings.



────────────────────────────

12\. Omni-role golden-thread scenario

────────────────────────────



Add or strengthen:

“טען תרחיש Omni-Role”



The scenario must create one linked story across roles.



Core patient:

P-002 / TMP-002

Sector A / מחלקה א׳

Triage: RED

Tourniquet: TQ-001 ineffective / bleeding continues

Second tourniquet: TQ-002 added above previous if supported

Full vitals: missing

Evacuation: delayed / pending



Medic reflection:



\* red patient with active/ineffective tourniquet

\* second tourniquet if supported

\* missing full vitals



PC reflection:



\* alert: “פצוע אדום — חסם לא יעיל — מחלקה א׳”

\* task: “בדוק דימום / מדדים / פינוי / פראמדיק”

\* optional alert: medic silent or overloaded



CC reflection:



\* recommendation: “העבר חובש בכיר/פראמדיק למחלקה א׳”

\* reason: overloaded platoon, red patient, ineffective tourniquet, evacuation delay

\* evacuation bottleneck card



Logistics reflection:



\* Platoon A / PC truck low on tourniquets

\* Platoon B has surplus

\* recommendation: “העבר 10 חסמים מרכב מחלקה ב׳ לרכב חוג״ד א׳”



AAR reflection:



\* time to first tourniquet

\* failed tourniquet

\* time from ineffective TQ to second TQ

\* missing full vitals

\* evacuation delay

\* logistics shortage generated from treatment action



Acceptance:

One loaded scenario demonstrates Medic → PC → CC → Logistics → AAR without manual setup.



────────────────────────────

13\. Lightweight drill-down / focus filter

────────────────────────────



Do not build a new navigation system.



When user clicks a PC/CC/logistics recommendation card:



\* set selectedFocus:

&#x20; {

&#x20; role,

&#x20; type,

&#x20; id,

&#x20; label

&#x20; }



Show focus banner:

“מיקוד: \[label]”



Filter existing lower panels only:



\* patients

\* medics

\* requests

\* logistics

\* evacuation



Add:

“נקה מיקוד”



Do not hide the hero dashboard.

Do not navigate away from the dashboard.

Do not create a new matrix page.



Acceptance:

Commander can inspect the recommendation context without losing the main dashboard.



────────────────────────────

14\. Commander 60-second demo

────────────────────────────



Add or strengthen one button from launcher:



“הצג תדריך מ״פ / חוג״ד ב־60 שניות”



Sequence:



1\. Medic sets site/zone.

2\. Medic creates walking casualty → green.

3\. Medic creates red casualty with tourniquet.

4\. Medic marks bleeding continues and adds second tourniquet if demo data supports it.

5\. Medic completes sweep.

6\. PC task board opens.

7\. CC hero dashboard opens.

8\. Logistics action board opens if shortage exists.

9\. AAR shows what paper missed.



Acceptance:

A commander understands the product without exploring manually.



────────────────────────────

15\. Legacy flow isolation

────────────────────────────



Do not delete:



\* startNewPatient

\* guardedNewPatient

\* startMedicTreatmentNow

\* savePatient

\* saveImmediateCasualtyAndContinue

\* step1-step8

\* black/death-certification paths

\* localStorage recovery



But hide/demote legacy from primary medic demo path.



Actions:



\* Any visible “+ פצוע נוסף” that calls startNewPatient should be changed to:

&#x20; “פצוע נוסף באזור הזה”

&#x20; and should route to the current MSTART/sweep context.

\* Any old “טיפול / הערכה מלאה” action in medic primary mode should move under:

&#x20; “הערכה מורחבת”

\* Command/logistics/AAR shortcuts should not appear in the medic’s primary operational surface.



Add comment above old flow:

LEGACY\_FULL\_ASSESSMENT\_DO\_NOT\_DELETE\_WITHOUT\_TESTS



Acceptance:

Old flow exists safely but does not confuse the demo.



────────────────────────────

16\. Do not add embedded micro-videos inside operational panels

────────────────────────────



Do not add pulsing video icons inside:



\* MSTART card

\* medic sweep

\* PC task board

\* CC hero dashboard

\* logistics action board



Reason:

This is an operational command demo, not a tutorial product.



If help/demo guidance is needed, add it only to:



\* launcher

\* “60-second commander demo”

\* README/demo notes

\* optional non-operational help section



Acceptance:

No video overlays or video icons are introduced into tactical operational screens.



────────────────────────────

17\. Smoke tests

────────────────────────────



Add/update smoke checklist:



1\. App renders Demo V2.993 consistently.

2\. Medic role opens.

3\. En-route site/zone works.

4\. MSTART sweep opens.

5\. New casualty marker works.

6\. No visible breathing unsure button.

7\. No visible trapped unknown button.

8\. Breathing=yes works.

9\. Breathing=no opens airway prompt.

10\. After airway, only yes/no are visible.

11\. AVPU=A/V does not overwrite breathing=no.

12\. Walking auto-green still works.

13\. Contradiction cancels auto-green.

14\. Tourniquet limb buttons work.

15\. Multiple tourniquets still work.

16\. Failed tourniquet still works.

17\. Cancel mistaken tourniquet entry reverses stock deduction if previously deducted.

18\. No supply popup appears during MSTART.

19\. Same-zone fast add works.

20\. Complete sweep works.

21\. PC task board renders.

22\. CC hero dashboard renders first for CC role.

23\. CC platoon comparison renders.

24\. Logistics action board renders.

25\. Event-derived logistics recommendations render.

26\. Safe scoped reset works and does not use localStorage.clear().

27\. Omni-role scenario loads.

28\. Omni-role scenario appears correctly in Medic, PC, CC, Logistics, and AAR.

29\. Lightweight focus filter works and can be cleared.

30\. AAR renders.

31\. Black/death-certification flow works.

32\. Old startNewPatient still exists.

33\. step1-step8 references still exist but are hidden from primary medic flow.

34\. No JS syntax errors.



Run:



\* node --check on extracted JS if available

\* git diff --check

\* python scripts/check\_repo.py if available

\* node tests/domain-rules.test.js if available

\* manual browser smoke if automated UI tests are unavailable



────────────────────────────

18\. Output before applying changes

────────────────────────────



First response must include:



1\. Current version labels found.

2\. Current medic sweep structure found.

3\. Current CC dashboard render order found.

4\. Current same-zone FAB behavior found.

5\. Current logistics/inventory model found.

6\. Current localStorage keys found.

7\. Current legacy 8-step/full-assessment references found.

8\. Proposed minimal diff.

9\. Smoke test plan.

10\. Risk analysis.

11\. Rollback plan.

12\. “Waiting for approval.”



Do not apply changes until approval.



