# Changelog V2.3

Demo V2.3 sharpens the prototype around the medical command chain and company-level resource command.

## Launcher

- Split the first page into a recommended demo path and advanced views.
- Recommended path: `חובש — התחלת טיפול`, `חוג״ד — תמונת מצב`, `מ״פ רפואה`.
- Advanced views: `AAR — מה למדנו`, `רופא / פראמדיק`, `לוגיסטיקה`, `חמ״ל`.
- Added an explicit demo action for the death-certification chain.

## Medic Flow

- Medic role starts at `מסך תנועה — הכנת זירה`.
- Arrival opens a quick treatment card.
- Immediate life-saving actions create command-visible patient state without waiting for full assessment.
- CAT tourniquet action automatically creates a red casualty and starts the tourniquet clock.

## חוג״ד View

- Added extracted/self-evacuated casualty counters for green and yellow casualties.
- Kept חוג״ד focused on medics, responsibilities, status, requests, and alerts instead of a full patient table.

## מ״פ רפואה View

- Added a stronger company resource command center.
- Added available medical resources, doctor/paramedic queue, death-certification queue, evacuation bottlenecks, open חוג״ד requests, equipment shortages, and cross-platoon allocation suggestions.

## Death Certification

- Made the chain visible:
  - Medic marks `חשד לנפטר / לא בר הצלה`.
  - App clarifies this is not official death certification.
  - System opens a non-emergency doctor request.
  - חוג״ד sees it pending.
  - מ״פ רפואה sees it in the doctor-resource queue.
  - Doctor view sees the certification task.

## Medical Handover

- Reworded the visible MIST action as `מסירה רפואית למד״א / כוח פינוי`.
- The UI explains MIST/ATMIST as a short handoff: mechanism, injuries, signs, and treatment.
