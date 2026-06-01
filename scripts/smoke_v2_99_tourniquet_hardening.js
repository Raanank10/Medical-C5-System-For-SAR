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
  const treatment = html.slice(
    html.indexOf('function recordSweepTreatment'),
    html.indexOf('function setSweepTourniquetLimb')
  );
  const effectiveness = html.slice(
    html.indexOf('function markSweepTourniquetEffectiveness'),
    html.indexOf('function addSweepTourniquetSameLimb')
  );
  const sameLimb = html.slice(
    html.indexOf('function addSweepTourniquetSameLimb'),
    html.indexOf('function addSweepTourniquetDifferentLimb')
  );
  const sweep = html.slice(
    html.indexOf('function renderMstartSweep'),
    html.indexOf('function timeCodeToTodayMs')
  );

  assert(html.includes("const APP_VERSION = '2.98.0';"), `${rel}: hardening patch must not bump version`);
  assert(html.includes("hemorrhageControl:{status:'unknown',lastCheckedAt:null,sourceTourniquetId:null,note:''}"), `${rel}: marker hemorrhage control default missing`);
  assert(html.includes('function ensureHemorrhageControl('), `${rel}: hemorrhage control normalizer missing`);
  assert(html.includes('function refreshHemorrhageControl('), `${rel}: hemorrhage control refresh missing`);
  assert(treatment.includes("sourceTourniquetId:meta.sourceTourniquetId||null"), `${rel}: TQ lineage field missing`);
  assert(treatment.includes('sequenceOnLimb'), `${rel}: per-limb TQ sequence missing`);
  assert(treatment.includes("placementRelation:meta.placementRelation||null"), `${rel}: TQ placement relation missing`);
  assert(treatment.includes("bleedingStatusAtApplication:meta.bleedingStatusAtApplication||'unknown'"), `${rel}: bleeding-at-application field missing`);
  assert(effectiveness.includes("tq.ineffectiveAt=effectiveness==='bleeding_continues'?tq.effectivenessUpdatedAt"), `${rel}: ineffective timestamp missing`);
  assert(effectiveness.includes('refreshHemorrhageControl(p,tq)'), `${rel}: casualty hemorrhage state is not refreshed`);
  assert(sameLimb.includes("sourceTourniquetId:source?.id||null"), `${rel}: failed source TQ is not linked`);
  assert(sameLimb.includes("placementRelation:'above_previous'"), `${rel}: same-limb TQ is not documented above previous`);
  assert(sameLimb.includes("bleedingStatusAtApplication:'bleeding_continues'"), `${rel}: failed-TQ continuation state missing`);
  assert(html.includes('הוסף חסם שני מעליו'), `${rel}: fast failed-TQ action missing`);
  assert(html.includes('חסם שני מעליו — אותו איבר'), `${rel}: same-limb choice missing`);
  assert(html.includes('חסם בגפה אחרת'), `${rel}: different-limb choice missing`);
  assert(treatment.includes('silentPopup:true,silentWarnings:true,suppressAutoResupply:true'), `${rel}: silent sweep supply logging removed`);
  assert(!treatment.includes("classList.remove('hidden')"), `${rel}: blocking sweep modal reintroduced`);
  assert(html.includes("function removeLastSweepTourniquet(){ return cancelLastTourniquetEntry(); }"), `${rel}: legacy correction wrapper removed`);
  assert(html.includes("const longestTqMinutes=Math.max(0,...patients.map"), `${rel}: AAR longest timer spread guard missing`);
  assert(html.includes('function confirmSuspectedNotSalvageable('), `${rel}: black flow removed`);
  assert(html.includes("continueSweepAfterBlack('next')"), `${rel}: black next action removed`);
  assert(html.includes("continueSweepAfterBlack('finish')"), `${rel}: black finish action removed`);
  assert(html.includes('function startNewPatient('), `${rel}: legacy fallback removed`);

  console.log(`${rel}: V2.99 TQ hardening static smoke passed`);
}
