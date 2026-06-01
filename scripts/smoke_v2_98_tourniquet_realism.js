const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  path.join(root, 'index.html'),
  path.join(root, 'demo', 'rescue-app.html')
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const file of files) {
  const rel = path.relative(root, file);
  const html = fs.readFileSync(file, 'utf8');
  const treatmentStart = html.indexOf('function recordSweepTreatment');
  const treatmentEnd = html.indexOf('function setSweepTourniquetLimb', treatmentStart);
  const treatmentBody = html.slice(treatmentStart, treatmentEnd);
  const sweepStart = html.indexOf('function renderMstartSweep');
  const sweepEnd = html.indexOf('function timeCodeToTodayMs', sweepStart);
  const sweepBody = html.slice(sweepStart, sweepEnd);
  const blackStart = html.indexOf('function confirmSuspectedNotSalvageable');
  const blackEnd = html.indexOf('function overrideSweepColor', blackStart);
  const blackBody = html.slice(blackStart, blackEnd);

  assert(html.includes("const APP_VERSION = '2.98.0';"), `${rel}: APP_VERSION must be V2.98`);
  assert(html.includes('Demo V2.98'), `${rel}: launcher label must be V2.98`);
  assert(html.includes('function ensureTourniquetArray('), `${rel}: legacy-compatible TQ normalizer missing`);
  assert(html.includes("status:p.tourniquet.status||'active'"), `${rel}: legacy TQ alias migration missing`);
  assert(html.includes("effectiveness:p.tourniquet.effectiveness||'unknown'"), `${rel}: legacy TQ effectiveness default missing`);
  assert(treatmentBody.includes("effectiveness:'unknown'"), `${rel}: new TQ effectiveness default missing`);
  assert(treatmentBody.includes("reasonForAdditional:meta.reasonForAdditional||null"), `${rel}: new TQ additional reason missing`);
  assert(treatmentBody.includes("type:'TOURNIQUET_APPLIED'"), `${rel}: dedicated TQ applied event missing`);
  assert(treatmentBody.includes('silentPopup:true,silentWarnings:true,suppressAutoResupply:true'), `${rel}: sweep supply logging is not silent`);
  assert(!treatmentBody.includes("classList.remove('hidden')"), `${rel}: blocking TQ modal reintroduced`);
  assert(html.includes("tq.status=effectiveness==='bleeding_continues'?'ineffective':'active'"), `${rel}: ineffective TQ state missing`);
  assert(html.includes("type=effectiveness==='bleeding_continues'?'TOURNIQUET_MARKED_INEFFECTIVE':'TOURNIQUET_MARKED_EFFECTIVE'"), `${rel}: TQ effectiveness events missing`);
  assert(html.includes("reasonForAdditional:'same_limb_bleeding_continues'"), `${rel}: same-limb second TQ path missing`);
  assert(html.includes("reasonForAdditional:'different_limb'"), `${rel}: different-limb second TQ path missing`);
  assert(html.includes("tq.status='removed_error'"), `${rel}: correction does not use removed_error`);
  assert(html.includes("type:'TOURNIQUET_ENTRY_CANCELLED'"), `${rel}: correction audit event missing`);
  assert(html.includes('function removeLastSweepTourniquet(){ return cancelLastTourniquetEntry(); }'), `${rel}: legacy correction wrapper removed`);
  assert(sweepBody.includes('חסמי עורקים / שליטה בדימום'), `${rel}: dedicated TQ treatment section missing`);
  assert(html.includes('דימום ממשיך / חסם לא יעיל'), `${rel}: ineffective TQ field action missing`);
  assert(sweepBody.includes('חסם נוסף — אותו איבר / דימום ממשיך'), `${rel}: same-limb TQ button missing`);
  assert(sweepBody.includes('חסם נוסף — גפה אחרת'), `${rel}: different-limb TQ button missing`);
  assert(html.includes('בטל רישום — טעות הקלדה'), `${rel}: safe correction wording missing`);
  assert(html.includes("roleMetric(ineffectiveTqs.length,'חסמים לא יעילים')"), `${rel}: CC ineffective aggregate missing`);
  assert(html.includes('פצועים עם כמה חסמים'), `${rel}: AAR multiple-TQ KPI missing`);
  assert(html.includes('דק׳ מכשל לחסם נוסף'), `${rel}: AAR second-TQ delay missing`);
  assert(html.includes('ניתן להוסיף חסם נוסף באותה גפה אם דימום ממשיך או בגפה אחרת'), `${rel}: launcher multi-TQ guide missing`);
  assert(blackBody.includes("p.mstart.blackContinuationOpen=true"), `${rel}: black continuation broken`);
  assert(blackBody.includes("type:'DOCTOR_CERTIFICATION_REQUESTED'"), `${rel}: doctor certification event broken`);
  assert(sweepBody.includes("continueSweepAfterBlack('next')"), `${rel}: black next-casualty action broken`);
  assert(sweepBody.includes("continueSweepAfterBlack('finish')"), `${rel}: black finish-sweep action broken`);
  assert(html.includes('function startNewPatient('), `${rel}: legacy patient fallback removed`);

  console.log(`${rel}: V2.98 tourniquet realism static smoke passed`);
}
