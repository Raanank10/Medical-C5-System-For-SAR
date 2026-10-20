const fs = require('fs');
const path = require('path');
const { assertVersionLabels } = require('./lib/smoke_version');

const root = path.resolve(__dirname, '..');
const files = ['index.html'];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function section(html, startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert(start >= 0, `missing section start: ${startNeedle}`);
  const end = html.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing section end: ${endNeedle}`);
  return html.slice(start, end);
}

for (const rel of files) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');
  const engine = section(html, 'const DecisionSupportEngine=(()=>', 'function renderRecommendationCard');
  const pcBoard = section(html, 'function renderPcNowTaskBoard', 'function renderPcMedicLoadBoard');
  const ccHero = section(html, 'function renderCcHeroDashboard', 'function renderCcCommandBoard');

  assertVersionLabels(html, rel);
  assert(!html.includes('Demo V3.0') && !html.includes("const APP_VERSION = '3.0.0';"), `${rel}: V3.0 must not be present`);

  assert(html.includes('const RECOMMENDATION_ACK_KEY'), `${rel}: recommendation ACK storage key missing`);
  assert(html.includes('Recommendation only – Human decision required'), `${rel}: human-decision disclaimer missing`);
  assert(html.includes('function acknowledgeRecommendation('), `${rel}: recommendation ACK function missing`);

  [
    'evaluatePatientDeterioration',
    'evaluateTourniquets',
    'evaluateMedicCoverage',
    'evaluateSupplyBurn',
    'evaluateEvacuation',
    'SectorRiskScore',
    'OperationalPressureIndex',
    'rank'
  ].forEach(name => {
    assert(engine.includes(name), `${rel}: DecisionSupportEngine missing ${name}`);
  });

  [
    'REC_TQ_OVERDUE',
    'REC_DOCTOR_GAP',
    'REC_SUPPLY_BURN',
    'REC_EVAC_DELAY',
    'REC_PATIENT_DETERIORATION'
  ].forEach(id => {
    assert(engine.includes(id), `${rel}: expected recommendation id/category missing ${id}`);
  });

  assert(engine.includes('severity') || engine.includes('RECOMMENDATION_PRIORITY_WEIGHT'), `${rel}: ranking must include severity/priority weight`);
  assert(engine.includes('urgencyWeight') && engine.includes('confidence'), `${rel}: ranking must include urgency and confidence`);
  assert(html.includes('renderRecommendationCard'), `${rel}: recommendation card renderer missing`);
  assert(html.includes('renderRecommendationPanel'), `${rel}: recommendation panel renderer missing`);
  assert(html.includes('renderSectorRiskScores'), `${rel}: sector risk renderer missing`);
  assert(html.includes('renderOperationalPressureIndex'), `${rel}: operational pressure renderer missing`);

  assert(pcBoard.includes('DecisionSupportEngine.forPc()'), `${rel}: PC dashboard must consume DecisionSupportEngine.forPc`);
  assert(pcBoard.includes('Top 3 Recommendations — חוג״ד'), `${rel}: PC Top 3 recommendation panel missing`);
  assert(pcBoard.includes('renderSectorRiskScores'), `${rel}: PC Sector Risk Scores missing`);

  assert(ccHero.includes('DecisionSupportEngine.forCc()'), `${rel}: CC dashboard must consume DecisionSupportEngine.forCc`);
  assert(ccHero.includes('renderOperationalPressureIndex'), `${rel}: CC Operational Pressure Index missing`);
  assert(ccHero.includes('Top 3 Recommendations — מ״פ רפואה'), `${rel}: CC Top 3 recommendation panel missing`);
  assert(ccHero.includes('מ״פ רפואה — החלטות עכשיו'), `${rel}: CC hero title missing`);

  // The fixture scenario that used to trigger every engine rule was removed with the hardcoded
  // patients (V2.99.24), so invented casualties never show next to real ones.
  assert(!html.includes('function loadDemoScenario'), `${rel}: the fixture demo scenario must stay removed`);

  assert(html.includes('function startNewPatient('), `${rel}: legacy startNewPatient missing`);
  assert(html.includes('function guardedNewPatient('), `${rel}: legacy guardedNewPatient missing`);
  assert(html.includes('function confirmSuspectedNotSalvageable('), `${rel}: black/death-cert flow missing`);
  assert(html.includes('function renderMstartSweep('), `${rel}: MSTART sweep missing`);
  assert(html.includes('function renderCommander('), `${rel}: commander renderer missing`);

  console.log(`${rel}: Demo V2.9916 decision-support static smoke passed`);
}
