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
  const sweepStart = html.indexOf('const limbLabels=');
  const sweepEnd = html.indexOf('function timeCodeToTodayMs', sweepStart);
  const sweep = html.slice(sweepStart, sweepEnd);
  const updateSweep = html.slice(
    html.indexOf('function updateSweepField'),
    html.indexOf('function setBreathingAfterAirway')
  );

  assert(html.includes("const APP_VERSION = '2.99.15';"), `${rel}: APP_VERSION must be V2.9915`);
  assert(!html.includes('Demo V3.0') && !html.includes("const APP_VERSION = '3.0.0';"), `${rel}: V3.0 label/version must not be present`);
  assert(sweep.includes('M — דימום מסכן חיים') || sweep.includes('דימום מסכן חיים'), `${rel}: corrected hemorrhage block title missing`);
  assert(sweep.includes("right_arm:'יד ימין'") && sweep.includes("left_arm:'יד שמאל'") && sweep.includes("right_leg:'רגל ימין'") && sweep.includes("left_leg:'רגל שמאל'"), `${rel}: sweep TQ block must use current limb vocabulary`);
  assert(!sweep.includes('right_upper') && !sweep.includes('left_upper'), `${rel}: sweep TQ block must not introduce legacy limb keys`);
  assert(sweep.includes('${triageBand(p.triage,p)}'), `${rel}: top triage band must remain visible`);
  assert(sweep.indexOf('${triageControlBlock}') > sweep.indexOf('פציעות / מיקום בגוף / הערכה מורחבת'), `${rel}: detailed MSTART override block should be rendered at bottom`);
  assert(updateSweep.includes("p.mstart.breathing='assumed_yes'"), `${rel}: AVPU A/V should mark assumed breathing, not plain yes`);
  assert(updateSweep.includes('סתירה: AVPU') && updateSweep.includes("p.mstart.breathing==='no'"), `${rel}: AVPU vs breathing=no contradiction warning missing`);
  assert(!updateSweep.includes("p.mstart.breathing='yes';"), `${rel}: AVPU handler must not auto-overwrite breathing to plain yes`);
  assert(html.includes('function assignReinforcementRequest(') && html.includes('function fulfillReinforcementRequest('), `${rel}: reinforcement actions must be named functions`);
  assert(html.includes('function showSameZoneFab(') && html.includes("activeRoleDashboard!=='medic' || activeScreenId()!=='sweep'"), `${rel}: same-zone FAB must be guarded to medic sweep context`);
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

  console.log(`${rel}: V2.9915 TQ hardening static smoke passed`);
}
