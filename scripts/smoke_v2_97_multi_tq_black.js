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
  const sweepRenderStart = html.indexOf('function renderMstartSweep');
  const sweepRenderEnd = html.indexOf('function timeCodeToTodayMs', sweepRenderStart);
  const sweepRender = html.slice(sweepRenderStart, sweepRenderEnd);
  const blackStart = html.indexOf('function confirmSuspectedNotSalvageable');
  const blackEnd = html.indexOf('function overrideSweepColor', blackStart);
  const blackBody = html.slice(blackStart, blackEnd);

  assert(html.includes('function ensureTourniquetArray('), `${rel}: missing legacy-compatible tourniquet array normalizer`);
  assert(html.includes('function activeTourniquets('), `${rel}: missing active tourniquet helper`);
  assert(html.includes('function longestActiveTourniquet('), `${rel}: missing longest-active tourniquet helper`);
  assert(html.includes('function syncLegacyTourniquetAlias('), `${rel}: missing legacy tourniquet alias synchronization`);
  assert(html.includes('tourniquets:[]'), `${rel}: sweep casualty marker does not initialize tourniquets array`);
  assert(treatmentBody.includes('tqList.push(tq)'), `${rel}: tourniquet tap must append instead of overwrite`);
  assert(treatmentBody.includes('syncLegacyTourniquetAlias(p)'), `${rel}: legacy tourniquet alias is not synchronized`);
  assert(treatmentBody.includes('silentPopup:true,silentWarnings:true,suppressAutoResupply:true'), `${rel}: MSTART tourniquet supply logging must stay silent`);
  assert(!treatmentBody.includes("classList.remove('hidden')"), `${rel}: blocking modal reintroduced during tourniquet application`);
  assert(sweepRender.includes('חסם שני מעליו — אותו איבר'), `${rel}: missing same-limb add-another-tourniquet action`);
  assert(sweepRender.includes('חסם בגפה אחרת'), `${rel}: missing different-limb add-another-tourniquet action`);
  assert(html.includes('בטל רישום — טעות הקלדה'), `${rel}: missing safe tourniquet correction language`);
  assert(html.includes('הארוך +${timer.minutes}'), `${rel}: ticket does not show multiple-tourniquet longest timer`);
  assert(html.includes("type:'TOURNIQUET_ENTRY_CANCELLED'"), `${rel}: correction audit event missing`);
  assert(html.includes("roleMetric(totalActiveTourniquets(patients),'חסמים פעילים')"), `${rel}: CC does not expose total active tourniquets`);
  assert(html.includes('פצועי חסם ללא מדדים מלאים'), `${rel}: AAR missing tourniquet cases without full vitals`);
  assert(blackBody.includes("p.mstart.blackContinuationOpen=true"), `${rel}: black confirmation does not open continuation panel`);
  assert(blackBody.includes("type:'DOCTOR_CERTIFICATION_REQUESTED'"), `${rel}: black confirmation audit event missing`);
  assert(sweepRender.includes("continueSweepAfterBlack('next')"), `${rel}: black continuation next-casualty handler missing`);
  assert(sweepRender.includes("continueSweepAfterBlack('finish')"), `${rel}: black continuation finish-sweep handler missing`);
  assert(sweepRender.includes('נפתחה בקשת רופא'), `${rel}: fast doctor-request confirmation panel missing`);
  assert(sweepRender.includes('סימון חובש אינו קביעת מוות רשמית'), `${rel}: medic-death-certification safety wording missing`);
  assert(html.includes('function initiateBlackTriage('), `${rel}: legacy black guardrail removed`);
  assert(html.includes('function skipToSummaryBlack('), `${rel}: legacy black skip flow removed`);
  assert(html.includes('function savePatient('), `${rel}: legacy patient save removed`);

  console.log(`${rel}: V2.98 multi-TQ and fast-black static smoke passed`);
}
