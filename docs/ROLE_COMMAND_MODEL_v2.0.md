# Role-Based Medical Command Model v2.0

v2.0 changes the prototype from a shared dashboard with filters into a role-based medical command system. Every role starts from the same logic:

- What is my situation?
- What am I responsible for?
- Which alerts require my action?
- Which objects do I own?
- What can I request, assign, or escalate?

All demo names are synthetic.

## Core Objects

| Object | Owner Flow |
|---|---|
| Site / מוקד | Medic may draft. Medical PC confirms/edits/assigns. Medical CC sees confirmed sites and severe draft sites. |
| Patient / פצוע | Medic creates and updates. PC reallocates inside platoon. CC reallocates across platoons. Duplicate merges must preserve event history. |
| Resource request / בקשת תגבור | PC creates. CC commands medical resources directly and can approve, deny, redirect, assign, or resolve. |
| Alert / התראה | Alert has owner role, audience, severity, required action, escalation rule, and linked object. |

## Roles

### Medic

Patient-level operator. Owns assigned patients, vitals, treatment, trapped/not-trapped status, assessment debt, and patient updates. A medic can mark a field status of `חשד לנפטר / לא בר הצלה`, but this is not death certification.

When a medic saves a black/not-salvageable patient, the app automatically creates a non-emergency doctor certification request.

### Medical PC

Platoon-level medical commander. Owns medics, patients, site drafts, same-platoon allocation, evacuation prioritization, stale data follow-up, duplicate suspicion, and doctor/paramedic requests.

PC can request doctor or paramedic directly.

### Medical CC

Company-level medical resource commander. Owns cross-platoon allocation, all open requests, doctor/paramedic queue, death-certification queue, logistics shortages affecting care, and evacuation bottlenecks.

CC commands medical resources directly.

### Doctor / Paramedic

Senior medical review queue. Owns severe reviews, treatment guidance requests, pediatric severe cases, unclear black/deceased status, and official death certification workflow.

### Logistics Officer

Owns medical stock, equipment requests, burn rate, shortages, and resupply status. Clinical context should be limited to what is required for logistics decisions.

### Chamal / Operator / Observer

Owns control-room picture quality: sync, duplicates, external report conflicts, unassigned objects, pending requests, event timeline, and AAR/export support.

### Admin / Demo Controller

Demo and experiment-only role for loading, clearing, exporting, and controlling synthetic scenarios.

## Resource Request Types

Removed: `צוות אלונקה`.

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
