const fs = require('fs');
const path = require('path');
const { assertVersionLabels } = require('./lib/smoke_version');

const root = path.resolve(__dirname, '..');
const files = ['index.html'];

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
  const tqWithLimb = sliceBetween(html, 'function recordSweepTourniquetWithLimb', 'function renderSweepTourniquetCard', rel);

  assertVersionLabels(html, rel);
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

  // Since 2026-10-23 the FAB is positioned in CSS from the bottom bar's height, not a fixed 148px.
  assert(html.includes('.same-zone-fab{position:fixed;') && html.includes('bottom:calc(var(--bottom-bar-h) + 12px') && html.includes("fab.textContent='+ פצוע | אותו אזור'"), `${rel}: same-zone FAB must sit above sticky actions with fixed label`);
  // Since 2026-10-23 the FAB is the sweep screen's one add-casualty button for any role running the sweep.
  assert(html.includes("if(activeScreenId()!=='sweep') return;"), `${rel}: same-zone FAB must be sweep scoped`);
  assert(!tqWithLimb.includes('reconcileSupplySource'), `${rel}: recordSweepTourniquetWithLimb must not double-count tourniquet supply`);

  // V2.99.35 appended the pre-evacuation board after the CC board; the CC board still leads.
  assert(roleDashboard.includes("${role==='cc'?renderCcCommandBoard()+renderExtractedCounterBoard():`<div class=\"role-top-grid\">"), `${rel}: CC hero must render before generic metrics`);
  assert(roleDashboard.includes('${dashboardFocusBanner()}'), `${rel}: dashboard focus banner missing from role dashboard`);
  assert(html.includes('let dashboardCollapsedSections = {}'), `${rel}: collapse state missing`);
  assert(html.includes('function normalizeDashboardFocus'), `${rel}: normalized dashboard focus helper missing`);
  assert(html.includes('function focusMatchesPatient') && html.includes('function focusMatchesRequest') && html.includes('function focusMatchesLogisticsTask'), `${rel}: safe focus matcher helpers missing`);
  assert(html.includes('function renderCollapsibleSection'), `${rel}: collapsible section helper missing`);
  assert(html.includes('function renderOperationalEmptyState'), `${rel}: operational empty-state helper missing`);
  assert(html.includes('return true;') && html.includes('if(!supported) return true;'), `${rel}: focus fallback must be safe by default`);
  assert(html.includes('אין פצועים במיקוד הנוכחי'), `${rel}: focused patient empty state missing`);
  assert(html.includes('אין בקשות במיקוד הנוכחי'), `${rel}: focused request empty state missing`);
  assert(html.includes('אין משימות לוגיסטיקה במיקוד הנוכחי'), `${rel}: focused logistics empty state missing`);
  assert(roleDashboard.includes('פירוט נוסף / אחריות ותורים'), `${rel}: CC generic lower sections must be collapsed`);
  assert(ccHero.includes('מ״פ רפואה — החלטות עכשיו'), `${rel}: CC hero title missing`);
  assert(ccHero.includes('מה להזיז, לאן, ולמה'), `${rel}: CC hero subtitle missing`);
  assert(ccHero.includes('חשד לנפטר · ממתין לרופא'), `${rel}: CC death-certification hero card missing`);
  assert(ccHero.includes('Top 3 Recommendations — מ״פ רפואה'), `${rel}: CC recommendation panel missing`);

  assert(logistics.includes('משימות לוגיסטיקה עכשיו'), `${rel}: logistics task board missing`);
  assert(logistics.includes('חסמים נמוכים ברכב חוג״ד א׳'), `${rel}: logistics TQ shortage task missing`);
  assert(logistics.includes('סיבה קלינית'), `${rel}: logistics cards must include clinical reason`);
  assert(logistics.includes('setDashboardFocus'), `${rel}: logistics task focus action missing`);
  assert(logistics.includes('itemTypes') && logistics.includes('patientIds') && logistics.includes('requestIds'), `${rel}: logistics tasks must carry structured focus fields`);
  assert(logistics.includes('focusFilteredList(tasks, focusMatchesLogisticsTask)'), `${rel}: logistics task filtering must use structured matcher`);
  assert(html.includes('id="logistics-task-board"'), `${rel}: logistics task board mount missing`);
  assert(html.includes('function setDashboardFocus') && html.includes('function focusedRecommendations'), `${rel}: lightweight focus filtering helpers missing`);
  // The Omni-Role fixture scenario was removed with the hardcoded patients (V2.99.24); devices that
  // saved it are cleaned on load.
  assert(!html.includes('function loadOmniRoleScenario') && !html.includes('טען תרחיש Omni-Role'), `${rel}: the Omni-Role fixture scenario must stay removed`);
  assert(html.includes("!String(r.id||'').startsWith('REQ-OMNI-')"), `${rel}: saved Omni-Role fixture requests must be dropped on load`);

  assert(html.includes('הצג תדריך מ״פ / חוג״ד ב־60 שניות'), `${rel}: commander 60-second launcher button missing`);
  // The scripted medic-commander sequence was removed with the hardcoded patients (V2.99.24): it
  // created a fake red patient and sync-eligible VITALS_RECORDED events that could reach the live DB.
  assert(!html.includes('function playMedicCommanderSequence'), `${rel}: the scripted commander sequence must stay removed`);

  assert(html.includes('function startNewPatient('), `${rel}: legacy startNewPatient missing`);
  assert(html.includes('function guardedNewPatient('), `${rel}: legacy guardedNewPatient missing`);
  assert(html.includes('id="screen-step1"') && html.includes('id="screen-step8"'), `${rel}: legacy step screens missing`);
  assert(html.includes('LEGACY_FULL_ASSESSMENT_DO_NOT_DELETE_WITHOUT_TESTS'), `${rel}: legacy safety comment missing`);
  assert(roleDashboard.includes("role==='medic'?'הערכה מורחבת':'פתח מסך עבודה מלא'"), `${rel}: medic legacy action must be demoted as extended assessment`);
  assert(!roleDashboard.includes('startMedicTreatmentNow()">התחל טיפול עכשיו'), `${rel}: old primary medic wizard action still visible`);

  console.log(`${rel}: V2.9916 demo polish static smoke passed`);
}
