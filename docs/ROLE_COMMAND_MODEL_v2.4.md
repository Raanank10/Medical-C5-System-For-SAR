# Role-Based Medical Command Model V2.4

V2.4 keeps the prototype as a role-based medical command system and sharpens the medic timeline: transit preparation, MSTART triage sprint, then monitoring and treatment hold until rescue. חובש starts care in a current zone, חוג״ד sees the platoon picture, and מ״פ רפואה commands company-level medical resources.

## V2.4 Tactical Flow

The medic workflow is split into two operational phases:

1. `מסך תנועה — הכנת זירה`
   - Optional ETA.
   - Site and zone context.
   - Initial evacuated counts by severity.
   - Report source: civilian, fire/rescue, MDA, police, or other.
   - Data is visible to חוג״ד, חמ״ל, and מ״פ רפואה and remains editable later.

2. `MSTART — סריקה מהירה`
   - Dedicated sweep screen, not a full patient form.
   - New temporary casualty marker in current zone.
   - Life-saving actions stay inside the binary triage screen.
   - A/V/P implies the casualty is breathing.
   - The casualty is saved and the medic returns to the current-zone loop.
   - End-of-zone sweep creates `MSTART_SWEEP_COMPLETED` for חוג"ד.

3. `הפצועים שלי — מעקב מדדים`
   - Medic sees assigned casualties sorted by urgency.
   - Full vitals are taken during monitoring and treatment hold.
   - Blood pressure is field-estimated by radial/carotid/absent pulse plus strong/weak quality.
   - Deterioration index is shown on patient tiles.
   - Later vitals create deterioration/priority recommendations; they do not silently redo MSTART.

## Sweep Marker Data

Sweep casualties are intentionally incomplete:

```js
{
  id: "TMP-014",
  siteId: "SITE-A",
  zone: siteData.currentZone,
  phase: "mstart_sweep",
  identityStatus: "unknown",
  assignedMedicId: currentUser.id,
  mstart: {
    walking: null,
    breathing: null,
    perfusion: null,
    avpu: null,
    trapped: null,
    color: null
  },
  lifeSavingTreatments: [],
  assessmentDebt: [
    "full_vitals",
    "identity",
    "evacuation_status",
    "full_injury_assessment"
  ]
}
```

- What is my situation?
- What am I responsible for?
- Which alerts require my action?
- Which objects do I own?
- What can I request, assign, or escalate?

All demo names are synthetic.

## Core Objects

| Object | Owner Flow |
|---|---|
| Site / מוקד | Medic may draft. חוג״ד confirms/edits/assigns. מ״פ רפואה sees confirmed sites and severe draft sites. |
| Patient / פצוע | Medic creates and updates. חוג״ד reallocates inside platoon. מ״פ רפואה reallocates across platoons. Duplicate merges must preserve event history. |
| Resource request / בקשת תגבור | חוג״ד creates. מ״פ רפואה commands medical resources directly and can approve, deny, redirect, assign, or resolve. |
| Resupply request / בקשת השלמת ציוד | Medic can request missing equipment only. חוג״ד handles PC truck stock first. מ״פ רפואה/logistics see escalated shortages and bottlenecks. |
| Alert / התראה | Alert has owner role, audience, severity, required action, escalation rule, and linked object. |

## Logistics / Resupply Model

Medics do not manage logistics. They only document supply use through treatment actions or tap `חסר לי ציוד`.

Local medic kit demo state:

```js
{
  tourniquets: 3,
  pressureDressings: 4,
  hemostaticGauze: 2,
  airwayEquipment: 2,
  ivKits: 1,
  blankets: 2,
  batteryPacks: 1
}
```

PC truck stock is the first resupply node before company escalation:

```js
{
  tourniquets: 20,
  pressureDressings: 30,
  hemostaticGauze: 15,
  airwayEquipment: 10,
  ivKits: 8,
  blankets: 25,
  batteryPacks: 6
}
```

Rules:

- Treatment never blocks because stock is zero.
- Life-saving actions create `SUPPLY_CONSUMED` and append-only inventory ledger events.
- Low/empty medic stock creates a warning chip and a fast request path to חוג״ד.
- חוג״ד can approve/send/mark collected/delivered from the truck.
- If the truck lacks stock, the request escalates to מ״פ רפואה / logistics.
- מ״פ רפואה sees shortages affecting active care and cross-platoon bottlenecks, not every small request.

