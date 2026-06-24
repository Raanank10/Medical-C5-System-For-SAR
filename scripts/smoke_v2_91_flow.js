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

function countMatches(text, re) {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

function extractScripts(html) {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
}

function checkFile(file) {
  const rel = path.relative(root, file);
  const html = fs.readFileSync(file, 'utf8');
  const scripts = extractScripts(html);

  assert(scripts.length >= 1, `${rel}: no inline scripts found`);
  scripts.forEach((script, index) => {
    try {
      new Function(script);
    } catch (err) {
      throw new Error(`${rel}: inline script ${index + 1} does not parse: ${err.message}`);
    }
  });

  const requiredStrings = [
    'screen-demo',
    'screen-enroute',
    'screen-sweep',
    'screen-dashboard',
    'screen-aar',
    'field-mode-toggle',
    'פצוע נוסף באזור הזה',
    'מה המחברת הייתה מפספסת?',
    'supply-used-modal',
    'resupply-modal',
    'vitals-modal',
    'tourniquet-limb-modal'
  ];
  requiredStrings.forEach(s => assert(html.includes(s), `${rel}: missing ${s}`));

  const requiredFunctions = [
    'goTo',
    'activeScreenId',
    'startRoleDashboard',
    'startMstartSweep',
    'startCurrentZoneCasualtyMarker',
    'startNewCasualtyInCurrentContext',
    'startSweepCasualtyMarker',
    'completeMstartSweep',
    'renderMstartSweep',
    'startNewPatient',
    'guardedNewPatient',
    'startMedicTreatmentNow',
    'savePatient',
    'saveImmediateCasualtyAndContinue',
    'applyWalkingAutofill',
    'overrideSweepColor',
    'createDeathCertificationRequest',
    'confirmSuspectedNotSalvageable',
    'skipToSummaryBlack',
    'consumeFieldSupply',
    'showSupplyUsedSheet',
    'createResupplyRequest',
    'renderCommander',
    'renderRoleDashboard',
    'saveLocalEvent'
  ];
  requiredFunctions.forEach(fn => {
    assert(new RegExp(`function\\s+${fn}\\s*\\(`).test(html), `${rel}: missing function ${fn}`);
  });

  const requiredKeys = [
    'DEMO_STORAGE_KEY',
    'OBSERVER_NOTES_KEY',
    'CONFLICT_LOG_KEY',
    'ACTIVE_RECOVERY_KEY',
    'DEVICE_ID_KEY'
  ];
  requiredKeys.forEach(k => assert(html.includes(`const ${k}`), `${rel}: missing storage key ${k}`));
  assert(html.includes('const REINFORCEMENT_URGENCY_LABELS'), `${rel}: missing reinforcement urgency labels`);

  const wrapperStart = html.indexOf('function startNewCasualtyInCurrentContext');
  assert(wrapperStart >= 0, `${rel}: missing new-casualty wrapper`);
  const wrapperBody = html.slice(wrapperStart, wrapperStart + 700);
  ['activeScreenId', 'startSweepCasualtyMarker', 'startCurrentZoneCasualtyMarker', 'guardedNewPatient'].forEach(s => {
    assert(wrapperBody.includes(s), `${rel}: wrapper missing ${s}`);
  });

  const autofillStart = html.indexOf('function suggestedSweepColor');
  assert(autofillStart >= 0, `${rel}: missing walking autofill`);
  const autofillBody = html.slice(autofillStart, autofillStart + 1900);
  ['breathing', 'radial_strong', "avpu:'A'", 'not_trapped', "return 'green'"].forEach(s => {
    assert(autofillBody.includes(s), `${rel}: walking autofill missing ${s}`);
  });

  const treatmentStart = html.indexOf('function recordSweepTreatment');
  assert(treatmentStart >= 0, `${rel}: missing sweep treatment recorder`);
  const treatmentBody = html.slice(treatmentStart, html.indexOf('function setSweepTourniquetLimb', treatmentStart));
  ['tourniquet', 'reconcileSupplySource', 'LIFE_SAVING_TREATMENT_RECORDED'].forEach(s => {
    assert(treatmentBody.includes(s), `${rel}: treatment recorder missing ${s}`);
  });
  assert(!treatmentBody.includes("classList.remove('hidden')"), `${rel}: dedicated sweep tourniquet action must not open the legacy limb modal`);
  assert(html.includes('tourniquet-limb-modal'), `${rel}: legacy limb modal fallback removed`);
  assert(countMatches(treatmentBody, /silentPopup:true/g) >= 3, `${rel}: sweep supply use must stay silent for tourniquet, airway, and pressure dressing`);
  assert(countMatches(treatmentBody, /suppressAutoResupply:true/g) >= 3, `${rel}: sweep supply use must not auto-open resupply workflow`);
  assert(html.includes('עוד · חסר ציוד'), `${rel}: missing demoted manual sweep resupply link`);
  assert(html.includes('חסם הונח — סומן אדום/דחוף בגלל חשד לדימום מסכן חיים. ניתן לשינוי ידני.'), `${rel}: missing explainable reversible tourniquet red note`);
  assert(html.includes('confirmed:!!meta.silentPopup'), `${rel}: silently logged sweep consumption must not create confirmation debt`);

  assert(html.includes('MSTART_SWEEP_COMPLETED'), `${rel}: missing sweep completion event`);
  assert(html.includes('SUPPLY_CONSUMED'), `${rel}: missing supply consumed event`);
  assert(html.includes('doctor_death_cert'), `${rel}: missing death-cert resource type`);
  assert(countMatches(html, /<script\s+src=/gi) === 0, `${rel}: external script tag introduced`);

  return `${rel}: static smoke passed (${scripts.length} inline scripts parsed)`;
}

const results = files.map(checkFile);
console.log(results.join('\n'));
console.log('V2.91 smoke: static/hybrid checks passed. Dynamic browser checks are still required for click-level proof.');
