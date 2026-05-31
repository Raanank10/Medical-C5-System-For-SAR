# RESCUE Feature Inventory V2.91

Status: cleanup audit artifact. This file is intentionally descriptive and does not change runtime behavior.

Core rule: the medic treats first; every small field action quietly builds the command picture.

## Inventory Fields

Each feature is tracked by: feature name, user role, UI entry points, function names, DOM ids/classes, state fields, localStorage keys, event types, output views affected, classification, risk if broken, smoke test required.

## A. Launcher / Demo Mode

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Demo launcher and role cards | demo operator | launcher role cards | `startRoleDashboard`, `startPcDemo`, `continueDemo` | `.demo-card`, `screen-landing`, `screen-dashboard` | `activeRoleDashboard`, `DEMO_STORAGE_KEY` | role dashboard | core/current | high: demo cannot start | launcher renders, role opens |
| Recommended demo path | demo operator | launcher guide | static HTML + `playNotebookAdvantageDemo` | `.demo-strip`, `.demo-mini-btn` | `experimentPhase`, `saveLocalEvent` | AAR, launcher | demo-only | medium | demo scenario activates |
| Notebook advantage demo | demo operator | `הדגם יתרון על מחברת` | `playNotebookAdvantageDemo` | launcher button | `patients`, `reinforcementRequests`, `pcTruckStock`, events | medic/PC/CC/AAR | demo-only | high: value proof broken | activate and clear |
| Continue saved demo | demo operator | continue button | `continueDemo`, `loadDemo` | launcher controls | `DEMO_STORAGE_KEY` | current saved view | core/current | medium | save/load smoke |
| Clear demo data | demo operator | clear buttons | `clearDemoScenario`, `clearDemoPatientsOnly` | launcher controls | `DEMO_STORAGE_KEY`, patients, requests | all views | core/current | medium | activate, clear |
| What notebook missed | demo operator, AAR viewer | launcher and AAR | `renderAAR`, `playNotebookAdvantageDemo` | text panel | `outbox`, patients, requests | launcher, AAR | core/current | high: demo value reduced | AAR contains panel |

## B. Field Mode

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Field mode toggle | all roles | `מצב שטח` floating button | `toggleFieldMode`, `applyFieldMode` | `field-mode-toggle`, `body.field-mode` | `fieldModeEnabled`, `rescue_field_mode` | all screens | core/current | medium | toggles body class |
| Larger touch targets | medic | field mode CSS | CSS only | `.tap-btn`, `.btn-primary`, `.next-action-box` | none | medic sweep/monitoring | core/current | medium | static CSS check |
| Hidden/demoted medic clutter | medic | medic dashboard | `renderRoleDashboard`, medic panel renderers | dashboard sections | `activeRoleDashboard` | medic dashboard | core/current | high: medic workflow clutter | medic screen excludes command clutter |

## C. En-Route / Site Setup

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Site and zone setup | medic | `screen-enroute` | `arriveAtScene`, `saveSiteData`, `goTo` | `screen-enroute`, site/zone inputs | `siteData`, `DEMO_STORAGE_KEY` | sweep, tickets, PC/CC | core/current | high: casualty markers lose context | set site/zone, start sweep |
| Expected casualty counts | medic/PC | en-route fields | site data save functions | en-route inputs | expected trapped/immobile/missing/severe fields | PC/CC summaries | core/current | medium | saved values persist |
| Arrival to sweep | medic | `הגעתי — התחל סריקת MSTART` | `startMstartSweep` | arrival action button | `currentScreen`, `activeSweepPatientId` | sweep | core/current | high | arrival opens sweep |

