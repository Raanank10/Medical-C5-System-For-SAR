const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['index.html', path.join('demo', 'rescue-app.html')];

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
  const demoScenario = section(html, 'function loadDemoScenario', 'function activateSignedDemoScenario');

  assert(html.includes("const APP_VERSION = '2.99.15';"), `${rel}: APP_VERSION must be Demo V2.9915`);
  assert(html.includes('Demo V2.9915'), `${rel}: launcher label must be Demo V2.9915`);
  assert(html.includes('ROLE // V2.9915'), `${rel}: role header must be Demo V2.9915`);
  assert(html.includes('Role-Based Medical Command System V2.9915'), `${rel}: role system strip must be Demo V2.9915`);
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

  assert(demoScenario.includes('tourniquet:{limb') && demoScenario.includes('minutesAgo(42)'), `${rel}: demo scenario must trigger tourniquet overdue`);
  assert(demoScenario.includes('deterioration:['), `${rel}: demo scenario must trigger patient deterioration`);
  assert(demoScenario.includes("resourceType:'paramedic'") && demoScenario.includes('minutesAgo(8)'), `${rel}: demo scenario must trigger doctor/paramedic gap`);
  assert(demoScenario.includes("reasonCodes:['red_patient','tourniquet','evac_delay']"), `${rel}: demo scenario must trigger evacuation delay`);
  assert(demoScenario.includes('pcTruckStock={...PC_TRUCK_BASELINE') && demoScenario.includes('tourniquets:4'), `${rel}: demo scenario must trigger supply burn`);

  assert(html.includes('function startNewPatient('), `${rel}: legacy startNewPatient missing`);
  assert(html.includes('function guardedNewPatient('), `${rel}: legacy guardedNewPatient missing`);
  assert(html.includes('function confirmSuspectedNotSalvageable('), `${rel}: black/death-cert flow missing`);
  assert(html.includes('function renderMstartSweep('), `${rel}: MSTART sweep missing`);
  assert(html.includes('function renderCommander('), `${rel}: commander renderer missing`);

  console.log(`${rel}: Demo V2.9915 decision-support static smoke passed`);
}
