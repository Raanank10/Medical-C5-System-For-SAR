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
  const openPatientFn = section(html, 'function openPatient(id){', 'function markPatientAtCollectionPoint');
  const dashboardFn = section(html, 'function renderDashboard(){', 'function needsVitals');

  assert(html.includes("const APP_VERSION = '2.99.11';"), `${rel}: APP_VERSION must be V2.9911`);
  assert(html.includes('Demo V2.9911'), `${rel}: launcher label must be Demo V2.9911`);
  assert(html.includes('ROLE // V2.9911'), `${rel}: role header must be Demo V2.9911`);
  assert(html.includes('Role-Based Medical Command System V2.9911'), `${rel}: role system strip must be Demo V2.9911`);

  // Four age bands, additive on top of the existing binary patientAgeGroup
  assert(html.includes("const AGE_BAND_LABELS = {infant:"), `${rel}: AGE_BAND_LABELS missing`);
  assert(html.includes("const AGE_BAND_TO_GROUP = {infant:'pediatric', child:'pediatric', adult:'adult', elderly:'adult'}"), `${rel}: AGE_BAND_TO_GROUP must keep mapping infant/child->pediatric and adult/elderly->adult, so existing dosing logic is untouched`);
  assert(html.includes('function ageBandOf(p={}){'), `${rel}: ageBandOf helper missing`);

  assert(html.includes("onclick=\"selectAgeBand(this,'infant')\"") && html.includes("onclick=\"selectAgeBand(this,'child')\"") && html.includes("onclick=\"selectAgeBand(this,'adult')\"") && html.includes("onclick=\"selectAgeBand(this,'elderly')\""), `${rel}: all four age-band picker buttons must be present`);
  assert(html.includes('function selectAgeBand(btn, band){'), `${rel}: selectAgeBand function missing`);
  assert(!html.includes('function selectAgeGroup('), `${rel}: old binary selectAgeGroup should be replaced, not left dangling`);

  // Existing pediatric-dosing machinery (estimatedPediatricWeight, applyPediatricSafeDefaults,
  // pediatricDoseGuidance) must be untouched - they still key off patientAgeGroup/patientAge only.
  assert(html.includes('function estimatedPediatricWeight(){'), `${rel}: pediatric weight estimator missing`);
  assert(html.includes("if(state.patientAgeGroup!=='pediatric') return;") , `${rel}: applyPediatricSafeDefaults must still gate on patientAgeGroup, unmodified`);

  // Patient-object construction sites must all carry patientAgeBand through
  assert(html.includes("patientAgeBand:extra.patientAgeBand||(extra.patientAgeGroup==='pediatric'?'child':'adult')"), `${rel}: demoPatient must default legacy pediatric demo data to the 'child' band`);
  assert(html.includes('patientAgeBand:state.patientAgeBand||\'adult\','), `${rel}: patient creation must carry patientAgeBand through`);

  // Dashboard: badge + elderly caution line on the medic patient list
  assert(dashboardFn.includes('const ageBand=ageBandOf(p);'), `${rel}: medic dashboard patient cards must compute ageBand`);
  assert(dashboardFn.includes("ageBand==='infant'") && dashboardFn.includes("ageBand==='child'") && dashboardFn.includes("ageBand==='elderly'"), `${rel}: medic dashboard must render infant/child/elderly badges`);
  assert(dashboardFn.includes('קשיש — מדדים תקינים אינם שוללים הלם'), `${rel}: medic dashboard must show the elderly blunted-response caution line`);

  // Patient detail: age-band row + elderly caution banner
  assert(openPatientFn.includes('AGE_BAND_LABELS[ageBandOf(p)]'), `${rel}: patient detail must show the age band`);
  assert(openPatientFn.includes("ageBandOf(p)==='elderly'?"), `${rel}: patient detail must show an elderly caution banner`);

  console.log(`${rel}: Demo V2.9911 age bands static smoke passed`);
}
