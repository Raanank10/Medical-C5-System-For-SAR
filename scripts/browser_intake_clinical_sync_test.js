// Real-browser test for V2.99.36 (docs/GAP_CLOSURE_PLAN.md WP-3): treatments, medications,
// pediatric high-risk confirmations and injury zones reach the outbox with the patient's id,
// under event names the server knows, and after the event that creates the patient.
//
// Before: treatments were logged as INTERVENTION_LOGGED / IMMEDIATE_INTERVENTION_RECORDED /
// LIFE_SAVING_TREATMENT_RECORDED (client-only names, never sent), and intake medications were
// queued before PATIENT_CREATED with no patient id, so the server could not place them.
//
// Runs in local demo mode and calls the page's own functions; this proves client behavior only,
// not the server side.
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_intake_clinical_sync_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html'), path.join(root, 'demo', 'rescue-app.html')];
const PIN = '135790';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.fill('#pin-gate-setup-new', PIN);
  await page.fill('#pin-gate-setup-confirm', PIN);
  await page.click('#pin-gate-setup-btn');
  await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });

  // 1. Two full-flow patients in a row, each with its own treatments, injuries and medication.
  const flow = await page.evaluate(() => {
    patients = [];
    quickTqData.applied = false;
    const run = (interventions, zones, extra) => {
      state = freshState();
      state.flowMode = 'full';
      state.triage = 'yellow';
      state.trapStatus = 'not_trapped';
      state.injury = 'שבר';
      zones.forEach((z) => state.injuryZones.add ? state.injuryZones.add(z) : state.injuryZones.push(z));
      interventions.forEach((k) => state.interventions.add(k));
      if (extra) extra();
      // In-flow medication entry, as the New Patient flow writes it before the patient exists.
      queueMedicationEventsBeforeSave();
      const inFlowMeds = getOutbox().filter((e) => e.type === 'MEDICATION_ADMINISTERED' && !e.patient_id).map((e) => ({ synced: e.synced, localOnly: !!e.localOnly }));
      const before = getOutbox().length;
      savePatient();
      const p = patients[patients.length - 1];
      // Supply events (an automatic resupply request when stock runs low) are not patient events.
      const added = getOutbox().slice(before).filter((e) => SYNC_ELIGIBLE_EVENT_TYPES.has(e.type) && !e.localOnly && !/SUPPLY|RESUPPLY/.test(e.type));
      return {
        pid: p.id,
        inFlowMeds,
        added: added.map((e) => ({ type: e.type, pid: e.patient_id, synced: e.synced, payload: e.payload_json })),
      };
    };
    const a = run(['bandage', 'iv', 'morphine', 'tourniquet'], ['head', 'chest']);
    const b = run(['fluids', 'airway_mgmt', 'other_tx'], ['left_leg'], () => { const el = document.getElementById('other-tx-text'); if (el) el.value = 'קיבוע'; });
    return { a, b };
  });
  for (const [name, r] of Object.entries(flow)) {
    assert(r.added.length > 0, `${rel}: patient ${name} produced no synced events`);
    assert(/PATIENT_CREATED$/.test(r.added[0].type), `${rel}: patient ${name}: the create event must come first, got ${r.added.map((e) => e.type)}`);
    assert(r.added.every((e) => e.pid === r.pid && e.synced === false), `${rel}: patient ${name}: every synced event must carry this patient's id and be queued for push`);
    assert(r.inFlowMeds.every((m) => m.synced && m.localOnly), `${rel}: patient ${name}: in-flow medication entries without a patient must stay local`);
  }
  assert(flow.a.pid !== flow.b.pid, `${rel}: two patients must get two ids`);
  const aTypes = flow.a.added.map((e) => e.type);
  const aTx = flow.a.added.filter((e) => e.type === 'INTERVENTION_RECORDED').map((e) => e.payload.treatment_type).sort();
  assert(aTx.join() === 'bandage,iv', `${rel}: patient a must send bandage and iv as INTERVENTION_RECORDED, got ${aTx}`);
  const aMed = flow.a.added.filter((e) => e.type === 'MEDICATION_ADMINISTERED');
  assert(aMed.length === 1 && aMed[0].payload.medication === 'Morphine', `${rel}: patient a must send one patient-scoped morphine, got ${JSON.stringify(aMed)}`);
  assert(!flow.a.added.some((e) => e.type === 'INTERVENTION_RECORDED' && ['tourniquet', 'morphine'].includes(e.payload.treatment_type)), `${rel}: tourniquets and medications must not also be sent as treatments`);
  const aCreate = flow.a.added[0].payload;
  assert(JSON.stringify(aCreate.injury_zones) === JSON.stringify(['head', 'chest']) && aCreate.injury_mechanism === 'שבר', `${rel}: the create event must carry injury zones and mechanism, got ${JSON.stringify(aCreate)}`);
  assert(aTypes.indexOf('MEDICATION_ADMINISTERED') > 0, `${rel}: medication must come after the create event`);
  const bTypes = flow.b.added.map((e) => e.type);
  assert(bTypes.includes('AIRWAY_MANAGED'), `${rel}: patient b's airway must be sent as AIRWAY_MANAGED, got ${bTypes}`);
  const bTx = flow.b.added.filter((e) => e.type === 'INTERVENTION_RECORDED').map((e) => `${e.payload.treatment_type}:${e.payload.treatment_label}`).sort();
  assert(bTx.join() === 'fluids:נוזלים IV,other_tx:קיבוע', `${rel}: patient b must send fluids and the typed other treatment, got ${bTx}`);
  assert(!bTypes.includes('MEDICATION_ADMINISTERED'), `${rel}: patient b had no medication`);

  // 2. Pediatric high-risk override: confirmation and medication, both patient-scoped, confirmation first.
  const peds = await page.evaluate(() => {
    state = freshState();
    state.flowMode = 'full';
    state.triage = 'red';
    state.trapStatus = 'not_trapped';
    state.injury = 'כוויה';
    state.patientAgeGroup = 'pediatric';
    state.interventions.add('morphine');
    state.pediatricOverrides.morphine = { dose: doses.morphine, reason: 'test reason' };
    const before = getOutbox().length;
    savePatient();
    const p = patients[patients.length - 1];
    const added = getOutbox().slice(before).filter((e) => SYNC_ELIGIBLE_EVENT_TYPES.has(e.type) && !e.localOnly && !/SUPPLY|RESUPPLY/.test(e.type));
    return { pid: p.id, added: added.map((e) => ({ type: e.type, pid: e.patient_id, payload: e.payload_json })) };
  });
  const pTypes = peds.added.map((e) => e.type);
  const hro = pTypes.indexOf('HIGH_RISK_OVERRIDE_CONFIRMED');
  const pm = pTypes.indexOf('MEDICATION_ADMINISTERED');
  assert(hro > 0 && pm > hro, `${rel}: the high-risk confirmation must follow the create event and precede the medication, got ${pTypes}`);
  assert(peds.added.every((e) => e.pid === peds.pid), `${rel}: pediatric override events must carry the patient id`);
  assert(peds.added[pm].payload.is_pediatric_override === true && peds.added[pm].payload.high_risk_override?.reason === 'test reason', `${rel}: the medication must carry the override`);

  // 3. Vitals-update modal: treatments and medication reach the server for an existing patient.
  const modal = await page.evaluate(() => {
    const p = { id: 'cccccccc-0000-4000-8000-000000000001', visualId: 'P-MODAL', triage: 'yellow', patientStatus: 'observing', events: [], txHistory: [], siteId: 'SITE_A' };
    patients.push(p);
    modalTreatments = new Set(['bandage', 'morphine', 'cpr']);
    const before = getOutbox().length;
    queueModalTreatmentEvents(p, 'חבישה, מורפיום, החייאה', 'medic-test');
    const added = getOutbox().slice(before).filter((e) => SYNC_ELIGIBLE_EVENT_TYPES.has(e.type) && !/SUPPLY|RESUPPLY/.test(e.type));
    return { pid: p.id, added: added.map((e) => ({ type: e.type, pid: e.patient_id, payload: e.payload_json })) };
  });
  const mTx = modal.added.filter((e) => e.type === 'INTERVENTION_RECORDED').map((e) => e.payload.treatment_type).sort();
  assert(mTx.join() === 'bandage,cpr', `${rel}: modal treatments must be sent as INTERVENTION_RECORDED, got ${mTx}`);
  const mMed = modal.added.filter((e) => e.type === 'MEDICATION_ADMINISTERED');
  assert(mMed.length === 1 && mMed[0].payload.dosage === null && mMed[0].payload.source === 'vitals_modal', `${rel}: modal morphine must be sent with no dosage, got ${JSON.stringify(mMed)}`);
  assert(modal.added.every((e) => e.pid === modal.pid), `${rel}: modal events must carry the patient id`);

  // 4. Immediate life-saving action without a tourniquet: create first, then AIRWAY_MANAGED.
  const immediate = await page.evaluate(() => {
    siteData.name = siteData.name || 'אתר בדיקה';
    const before = getOutbox().length;
    createImmediateInterventionPatient('airway');
    const added = getOutbox().slice(before).filter((e) => SYNC_ELIGIBLE_EVENT_TYPES.has(e.type) && !/SUPPLY|RESUPPLY/.test(e.type));
    return added.map((e) => ({ type: e.type, pid: e.patient_id }));
  });
  assert(immediate.length === 2 && immediate[0].type === 'QUICK_PATIENT_CREATED' && immediate[1].type === 'AIRWAY_MANAGED' && immediate[1].pid === immediate[0].pid,
    `${rel}: an immediate airway action must create the patient then send AIRWAY_MANAGED, got ${JSON.stringify(immediate)}`);

  assert(pageErrors.length === 0, `${rel}: uncaught page error(s): ${pageErrors.join(' | ')}`);
  await page.close();
  console.log(`${rel}: intake clinical sync browser test passed`);
}

async function main() {
  for (const file of files) assert(fs.existsSync(file), `missing file: ${path.relative(root, file)}`);
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  try {
    for (const file of files) await checkFile(browser, file);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