## D. MSTART Sweep

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Open sweep | medic | role dashboard/en-route | `startMstartSweep`, `renderMstartSweep` | `screen-sweep` | `currentScreen`, `siteData` | medic sweep, PC sweep | core/current | high | sweep renders |
| Create casualty marker | medic | `פצוע נוסף באזור הזה` | `startSweepCasualtyMarker`, `startCurrentZoneCasualtyMarker`, `startNewCasualtyInCurrentContext` | sweep buttons | `patients`, `activeSweepPatientId`, `assessmentDebt` | sweep list, PC/CC/AAR | core/current | critical | marker created with zone |
| MSTART inputs | medic | active casualty card | `updateSweepField`, `applyWalkingAutofill`, `overrideSweepColor` | sweep grids/buttons | `p.mstart`, `p.triage`, `p.triageSource` | tickets, PC, AAR | core/current | high | walking autofill and contradiction |
| Complete sweep | medic/PC | `סיימתי סריקת MSTART באזור הזה` | `completeMstartSweep` | sweep completion button | event `MSTART_SWEEP_COMPLETED` | PC sweep board, monitoring queue | core/current | high | completion event and PC summary |

## E. Casualty Marker / Patient Ticket

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Temporary ID and zone | medic/PC/CC | all patient cards | `nextPatientId`, render helpers | `.patient-card`, `.ticket-triage-band` | `p.id`, `p.zone`, `p.siteId` | all patient views | core/current | high | every card has id/zone |
| Triage identity | all | tickets/rows | `triagePill`, `triageBand`, `TRIAGE_LABELS`, `TRIAGE_BAND_LABELS` | triage classes | `p.triage`, `p.triageSource`, override reason | medic/PC/CC/AAR | core/current | high | visible triage status |
| Assessment debt | medic/PC/AAR | patient ticket | `assessmentDebtList`, `debtChips`, `getNextAction` | `.debt-chip`, `.next-action-box` | `p.assessmentDebt`, `p.needsFullAssessment` | ticket, PC debt board, AAR | core/current | high | missing vitals displayed |
| Supply-linked references | medic/PC/CC | supply popup/request cards | `showSupplyUsedSheet`, `createResupplyRequest` | `supply-used-modal`, `resupply-modal` | `linkedPatientId`, `reinforcementRequests` | PC/CC logistics, AAR | core/current | high | TQ opens supply popup |

## F. Life-Saving Actions

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Tourniquet | medic | sweep/legacy intervention buttons | `recordSweepTreatment`, `markImmediateLifeSavingAction`, `tourniquetRecordFromState` | `tourniquet-limb-modal`, `tourniquet-wrap` | `p.tourniquet`, `lifeSavingTreatments`, `SUPPLY_CONSUMED` | tickets, PC, CC, AAR | core/current | critical | timer, red ticket, popup |
| Airway | medic | sweep/legacy buttons | `recordSweepTreatment`, airway handlers | sweep treatment strip | treatment events, mstart breathing | PC airway count, AAR | core/current | high | airway event |
| Pressure dressing / bleeding control | medic | sweep/legacy buttons | `recordSweepTreatment`, `markImmediateLifeSavingAction` | treatment strip | treatment events, supply movement | PC/CC/AAR | core/current | high | event + supply |
| Other note | medic | treatment strip | note handlers | treatment strip | local events | AAR | core/current | low | note event |

## G. Supply / Logistics

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Medic kit stock | medic | implicit after treatment | `consumeFieldSupply`, `reconcileSupplySource` | supply warning chips | `state.localStockCache`, `state.supplyMovements` | medic warnings, AAR | core/current | high | stock decrements |
| Supply-used popup | medic | after treatment | `showSupplyUsedSheet`, `confirmSupplyUse`, correction handlers | `supply-used-modal` | `pendingSupplyUse`, `SUPPLY_CONSUMED` | medic, AAR | core/current | high | popup confirm/request |
| Resupply request | medic/PC/CC | `חסר לי ציוד`, popup request | `openMedicResupplySheet`, `createResupplyRequest`, `updateResupplyStatus` | `resupply-modal` | `reinforcementRequests`, `pcTruckStock` | PC board, CC board, AAR | core/current | high | request and PC approve |
| PC truck first source | PC | resupply board | `pcTruckAvailability`, `renderPcResupplyBoard` | PC board rows | `pcTruckStock`, `PC_TRUCK_BASELINE` | PC/CC | core/current | high | approve decrements truck |

