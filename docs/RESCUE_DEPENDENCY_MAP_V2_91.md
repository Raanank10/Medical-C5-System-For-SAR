# RESCUE Dependency Map V2.91

Status: cleanup audit artifact. This map is based on the current single-file app and is intended to prevent another broken "new patient" cleanup.

## Rules For Cleanup

- Do not delete legacy flow code until dynamic smoke tests prove the fallback path is safe.
- Current field "new patient" means current-zone casualty marker, not the legacy wizard.
- Treat `index.html` and `demo/rescue-app.html` as mirrored runtime files unless a later decision intentionally separates them.
- Preserve localStorage keys: `DEMO_STORAGE_KEY`, `OBSERVER_NOTES_KEY`, `CONFLICT_LOG_KEY`, `ACTIVE_RECOVERY_KEY`, `DEVICE_ID_KEY`.

## Core Navigation

| Symbol | Definition | Call/UI sites | State touched | Events/storage | Inventory section | Recommendation | Risk |
|---|---:|---|---|---|---|---|---|
| `goTo` | `index.html:3633` | many screen transitions | `currentScreen` | active recovery may restore to it | O/P | keep | critical |
| `activeScreenId` | `index.html:7201` | new casualty wrapper | DOM active screen | none | O/P | keep | high |
| `startRoleDashboard` | `index.html:2924` | launcher role cards | `activeRoleDashboard` | demo save | A/I/J/K/M | keep | high |
| `startPcDemo` | `index.html:2895` | launcher/demo | role/dashboard state | demo save | A/I | keep | medium |
| `continueDemo` | `index.html:2899` | launcher | saved demo | `DEMO_STORAGE_KEY` | A/O | keep | medium |
| `activateSignedDemoScenario` | `index.html:2651` | signed/demo start | patients, requests, site | local events | A/N | keep | high |
| `clearDemoScenario` | `index.html:2806` | launcher clear | all scenario state | `DEMO_STORAGE_KEY` | A/O | keep | medium |
| `clearDemoPatientsOnly` | `index.html:2834` | launcher clear patients | patients/requests | `DEMO_STORAGE_KEY` | A/O | keep | medium |
| `playNotebookAdvantageDemo` | `index.html:2655` | `הדגם יתרון על מחברת` | site, patients, stock, requests | many demo events | A/N | keep | high |

## New / Current Medic Flow

| Symbol | Definition | Call/UI sites | State touched | Events/storage | Inventory section | Recommendation | Risk |
|---|---:|---|---|---|---|---|---|
| `startMstartSweep` | `index.html:4408` | en-route arrival, dashboard action | screen, site/zone | save demo | C/D | keep | critical |
| `startCurrentZoneCasualtyMarker` | `index.html:4413` | wrapper/current flow | `activeSweepPatientId`, patients | marker event | D/E | keep | critical |
| `startNewCasualtyInCurrentContext` | `index.html:4419` | ambiguous "new casualty" buttons | routes by active screen/role/site | may call fallback | D/P | refactor in Batch 2 only | critical |
| `startSweepCasualtyMarker` | `index.html:3905` | sweep button, wrapper, demo scenario | creates patient marker | `CASUALTY_MARKER_CREATED`, save demo | D/E | keep | critical |
| `completeMstartSweep` | `index.html:4089` | sweep completion button | patient phases, sweep session | `MSTART_SWEEP_COMPLETED` | D/I/N | keep | high |
| `renderMstartSweep` | `index.html:4130` | sweep rendering | active patient/list | none | D/E | keep | critical |
| `activeSweepPatientId` | `index.html:2414` | render/update sweep | active patient marker | local save | D/E | keep | critical |

Current wrapper gap: current implementation is shorter than the requested V2.91 wrapper and does not explicitly branch on dashboard + site separately. This belongs to Batch 2, not Batch 1.

## Legacy Patient Flow

