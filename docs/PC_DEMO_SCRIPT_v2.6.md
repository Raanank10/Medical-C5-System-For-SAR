# Medical Command Demo Script V2.6

Purpose: show a חוג״ד and מ״פ רפואה how the prototype reduces operational fog during a SAR medical incident.

Recommended length: 7-10 minutes.

## Demo Setup

Open `index.html` in a browser. Use a mobile-sized browser window first, then switch through the V2.6 launcher path.

## V2.6 First Story

Show the medic timeline as two tactical phases:

1. `מסך תנועה — הכנת זירה`
   The medic enters site, optional ETA, current zone, expected casualties, and initial evacuated counts while moving to the incident.

2. `MSTART — סריקה מהירה`
   The medic opens a dedicated sweep screen, taps `פצוע נוסף באזור הזה`, sees life-saving actions first, marks one walking casualty and watches the app auto-fill green, then marks another casualty and applies a tourniquet.

3. `ציוד נצרך`
   The tourniquet starts a timer, decrements the medic kit, and opens the supply-used sheet. The medic can confirm, cancel, change quantity, or ask חוג"ד for resupply.

4. `הפצועים שלי — מעקב מדדים`
   The medic presses `סיימתי סריקת MSTART באזור הזה`, then returns to the monitoring queue, takes full vitals, watches trend flags, and records treatment until rescue.

5. Logistics/resupply by action
   The medic applies a tourniquet. The app starts the tourniquet timer, records `SUPPLY_CONSUMED`, decrements the medic kit, and shows a low/empty warning without blocking care. The medic can tap `חסר לי ציוד` and request resupply in under 10 seconds.

6. חוג"ד
   Open חוג"ד and show `סריקות MSTART פעילות / הושלמו`: medic, zone, casualty counts, trapped, tourniquets, airway interventions, missing full vitals, and action buttons.
   Then show `השלמות ציוד מהחובשים`: the PC truck is the first source, with approve/send/collected/delivered/escalate actions.

7. מ״פ רפואה
   Show that the company commander sees only truck shortages and escalated bottlenecks, not every small bandage request.

8. חוג"ד assessment debt
   Show the new debt board: MSTART complete but no full vitals, unknown identity, missing evacuation status, tourniquet limb not completed, and reassessment gaps. This is the part a notebook cannot maintain reliably.

9. מ״פ רפואה resource board
   Show `תמונת משאבים פלוגתית`: overloaded platoons, delayed paramedic/doctor requests, death-certification queue, evacuation bottlenecks, and cross-platoon allocation suggestions.

Recommended demo path:

1. `חובש — התחלת טיפול`
2. `חוג״ד — תמונת מצב`
3. `מ״פ רפואה`

Advanced views:

- `AAR — מה למדנו`
- `רופא / פראמדיק`
- `לוגיסטיקה`
- `חמ״ל`

Suggested framing:

> "This is not trying to replace doctrine or radio. It is a second layer of operational memory: every patient, every timer, every handover, and every alert in one shared picture."

## Two-Minute Logistics Path

1. חובש מזין מוקד/אזור בדרך.
2. חובש מתחיל סריקת MSTART.
3. חובש מסמן פצוע הולך.
4. App auto-fills breathing=yes, AVPU=A, pulse present, not trapped, green.
5. חובש מסמן פצוע נוסף ומניח חסם.
6. App starts tourniquet timer and opens `ציוד נצרך`.
7. חובש מבקש השלמת חסמים.
8. חוג"ד sees sweep, tourniquet, missing vitals, and resupply request.
9. חובש מסיים סריקה.
10. חובש moves to monitoring queue for full vitals.
11. מ״פ רפואה sees only company-level resource bottlenecks.
12. AAR shows actions and gaps.

## Storyline

### 1. Start With The Field Problem

Ask the חוג״ד:

- How many casualties are in the building right now?
- Which are red?
- Which floor are they on?
- Who has a tourniquet running?
- Which medic has not reported recently?
- What has already been handed over?

Then explain: the app is designed so those answers are created as a byproduct of the medic workflow.

### 2. Medic Starts In Transit Prep

Show `מסך תנועה — הכנת זירה`.

Emphasize:

- works in Hebrew RTL
- optimized for fast field capture
- no dependency on network before the medic continues working
- draft incident support exists for zero-command-connectivity moments
- initial evacuated/self-evacuated counts can be recorded without creating green patient records

### 3. Register A Patient By Action

Use the immediate care grid:

- CAT tourniquet
- airway opening
- pressure bandage
- quick binary casualty state

Explain the design principle: the medic is not "writing a report"; they are doing the field action and the system records the operational state.

### 4. Show Time-Critical Watchdogs

Point to:

- reassessment timer
- deterioration indicator
- tourniquet context
- Golden Hour / crush-risk concept from the spec
- Dead Man's Switch concept for silent medics

Message:

> "The חוג״ד does not need to remember every timer manually. The system watches the clocks."

### 5. Switch To חוג״ד View

Show:

- total patients by triage
- active alerts
- site tabs
- medics in the collapse
- extracted/self-evacuated casualty counter
- external reports
- commander-level picture

Message:

> "This answers the question that started the project: how many casualties do we have, where are they, and what needs command attention right now?"

### 6. Show מ״פ רפואה Resource Command

Show:

- active platoons
- platoon load comparison
- overloaded platoons
- open חוג״ד requests
- doctor/paramedic queue
- death-certification queue
- available medical resources
- cross-platoon allocation suggestions
- evacuation bottlenecks
- equipment shortages affecting treatment

### 7. Show Death-Certification Chain

Use the launcher action `הדגם שרשרת אישור מוות`.

Explain:

1. Medic marks `חשד לנפטר / לא בר הצלה`.
2. App states this is not official death certification.
3. System opens a non-emergency doctor request.
4. חוג״ד sees it as pending.
5. מ״פ רפואה sees it in the doctor-resource queue.
6. Doctor view sees the certification task.

### 8. Explain Medical Handover

Use the patient detail action `מסירה רפואית למד״א`.

Explain that MIST is shown as `מסירת מצב רפואי לפינוי`: mechanism, injuries, signs, and treatment. It is a short evacuation handoff, not another report form.

### 9. End With AAR

Explain that every action is an event, so after the incident the system can produce:

- timeline
- triage overrides
- time to first vitals
- reassessment compliance
- handover timing
- supply usage
- command notes

Show the analytics package if time allows.

## MVP Success Criteria

For a real MVP demo, success is not "production-ready." Success is whether a חוג״ד / מ״פ רפואה says:

- "I understand the field problem this solves."
- "I can see how this would help me command."
- "The medic workflow is fast enough to be believable."
- "The dashboard gives me a better picture than radio memory alone."
- "I can name what would need to change before field testing."

## Questions To Ask The חוג״ד / מ״פ רפואה

- Which screen would you want first during an event?
- Which alert would be most useful and which would be noise?
- Who should be allowed to approve a draft incident?
- What information would you need before confirming site clear?
- Would medics realistically enter this amount of data under pressure?
- What should be visible to חוג״ד but hidden from medics?
- What would make this unacceptable operationally?

## Boundaries

Be explicit:

- prototype only
- no real patient-identifiable data
- not a certified medical device
- not replacing MDA, doctrine, radio, or command procedure
- meant to explore workflow, data capture, and command visibility
