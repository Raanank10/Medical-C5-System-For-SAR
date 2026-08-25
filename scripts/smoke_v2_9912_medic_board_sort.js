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
  const dashboardFn = section(html, 'function renderDashboard(){', 'function needsVitals');

  assert(html.includes("const APP_VERSION = '2.99.15';"), `${rel}: APP_VERSION must be V2.9915`);
  assert(html.includes('Demo V2.9915'), `${rel}: launcher label must be Demo V2.9915`);
  assert(html.includes('ROLE // V2.9915'), `${rel}: role header must be Demo V2.9915`);
  assert(html.includes('Role-Based Medical Command System V2.9915'), `${rel}: role system strip must be Demo V2.9915`);

  // Medic board uses its own strict color-then-urgency sort, not the shared blended one
  assert(dashboardFn.includes('sortedPatientsByColorThenUrgency('), `${rel}: medic dashboard must use the strict color-then-urgency sort`);
  assert(!dashboardFn.includes('const active=sortedPatients('), `${rel}: medic dashboard should no longer use the blended sortedPatients() directly`);

  // Shared blended sort (used by PC/CC/command screens) must be untouched
  assert(html.includes('function patientPriorityScore(p){'), `${rel}: shared patientPriorityScore must still exist, unmodified`);
  assert(html.includes('function sortedPatients(list=patients){'), `${rel}: shared sortedPatients must still exist, unmodified`);
  assert(html.includes('return [...list].sort((a,b)=>patientPriorityScore(a)-patientPriorityScore(b) || String(a.id).localeCompare(String(b.id)));'), `${rel}: shared sortedPatients body must be unchanged`);

  // Color is strictly primary: color*10 always dominates urgency (0-8), so no urgency signal
  // can push a patient across a color boundary.
  assert(html.includes('function medicBoardUrgencyScore(p){'), `${rel}: medicBoardUrgencyScore missing`);
  assert(html.includes("const colorOrder = {red:0, yellow:1, green:2, black:3, pending:4, unknown:4};"), `${rel}: color order must be red<yellow<green<black/pending`);
  assert(html.includes('return color*10 + medicBoardUrgencyScore(p);'), `${rel}: color must be weighted strictly above urgency (color*10 dominates an urgency range of 0-8)`);

  // Urgency tiers reuse the exact same signals as the existing shared patientPriorityScore
  // (active alert, deterioration, tourniquet, trapped, stale vitals, needs full assessment) -
  // no new clinical judgment introduced.
  ['p.alert===true && !p.alertAcknowledgedAt', 'p.deterioration && p.deterioration.length > 0', '!!p.tourniquet', "normalizeTrapStatus(p)==='trapped'", 'isVitalsOverdue(p)'].forEach(sig => {
    assert(html.includes(sig), `${rel}: medic board urgency scoring must reuse existing signal: ${sig}`);
  });

  console.log(`${rel}: Demo V2.9915 medic board color-then-urgency sort static smoke passed`);
}