| Symbol | Definition | Call/UI sites | State touched | Events/storage | Inventory section | Recommendation | Risk |
|---|---:|---|---|---|---|---|---|
| `startNewPatient` | `index.html:5134` | `guardedNewPatient` | resets legacy `state` and screens | active recovery | P | keep/fallback | critical |
| `guardedNewPatient` | `index.html:4387` | wrapper/fallback/current old paths | calls `startNewPatient` | none | P | keep | critical |
| `startMedicTreatmentNow` | `index.html:4404` | old immediate path | site check + fallback | none | P | keep until isolated | high |
| `selectFlowMode` | `index.html:5206` | legacy UI | `state.flowMode` | none | P | keep | medium |
| `continueAfterIntake` | `index.html:5224` | legacy step | screen/state | none | P | keep | medium |
| `continueAfterLocation` | `index.html:5229` | legacy step | location state | none | P | keep | medium |
| `continueAfterTriage` | `index.html:5237` | legacy step | triage state | none | P | keep | medium |
| `continueAfterInjuryTrap` | `index.html:7484` | legacy rewritten flow | injury/trap state | none | P/L | keep | high |
| `savePatient` | `index.html:5845` | legacy final save | patients, vitals, treatments | events, save demo | P/N | keep | critical |
| `saveImmediateCasualtyAndContinue` | `index.html:4578` | quick MSTART legacy save | patients, immediate state | immediate assessment event | P/D | keep | high |
| `screen-step1` | `index.html:903` | legacy DOM | state inputs | recovery | P | keep | high |
| `screen-step8` | `index.html:1435` | legacy DOM | final review | recovery/save | P | keep | high |
| `screen-success` | `index.html:1591` | post-save UI | next flow route | none | P/D | Batch 2 audit | high |

## Triage

| Symbol | Definition | Call/UI sites | State touched | Events/storage | Inventory section | Recommendation | Risk |
|---|---:|---|---|---|---|---|---|
| `triagePill` | `index.html:2231` | role rows/cards | none | none | E/I/J | keep | medium |
| `triageBand` | `index.html:2261` | ticket cards | none | none | E | keep | high |
| `TRIAGE_LABELS` | `index.html:2186` | many renderers | none | none | E/I/J/N | keep | high |
| `TRIAGE_BAND_LABELS` | `index.html:2235` | triage band | none | none | E | keep | high |
| `manualTriageOverride` | `index.html:5018` | patient details | triage/source | event | E/N | keep | high |
| `overrideSweepColor` | `index.html:4010` | sweep override | triage/source/debt | event | D/E/N | keep | high |
| `applyWalkingAutofill` | `index.html:3882` | MSTART walking | mstart, vitals, triage | autofill event | D/E/N | keep | critical |
| `suggestMstartTriage` | `index.html:2001` inside `C5DomainRules` | domain rules | none | none | D/H | do not touch factory | high |

## Death Certification

| Symbol | Definition | Call/UI sites | State touched | Events/storage | Inventory section | Recommendation | Risk |
|---|---:|---|---|---|---|---|---|
| `createDeathCertificationRequest` | `index.html:6667` | black/suspected not salvageable | `reinforcementRequests` | doctor request event | K/L | keep | critical |
| `confirmSuspectedNotSalvageable` | `index.html:3999` | sweep black workflow | patient triage/status | doctor request | L | keep | critical |
| `skipToSummaryBlack` | `index.html:7511` | legacy black skip | legacy state/patient | doctor request path risk | L/P | keep | critical |
| `showBlackSkip` | `index.html:4736` | legacy immediate flow | DOM display | none | L/P | keep | high |
| `hideBlackSkip` | `index.html:4737` | legacy immediate flow | DOM display | none | L/P | keep | high |
| `initiateBlackTriage` | `index.html:7452` | black flow | legacy state | none | L/P | keep | critical |

## Supply

