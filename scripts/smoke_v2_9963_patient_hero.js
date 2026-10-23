// V2.99.63: patient detail leads with a vitals hero card; identity and triage override move down,
// and the title shows the patient number, not the UUID. String-assertion smoke, manual-only.
const fs = require('fs');
const path = require('path');
const { assertVersionLabels } = require('./lib/smoke_version');

const root = path.resolve(__dirname, '..');
function assert(c, m) { if (!c) throw new Error(m); }

const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
assertVersionLabels(html, 'index.html');
const start = html.indexOf('function openPatient(id){');
const fn = html.slice(start, html.indexOf('function markPatientAtCollectionPoint', start));
const at = (needle) => { const i = fn.indexOf(needle); assert(i >= 0, `openPatient missing: ${needle}`); return i; };

assert(fn.includes("textContent=p.visualId||p.id"), 'title must show the patient number');
assert(fn.includes('dataset.patientId=p.id') && html.includes("getElementById('detail-pid')?.dataset.patientId===p.id"), 'code that checks the open patient must use the internal id, not the title text');
const order = ['patientSyncRejectionBanner(p)', 'patient-hero', 'renderGaugeArc({value:p.vitals.pulse', 'מגמת מדדים',
  'פציעה ומיקום', 'renderPatientEvacuationCard(p)', 'עקיפת מפקד ידנית', 'זיהוי (אופציונלי)', 'Timeline'];
order.reduce((prev, needle) => { const i = at(needle); assert(i > prev, `"${needle}" is out of order`); return i; }, -1);
assert(fn.includes('patient-hero-vitals-age'), 'hero must show how old the vitals are');
assert(fn.indexOf('tq-timer') > at('patient-hero') && fn.indexOf('tq-timer') < at('מגמת מדדים'), 'tourniquet clock must stay visible in the hero');
console.log('index.html: patient hero smoke passed');
