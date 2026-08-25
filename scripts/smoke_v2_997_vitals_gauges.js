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
  const opiFn = section(html, 'function renderOperationalPressureIndex(opi){', 'function renderPcNowTaskBoard');

  assert(html.includes("const APP_VERSION = '2.99.12';"), `${rel}: APP_VERSION must be V2.9912`);
  assert(html.includes('Demo V2.9912'), `${rel}: launcher label must be Demo V2.9912`);
  assert(html.includes('ROLE // V2.9912'), `${rel}: role header must be Demo V2.9912`);
  assert(html.includes('Role-Based Medical Command System V2.9912'), `${rel}: role system strip must be Demo V2.9912`);

  assert(html.includes('function renderGaugeArc('), `${rel}: reusable gauge component missing`);

  assert(openPatientFn.includes('renderGaugeArc({value:p.vitals.pulse'), `${rel}: patient detail pulse tile must use the gauge`);
  assert(openPatientFn.includes('renderGaugeArc({value:p.vitals.spo2'), `${rel}: patient detail SpO2 tile must use the gauge`);
  assert(openPatientFn.includes("from:94,to:97,color:'var(--yellow)'"), `${rel}: SpO2 gauge zones must match the existing sCol thresholds (94/97), not new ones`);
  assert(!openPatientFn.includes('bp_estimate') || openPatientFn.includes('BP_LABELS[p.vitals.bp_estimate]'), `${rel}: BP stays a categorical field-estimate label, not a fabricated numeric gauge`);
  assert(openPatientFn.includes("bpCol=bp=>"), `${rel}: BP label must be color-coded`);
  assert(openPatientFn.includes("['absent','carotid','carotid_strong','carotid_weak'].includes(bp)) return 'var(--red)'"), `${rel}: BP color must reuse computeMstartTriage's lowBP category, not new thresholds`);
  assert(openPatientFn.includes("['weak','radial_weak'].includes(bp)) return 'var(--yellow)'"), `${rel}: BP color must reuse computeMstartTriage's weakBP category, not new thresholds`);
  assert(openPatientFn.includes("['radial','radial_strong'].includes(bp)) return 'var(--green)'"), `${rel}: BP color must reuse computeMstartTriage's hasPerfusion category, not new thresholds`);

  assert(opiFn.includes('renderGaugeArc({value:opi.score'), `${rel}: PC dashboard Operational Pressure Index must use the gauge`);
  assert(opiFn.includes("from:75,to:100,color:'var(--red)'"), `${rel}: OPI gauge zones must match the existing score thresholds (35/55/75), not new ones`);

  assert(openPatientFn.includes('NEW clinical judgment'), `${rel}: pulse zones must stay flagged as a new, unreviewed clinical constant (no existing pulse threshold anywhere in this codebase)`);
  assert(openPatientFn.includes('C5Rules.isPediatricPatient(p)'), `${rel}: pulse coloring must branch on the existing pediatric check, not use one flat adult range`);
  assert(openPatientFn.includes('renderGaugeArc({value:p.vitals.pulse,min:40,max:180,needleColor:pulseCol(p.vitals.pulse),zones:pulseZones'), `${rel}: pulse gauge must be wired to the new pediatric-aware zones/color`);

  console.log(`${rel}: Demo V2.9912 vitals/OPI gauge static smoke passed`);
}