| Symbol | Definition | Call/UI sites | State touched | Events/storage | Inventory section | Recommendation | Risk |
|---|---:|---|---|---|---|---|---|
| `consumeFieldSupply` | `index.html:7283` | treatment supply usage | local stock, patient events | `SUPPLY_CONSUMED` | F/G/N | keep | critical |
| `showSupplyUsedSheet` | `index.html:7241` | after `consumeFieldSupply` | `pendingSupplyUse` | none | G | keep | high |
| `createResupplyRequest` | `index.html:6466` | medic request/auto suggestion | `reinforcementRequests` | `RESUPPLY_REQUEST_CREATED` | G/I/J | keep | high |
| `medicKit` | represented by `state.localStockCache` | supply chips | local stock | demo save | G | keep | high |
| `pcTruckStock` | `index.html:2445` | PC/CC supply boards | truck stock | demo save | G/I/J | keep | high |
| `resupply-modal` | `index.html:1481` | medic request | draft state | request creation | G | keep | high |
| `supply-used-modal` | `index.html:1513` | treatment confirmation | pending supply use | correction events | G/N | keep | high |

## PC / CC

| Symbol | Definition | Call/UI sites | State touched | Events/storage | Inventory section | Recommendation | Risk |
|---|---:|---|---|---|---|---|---|
| `renderCommander` | `index.html:6212` | command screen interval/tabs | command DOM | none | I/J/M | keep | high |
| `renderRoleDashboard` | `index.html:3373` | launcher roles | role view | none | A/I/J/K/M | keep | high |
| `renderPcResponsibilityBoard` | `index.html:3071` | PC role dashboard | none | none | I | keep | high |
| `renderCcCommandBoard` | `index.html:3266` | CC role dashboard | none | none | J | keep | high |
| `createMedicalResourceRequest` | `index.html:6643` | reinforcement modal/death cert | `reinforcementRequests` | request event | I/J/K/L | keep | high |
| `AUTH_MATRIX` | `index.html:2198` | command/auth display | none | none | I/J/M | Batch 3 correction | medium |

Known mismatch candidate: `AUTH_MATRIX` says PC cannot request resupply and logistics dispatches runners, while current product model says medic requests, PC fulfills from truck/escalates, CC allocates company-level supplies.

## AAR / Events

| Symbol | Definition | Call/UI sites | State touched | Events/storage | Inventory section | Recommendation | Risk |
|---|---:|---|---|---|---|---|---|
| `saveLocalEvent` | `index.html:7184` | everywhere | `outbox` | event log/export | N/O | keep | critical |
| AAR render section | around `index.html:7026` | `screen-aar` | reads patients/events/requests | exports | N | keep | high |
| export handlers | around `index.html:3524` | AAR/export buttons | reads app state | JSON/CSV | N | keep | medium |
| `מה המחברת הייתה מפספסת` | `index.html:592`, `index.html:7088` | launcher/AAR | reads patients/requests | none | A/N | keep | high |

## Duplicate Runtime Files

| File | Current role | Risk |
|---|---|---|
| `index.html` | root app copy | high if not kept consistent |
| `demo/rescue-app.html` | currently opened by user in browser | critical for manual test |

Current version inconsistency before V2.91 Batch 1: `index.html` has `APP_VERSION='2.7.0'`; `demo/rescue-app.html` has `APP_VERSION='2.8.0'`; both visible labels say V2.8.

## Dynamic Browser Findings After Batch 1

The local HTTP smoke pass verified launcher, field mode, en-route setup, MSTART sweep, casualty marker creation, walking autofill, contradiction cleanup, tourniquet red state, tourniquet timer, supply-used sheet, sweep completion, medic monitoring, PC rendering, and AAR rendering.

Open stabilization blocker: selecting the CC role updates the header to `מ״פ רפואה`, but the previous PC body remains rendered. The expected CC sections such as `תמונת משאבים פלוגתית`, `עומס מחלקות`, and `תעדוף פינוי פלוגתי` do not appear. Do not begin Batch 2 navigation cleanup until this CC render path has a separately approved minimal fix and a click-level smoke check.