## H. Monitoring Phase

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Monitoring queue | medic | `הפצועים שלי` | `renderDashboard`, patient board renderers | `screen-dashboard`, patient cards | patients, filter state | medic | core/current | high | patient appears after sweep |
| Full vitals | medic | `מדדים מלאים עכשיו` | `openVitalsModal`, `saveModalVitals` | `vitals-modal` | `p.vitals`, `vitalsHistory`, `lastVitalsAt` | medic/PC/CC/AAR | core/current | high | modal opens/saves |
| Deterioration | medic/PC | after vitals save | `C5Rules.detectDeterioration`, priority recommendation handlers | alert UI | `p.deterioration`, `p.priorityRecommendation` | medic/PC/CC/AAR | core/current | high | deterioration alert |
| Evacuation/handover | medic/PC | patient card actions | status handlers | card buttons | `p.patientStatus`, events | PC/CC/AAR | core/current | medium | status update |

## I. PC / חוג״ד

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Live sweep summary | PC | role dashboard | `renderSweepBoardForPc`, `renderPcResponsibilityBoard` | PC sections | patients, sweep completion events | PC | core/current | high | PC summary after sweep |
| Assessment debt board | PC | role dashboard | `renderPcAssessmentDebtBoard` | PC board | `assessmentDebt`, vitals age | PC | core/current | high | red/no vitals row |
| Resupply handling | PC | PC resupply section | `renderPcResupplyBoard`, `updateResupplyStatus` | PC board | `reinforcementRequests`, `pcTruckStock` | PC/CC/AAR | core/current | high | approve/send/deliver |
| Requests | PC | action buttons | `openReinforcementRequest`, `createMedicalResourceRequest` | reinforcement modal | requests | PC/CC/doctor | core/current | high | request renders |

## J. CC / מ״פ רפואה

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Resource board | CC | role dashboard | `renderCcCommandBoard`, `renderCompanyResourceCenter` | CC role sections | patients, requests, stock | CC | core/current | high | CC renders |
| Platoon/site load | CC | CC board | `renderCcActiveSitesSnapshot`, `renderCcEvacuationFunnel` | CC cards | patients/siteData | CC | core/current | medium | site counts |
| Resource recommendations | CC | CC board | `renderCcCommandBoard` | recommendation rows | patients, open requests | CC | core/current | high | recommendation text |
| Cross-platoon/resource actions | CC | action chips | `openReinforcementRequest`, demo allocation handlers | `.cc-action-chip` | requests | CC/AAR | core/current | medium | actions callable |

## K. Doctor / Paramedic

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Senior review queue | doctor/paramedic | role dashboard | `roleScopedPatients`, `roleScopedRequests` | doctor role sections | red/black patients, requests | doctor dashboard | core/current | high | doctor renders |
| Doctor/paramedic requests | PC/CC/medic | reinforcement modal | `createMedicalResourceRequest`, `updateReinforcementStatus` | `reinforcement-modal` | `reinforcementRequests` | doctor/PC/CC/AAR | core/current | high | request lifecycle |
| Death certification | doctor | black path/request queue | `createDeathCertificationRequest` | request rows | `doctor_death_cert` | doctor/CC/AAR | unsafe-to-delete | critical | suspected not salvageable creates request |