## Roles

### Medic

Patient-level operator. Owns assigned patients, vitals, treatment, trapped/not-trapped status, assessment debt, and patient updates. A medic can mark a field status of `חשד לנפטר / לא בר הצלה`, but this is not death certification.

When a medic saves a black/not-salvageable patient, the app automatically creates a non-emergency doctor certification request.

### חוג״ד / חפ״ק רפואי

Platoon-level medical commander. Owns medics, patients, site drafts, same-platoon allocation, evacuation prioritization, stale data follow-up, duplicate suspicion, and doctor/paramedic requests.

חוג״ד can request doctor or paramedic directly.

### מ״פ רפואה

Company-level medical resource commander. Owns cross-platoon allocation, all open requests, doctor/paramedic queue, death-certification queue, logistics shortages affecting care, and evacuation bottlenecks.

מ״פ רפואה commands medical resources directly. The V2.4 demo should make this feel like a company resource command center, not a larger platoon dashboard.

### Doctor / Paramedic

Senior medical review queue. Owns severe reviews, treatment guidance requests, pediatric severe cases, unclear black/deceased status, and official death certification workflow.

### Logistics Officer

Owns medical stock, equipment requests, burn rate, shortages, and resupply status. Clinical context should be limited to what is required for logistics decisions.

### Chamal / Operator / Observer

Owns control-room picture quality: sync, duplicates, external report conflicts, unassigned objects, pending requests, event timeline, and AAR/export support.

### Admin / Demo Controller

Demo and experiment-only role for loading, clearing, exporting, and controlling synthetic scenarios.

## Resource Request Types

V2.4 does not include a generic stretcher-team request type; evacuation support is handled through medical evacuation coordination.

Personnel:

- `חובש נוסף`
- `2+ חובשים`
- `פראמדיק`
- `רופא — טיפול / החלטה רפואית בכירה`
- `רופא — קביעת מוות / אישור מוות`

Evacuation:

- `פינוי דחוף`
- `פינוי רגיל`
- `יעד פינוי / תיאום פינוי`

Equipment:

- `חסמי עורקים`
- `גזה המוסטטית`
- `ציוד נתיב אוויר`
- `ציוד עירוי / נוזלים`
- `שמיכות / מניעת היפותרמיה`

## Allocation Events

Within platoon:

```js
{
  type: "PATIENT_REASSIGNED_WITHIN_PLATOON",
  patientId,
  fromMedicId,
  toMedicId,
  assignedByRole: "pc",
  assignedByName,
  reason,
  timestamp
}
```

Between platoons:

```js
{
  type: "PATIENT_REASSIGNED_BETWEEN_PLATOONS",
  patientId,
  fromPlatoonId,
  toPlatoonId,
  assignedByRole: "cc",
  assignedByName,
  reason,
  timestamp
}
```

## Death Certification Workflow

Medic action:

`חשד לנפטר / לא בר הצלה`

System action:

`DOCTOR_DEATH_CERTIFICATION_REQUESTED`

The app text must make clear that the medic is recording field status, not making official death certification. The doctor owns final certification.

Visible V2.4 demo chain:

1. Medic marks `חשד לנפטר / לא בר הצלה`.
2. App states: `זה אינו אישור מוות רשמי`.
3. System automatically opens `בקשת רופא לא דחופה`.
4. חוג״ד sees the request as pending.
5. מ״פ רפואה sees it in the doctor-resource queue.
6. Doctor / paramedic view sees it as a certification task.

## Demo V2.4 Launcher Path

Recommended demo path:

- `חובש — התחלת טיפול`
- `חוג״ד — תמונת מצב`
- `מ״פ רפואה`

Advanced views:

- `AAR — מה למדנו`
- `רופא / פראמדיק`
- `לוגיסטיקה`
- `חמ״ל`

## Medical Handover Wording

The UI should explain MIST as `מסירת מצב רפואי לפינוי`: a short handover containing mechanism, injuries, signs, and treatment. The Hebrew-facing command should not look like another form; it should read as a field handoff action.
