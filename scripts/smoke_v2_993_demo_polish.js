const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['index.html', path.join('demo', 'rescue-app.html')];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sliceBetween(html, startNeedle, endNeedle, rel) {
  const start = html.indexOf(startNeedle);
  assert(start >= 0, `${rel}: missing ${startNeedle}`);
  const end = html.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `${rel}: missing ${endNeedle}`);
  return html.slice(start, end);
}

for (const rel of files) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');
  const sweep = sliceBetween(html, 'function renderMstartSweep()', 'function timeCodeToTodayMs', rel);
  const roleDashboard = sliceBetween(html, 'function renderRoleDashboard', 'function reassignPatient', rel);
  const ccHero = sliceBetween(html, 'function renderCcHeroDashboard', 'function renderCcCommandBoard', rel);
  const logistics = sliceBetween(html, 'function renderLogisticsTaskBoard', 'function patientMatchesBoardFilter', rel);
  const commanderBrief = sliceBetween(html, 'function playMedicCommanderSequence', 'function playDeathCertificationSequence', rel);
  const tqWithLimb = sliceBetween(html, 'function recordSweepTourniquetWithLimb', 'function renderSweepTourniquetCard', rel);

  assert(html.includes("const APP_VERSION = '2.99.3';"), `${rel}: APP_VERSION must be 2.99.3`);
  assert(html.includes('Demo V2.993'), `${rel}: launcher label must be Demo V2.993`);
  assert(html.includes('ROLE // V2.993'), `${rel}: role header must be V2.993`);
  assert(html.includes('Role-Based Medical Command System V2.993'), `${rel}: role strip must be V2.993`);
  assert(!html.includes('2.992V') && !html.includes("const APP_VERSION = '2.99.2';"), `${rel}: stale V2.992 label remains`);
  assert(!html.includes('localStorage.clear('), `${rel}: must not use localStorage.clear()`);
  assert(html.includes('const DEMO_KEYS_TO_PURGE = Object.freeze'), `${rel}: scoped demo reset key list missing`);
  assert(html.includes('function safeScopedDemoReset'), `${rel}: safe scoped demo reset helper missing`);
  assert(html.includes('rescue_field_mode'), `${rel}: reset must preserve field-mode preference`);
  assert(html.includes('פעולה זו תנקה את נתוני הדמו בלבד. להמשיך?'), `${rel}: scoped reset confirmation text missing`);
  assert(html.includes('const DEMO_SUPPLY_THRESHOLDS = Object.freeze'), `${rel}: demo logistics thresholds missing`);
  assert(html.includes('tourniquets:{critical:2, warning:5, recommendedMin:12}'), `${rel}: tourniquet demo thresholds missing`);
  assert(html.includes('pressureDressings:{critical:4, warning:8'), `${rel}: pressure dressing demo thresholds missing`);
  assert(html.includes('hemostaticGauze:{critical:2, warning:5'), `${rel}: hemostatic gauze demo thresholds missing`);

  assert(sweep.includes('${triageBand(p.triage,p)}'), `${rel}: top triage band must remain visible`);
  assert(sweep.includes('M — דימום מסכן חיים'), `${rel}: hemorrhage block title missing`);
  assert(sweep.includes('עקיפה ידנית / פירוט מיון'), `${rel}: override controls must be collapsed behind details`);
  assert(sweep.includes('פציעות / מיקום בגוף / הערכה מורחבת'), `${rel}: body map/extended assessment collapsed section missing`);
  assert(sweep.includes('grid-template-columns:65fr 35fr'), `${rel}: sticky next/finish layout must be 65/35`);
  assert(sweep.includes('style="background:var(--green);font-size:18px;min-height:64px">פצוע הבא'), `${rel}: next casualty must be dominant`);
  assert(sweep.includes('btn-secondary') && sweep.includes('סיים סריקה'), `${rel}: finish sweep must remain visible but secondary`);
  assert(!sweep.includes("${btn('breathing','unsure'"), `${rel}: visible breathing unsure button remains`);
  assert(!sweep.includes("setBreathingAfterAirway('unsure')"), `${rel}: visible after-airway unsure button remains`);
  assert(!sweep.includes("${btn('trapped','unknown'"), `${rel}: visible trapped unknown button remains`);
  assert(!sweep.includes("${btn('perfusion','not_checked'"), `${rel}: visible perfusion not-checked button remains in primary card`);
  assert(html.includes("p.mstart.breathing='assumed_yes'"), `${rel}: AVPU A/V should use assumed breathing, not overwrite yes`);
  assert(html.includes("p.mstart.breathing==='no'") && html.includes('סתירה: AVPU'), `${rel}: AVPU vs breathing=no contradiction warning missing`);

  assert(html.includes('bottom:148px') && html.includes("fab.textContent='+ פצוע | אותו אזור'"), `${rel}: same-zone FAB must sit above sticky actions with fixed label`);
  assert(html.includes("if(activeRoleDashboard!=='medic' || activeScreenId()!=='sweep') return;"), `${rel}: same-zone FAB must be sweep/medic scoped`);
  assert(!tqWithLimb.includes('reconcileSupplySource'), `${rel}: recordSweepTourniquetWithLimb must not double-count tourniquet supply`);

  assert(roleDashboard.includes("${role==='cc'?renderCcCommandBoard():`<div class=\"role-top-grid\">"), `${rel}: CC hero must render before generic metrics`);
  assert(roleDashboard.includes('${dashboardFocusBanner()}'), `${rel}: dashboard focus banner missing from role dashboard`);
  assert(roleDashboard.includes('פירוט נוסף / אחריות ותורים'), `${rel}: CC generic lower sections must be collapsed`);
  assert(ccHero.includes('מ״פ רפואה — החלטות עכשיו'), `${rel}: CC hero title missing`);
  assert(ccHero.includes('מה להזיז, לאן, ולמה'), `${rel}: CC hero subtitle missing`);
  assert(ccHero.includes('חשד לנפטר · ממתין לרופא'), `${rel}: CC death-certification hero card missing`);
  assert(ccHero.includes('Top 3 Recommendations — מ״פ רפואה'), `${rel}: CC recommendation panel missing`);

  assert(logistics.includes('משימות לוגיסטיקה עכשיו'), `${rel}: logistics task board missing`);
  assert(logistics.includes('חסמים נמוכים ברכב חוג״ד א׳'), `${rel}: logistics TQ shortage task missing`);
  assert(logistics.includes('סיבה קלינית'), `${rel}: logistics cards must include clinical reason`);
  assert(logistics.includes('setDashboardFocus'), `${rel}: logistics task focus action missing`);
  assert(html.includes('id="logistics-task-board"'), `${rel}: logistics task board mount missing`);
  assert(html.includes('function setDashboardFocus') && html.includes('function focusedRecommendations'), `${rel}: lightweight focus filtering helpers missing`);
  assert(html.includes('function loadOmniRoleScenario'), `${rel}: Omni-Role scenario loader missing`);
  assert(html.includes('טען תרחיש Omni-Role'), `${rel}: Omni-Role launcher label missing`);
  assert(html.includes('TOURNIQUET_MARKED_INEFFECTIVE') && html.includes('REQ-OMNI-EVAC-001') && html.includes('REQ-OMNI-SUP-001'), `${rel}: Omni scenario must trigger TQ failure, evacuation, and supply pressure`);

  assert(html.includes('הצג תדריך מ״פ / חוג״ד ב־60 שניות'), `${rel}: commander 60-second launcher button missing`);
  assert(commanderBrief.includes("renderRoleDashboard('pc')"), `${rel}: commander brief must show PC board`);
  assert(commanderBrief.includes("renderRoleDashboard('cc')"), `${rel}: commander brief must show CC hero`);
  assert(commanderBrief.includes("goTo('logistics')"), `${rel}: commander brief must show logistics`);
  assert(commanderBrief.includes("goTo('aar')"), `${rel}: commander brief must end in AAR`);

  assert(html.includes('function startNewPatient('), `${rel}: legacy startNewPatient missing`);
  assert(html.includes('function guardedNewPatient('), `${rel}: legacy guardedNewPatient missing`);
  assert(html.includes('id="screen-step1"') && html.includes('id="screen-step8"'), `${rel}: legacy step screens missing`);
  assert(html.includes('LEGACY_FULL_ASSESSMENT_DO_NOT_DELETE_WITHOUT_TESTS'), `${rel}: legacy safety comment missing`);
  assert(roleDashboard.includes("role==='medic'?'הערכה מורחבת':'פתח מסך עבודה מלא'"), `${rel}: medic legacy action must be demoted as extended assessment`);
  assert(!roleDashboard.includes('startMedicTreatmentNow()">התחל טיפול עכשיו'), `${rel}: old primary medic wizard action still visible`);

  console.log(`${rel}: V2.993 demo polish static smoke passed`);
}