## L. Death Certification / Black Pathway

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Suspected not salvageable | medic | no breathing after airway / black skip | `confirmSuspectedNotSalvageable`, `initiateBlackTriage`, `skipToSummaryBlack` | black skip UI | `p.triage='black'`, `confirmedClinical`, requests | medic/doctor/PC/CC/AAR | unsafe-to-delete | critical | creates doctor request |
| Non-official wording | medic/doctor | black panels | UI text + request functions | black panels/request rows | request text | all command views | unsafe-to-delete | critical | no official death wording by medic |
| Second black escalation | PC/CC | death cert request logic | `createDeathCertificationRequest` | request board | existing death requests | CC queue | unsafe-to-delete | high | second request escalation |

## M. CHAMAL / Operator

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Data integrity / overview | CHAMAL | role dashboard, commander panels | `renderRoleDashboard`, commander renderers | role board | patients, requests, local events | CHAMAL/dashboard | demo-only | medium | role renders |
| External reports and sync | CHAMAL/commander | commander sections | sync/status renderers | sync pills | `demoSyncMode`, `lastSyncAt` | command views | demo-only | low | static render |
| AAR support | CHAMAL | AAR/export | `saveLocalEvent`, export handlers | AAR screen | `outbox` | AAR/export | core/current | medium | AAR renders |

## N. AAR

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Event timeline | all/demo | `screen-aar` | `saveLocalEvent`, AAR render section | `screen-aar` | `outbox` | AAR/export | core/current | high | timeline visible |
| Timing metrics | commander/trainer | AAR cards | AAR rendering logic | `.aar-card` | patients, events | AAR | core/current | high | first red/TQ metrics |
| Supply/resupply delays | commander/trainer | AAR | AAR rendering logic | AAR cards | `SUPPLY_CONSUMED`, resupply requests | AAR | core/current | medium | supply count |
| What notebook missed | commander/trainer | AAR | AAR insight section | AAR insight rows | patients, debt, requests | AAR | core/current | high | section visible |

## O. Local State / Recovery

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Demo save/load | all | automatic/local controls | `saveDemo`, `loadDemo` | none | `DEMO_STORAGE_KEY` | all | core/current | high | save/load |
| Active draft recovery | medic | reload/session recovery | `restoreActiveRecoveryState`, `hydrateActiveDraft` | none | `ACTIVE_RECOVERY_KEY` | old wizard/sweep/monitoring | unsafe-to-delete | high | recovery path static check |
| Device id | all | automatic | `getDeviceId` | device id spans | `DEVICE_ID_KEY` | signatures/export | core/current | low | key unchanged |
| Observer/conflict state | CHAMAL/demo | observer panels | observer note functions | note panel | `OBSERVER_NOTES_KEY`, `CONFLICT_LOG_KEY` | CHAMAL/AAR | demo-only | medium | keys unchanged |

## P. Legacy Wizard

| Feature | Role | UI entry points | Functions | DOM ids/classes | State/localStorage/events | Output views | Classification | Risk | Smoke test |
|---|---|---|---|---|---|---|---|---|---|
| Legacy patient wizard | medic/fallback | old buttons, recovery, fallback | `startNewPatient`, `guardedNewPatient`, `startMedicTreatmentNow` | `screen-step1` through `screen-step8` | `state`, `flowVitals`, `patients` | success, patient board, AAR | legacy/fallback | critical until proven unused | fallback call does not throw |
| Flow mode and progression | medic/fallback | step screens | `selectFlowMode`, `continueAfterIntake`, `continueAfterLocation`, `continueAfterTriage`, `continueAfterInjuryTrap` | step buttons | `state.flowMode`, `state.location`, `state.triage` | patient save | legacy/fallback | high | wizard static route exists |
| Legacy save paths | medic/fallback | success and final save | `savePatient`, `saveImmediateCasualtyAndContinue` | `screen-success` | patients, events, recovery | dashboard/AAR | legacy/fallback | high | save functions exist |
| Black fast exit | medic/fallback | black skip | `showBlackSkip`, `hideBlackSkip`, `skipToSummaryBlack` | black skip wrapper | black triage, doctor request | doctor/PC/CC/AAR | unsafe-to-delete | critical | death cert smoke |

