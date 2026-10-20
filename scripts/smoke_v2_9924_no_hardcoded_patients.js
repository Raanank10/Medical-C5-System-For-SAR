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

for (const rel of files) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');

  assertVersionLabels(html, rel);

  // No hardcoded patients: commanders testing the app must only ever see patients created in the
  // field or pulled from the server - never invented casualties mixed in with real ones.
  for (const fn of ['demoPatient', 'loadDemoScenario', 'loadOmniRoleScenario', 'activateSignedDemoScenario',
    'playNotebookAdvantageDemo', 'playMedicCommanderSequence', 'playDeathCertificationSequence']) {
    assert(!new RegExp(`\\b${fn}\\(`).test(html), `${rel}: hardcoded-patient generator ${fn}() must not exist or be called`);
  }
  assert(!/startRoleDashboard\(role\)\{[\s\S]{0,600}?patients\.length\)\s*load/.test(html), `${rel}: opening a role dashboard must not auto-load patients`);
  assert(html.includes('function startPcDemo(screen){\n  goTo(screen);\n}'), `${rel}: startPcDemo must only navigate, never auto-load patients`);
  assert(html.includes('let patients = [];'), `${rel}: patients must start empty`);

  // Devices that saved the old demo state must not resurrect the fixtures on load.
  assert(html.includes("const REMOVED_DEMO_PATIENT_IDS = new Set(['P-001','P-002','P-003','P-004','P-005','P-006','P-901']);"), `${rel}: removed fixture ids must be listed for purge`);
  assert(html.includes('patients=saved.patients.filter(p=>!REMOVED_DEMO_PATIENT_IDS.has(p.id));'), `${rel}: stored state must be purged of fixture patients on load`);
  assert(/if\(REMOVED_DEMO_SITE_NAMES\.has\(siteData\.name\)\) siteData=emptySiteData\(\);\s*ensureSiteReadiness\(\);/.test(html), `${rel}: fixture site data must be purged before ensureSiteReadiness()`);
  // Real patients always get UUIDs, which is what makes the id-based purge safe.
  assert((html.match(/const id=newUuid\(\);/g) || []).length >= 3, `${rel}: real patient creation paths must use newUuid()`);

  console.log(`${rel}: Demo V2.9924 no-hardcoded-patients smoke passed`);
}
