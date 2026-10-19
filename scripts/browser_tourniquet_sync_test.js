// Real-browser test for V2.99.34 New Patient flow sync (tourniquets, create event, vitals):
// 1. The New Patient flow sends one patient-scoped TOURNIQUET_APPLIED per limb, after
//    PATIENT_CREATED, with the time the medic entered. The in-flow event logged before the
//    patient existed stays local (no patient_id, the server could never place it).
// 2. An MSTART sweep typo-cancel releases the server row only when no other active tourniquet
//    on this device shares that server limb.
// 3. Another device's patient gets its active tourniquets (and timer) from the server's
//    tourniquets table; a patient created on this device is never overwritten.
// 4. The same flow fix for the create event and vitals: a quick capture is created with
//    QUICK_PATIENT_CREATED (the server sets needs_full_assessment only for that type) and sends
//    no vitals; a full-flow save sends VITALS_RECORDED with the patient id so other devices get
//    last_vitals_at. The in-flow copies without a patient stay local.
//
// Runs in local demo mode and calls the page's own functions; no Supabase client is involved,
// so this proves client behavior only, not the server-side projection.
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_tourniquet_sync_test.js
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

  // 1. New Patient flow with a tourniquet on two limbs at 10:15.
  const flow = await page.evaluate(() => {
    patients = [];
    state = freshState();
    state.flowMode = 'quick';
    state.needsFullAssessment = true;
    state.triage = 'red';
    state.trapStatus = 'not_trapped';
    state.injury = 'דימום';
    quickTqData.applied = true;
    quickTqData.time = '1015';
    quickTqData.limbs = new Set(['yl', 'rr']);
    projectPatientStatus('stabilizing', 'TOURNIQUET_APPLIED', { source: 'quick_patient_flow' });
    saveLocalEvent({ type: 'QUICK_PATIENT_CREATED', detail: 'in-flow', payload_json: { needs_full_assessment: true } });
    const before = getOutbox().length;
    const inFlow = getOutbox().filter((e) => e.type === 'TOURNIQUET_APPLIED' && !e.patient_id);
    savePatient();
    const p = patients[patients.length - 1];
    const added = getOutbox().slice(before);
    return {
      inFlow: inFlow.map((e) => ({ synced: e.synced, localOnly: !!e.localOnly })),
      inFlowCreate: getOutbox().filter((e) => e.type === 'QUICK_PATIENT_CREATED' && !e.patient_id).map((e) => !!e.localOnly),
      create: added.filter((e) => /PATIENT_CREATED$/.test(e.type)).map((e) => ({ type: e.type, nfa: e.payload_json.needs_full_assessment })),
      order: added.map((e) => e.type),
      tq: added.filter((e) => e.type === 'TOURNIQUET_APPLIED').map((e) => ({ pid: e.patient_id, synced: e.synced, limb: e.payload_json.limb, at: e.payload_json.application_time })),
      patientId: p.id,
      localCount: activeTourniquets(p).length,
      expectedAt: new Date(C5Rules.timeCodeToTodayMs('1015')).toISOString(),
    };
  });
  assert(flow.inFlow.length === 1 && flow.inFlow[0].synced === true && flow.inFlow[0].localOnly, `${rel}: the in-flow tourniquet event without a patient must stay local`);
  assert(flow.tq.length === 2, `${rel}: expected one TOURNIQUET_APPLIED per limb, got ${flow.tq.length}`);
  assert(flow.tq.every((t) => t.pid === flow.patientId && t.synced === false), `${rel}: flow tourniquets must carry the new patient id and be queued for push`);
  assert(flow.tq.map((t) => t.limb).sort().join() === 'left_arm,right_leg', `${rel}: limbs must map to tourniquet limb keys, got ${flow.tq.map((t) => t.limb)}`);
  assert(flow.tq.every((t) => t.at === flow.expectedAt), `${rel}: application_time must be the time the medic entered`);
  assert(flow.order.indexOf('PATIENT_CREATED') < flow.order.indexOf('TOURNIQUET_APPLIED'), `${rel}: PATIENT_CREATED must be queued before the tourniquet events`);
  assert(flow.localCount === 2, `${rel}: the medic's own patient must show both tourniquets, got ${flow.localCount}`);
  assert(flow.inFlowCreate.length === 1 && flow.inFlowCreate[0], `${rel}: the in-flow QUICK_PATIENT_CREATED without a patient must stay local`);
  assert(flow.create.length === 1 && flow.create[0].type === 'QUICK_PATIENT_CREATED' && flow.create[0].nfa === true, `${rel}: a quick capture must be created with QUICK_PATIENT_CREATED, got ${JSON.stringify(flow.create)}`);
  assert(!flow.order.includes('VITALS_RECORDED'), `${rel}: a quick capture must not send vitals (it would clear needs_full_assessment)`);

  // 4. Full flow with vitals taken.
  const full = await page.evaluate(() => {
    state = freshState();
    state.flowMode = 'full';
    state.triage = 'yellow';
    state.trapStatus = 'not_trapped';
    state.injury = 'שבר';
    quickTqData.applied = false;
    projectPatientStatus('observing', 'VITALS_RECORDED');
    const inFlow = getOutbox().filter((e) => e.type === 'VITALS_RECORDED' && !e.patient_id).map((e) => !!e.localOnly);
    const before = getOutbox().length;
    savePatient();
    const p = patients[patients.length - 1];
    const added = getOutbox().slice(before);
    return { inFlow, pid: p.id, added: added.map((e) => ({ type: e.type, pid: e.patient_id, synced: e.synced })) };
  });
  assert(full.inFlow.length >= 1 && full.inFlow.every(Boolean), `${rel}: the in-flow VITALS_RECORDED without a patient must stay local`);
  const fullTypes = full.added.map((e) => e.type);
  assert(fullTypes[0] === 'PATIENT_CREATED', `${rel}: a full-flow save must create with PATIENT_CREATED, got ${fullTypes}`);
  const vit = full.added.find((e) => e.type === 'VITALS_RECORDED');
  assert(vit && vit.pid === full.pid && vit.synced === false, `${rel}: full-flow vitals must be sent with the new patient id`);
  assert(!fullTypes.includes('TOURNIQUET_APPLIED'), `${rel}: no tourniquet event without a tourniquet`);

  // 2. Typo-cancel releases the server row only when it is the last one on that server limb.
  const cancel = await page.evaluate(() => {
    const p = { id: 'bbbbbbbb-0000-4000-8000-000000000001', visualId: 'P-SWEEP', triage: 'red', events: [], vitals: { ...VITALS_NOT_ON_DEVICE }, siteId: 'SITE_A',
      tourniquets: [
        { id: 'TQ-001', appliedAt: Date.now() - 60000, limb: 'unknown', serverLimb: 'unknown', status: 'active', effectiveness: 'unknown' },
        { id: 'TQ-002', appliedAt: Date.now() - 30000, limb: 'left_leg', serverLimb: 'unknown', status: 'active', effectiveness: 'unknown' },
      ] };
    patients.push(p);
    activeSweepPatientId = p.id;
    const before = getOutbox().length;
    cancelLastTourniquetEntry('TQ-002');
    const first = getOutbox().slice(before).map((e) => e.type);
    const mid = getOutbox().length;
    cancelLastTourniquetEntry('TQ-001');
    const second = getOutbox().slice(mid).filter((e) => e.type === 'TOURNIQUET_RELEASED').map((e) => e.payload_json);
    return { first, second };
  });
  assert(!cancel.first.includes('TOURNIQUET_RELEASED'), `${rel}: cancelling one of two tourniquets on the same server limb must not release the server row`);
  assert(cancel.second.length === 1 && cancel.second[0].limb === 'unknown' && cancel.second[0].reason === 'entry_cancelled', `${rel}: cancelling the last one must release its server limb`);

  // 3. Server tourniquets reach another device's patient, never a local one.
  const read = await page.evaluate(() => {
    const inc = SITE_TO_INCIDENT_ID.SITE_A;
    const remoteId = 'cccccccc-0000-4000-8000-000000000001';
    const localId = 'cccccccc-0000-4000-8000-000000000002';
    patients = [
      { id: remoteId, visualId: 'P-REMOTE', triage: 'red', sourcedFromRemote: true, siteId: 'SITE_A', tourniquets: [], tourniquet: null, events: [], vitals: { ...VITALS_NOT_ON_DEVICE } },
      { id: localId, visualId: 'P-LOCAL', triage: 'red', siteId: 'SITE_A', tourniquets: [{ id: 'TQ-001', appliedAt: Date.now(), limb: 'left_arm', status: 'active' }], events: [], vitals: { ...VITALS_BASELINE } },
    ];
    const applied = new Date(Date.now() - 65 * 60000).toISOString();
    applyServerTourniquets([
      { id: 't1', patient_id: remoteId, limb: 'right_leg', applied_at: applied, is_active: true },
      { id: 't2', patient_id: remoteId, limb: 'unknown', applied_at: applied, is_active: true },
      { id: 't3', patient_id: localId, limb: 'right_arm', applied_at: applied, is_active: true },
    ], inc);
    const remote = patients.find((p) => p.id === remoteId);
    const local = patients.find((p) => p.id === localId);
    const label = tourniquetTimerLabel(remote);
    const afterRemote = activeTourniquets(remote).length;
    applyServerTourniquets([], inc);
    return { afterRemote, label, localLimbs: activeTourniquets(local).map((t) => t.limb), cleared: activeTourniquets(remote).length, alias: remote.tourniquet };
  });
  assert(read.afterRemote === 2, `${rel}: the remote patient must get both server tourniquets`);
  assert(read.label && read.label.cls === 'warn' && /65/.test(read.label.label), `${rel}: the remote tourniquet timer must run from the server application time, got ${JSON.stringify(read.label)}`);
  assert(read.localLimbs.join() === 'left_arm', `${rel}: a patient created on this device must keep its own tourniquets`);
  assert(read.cleared === 0 && read.alias === null, `${rel}: a released server tourniquet must disappear from the remote patient`);

  assert(pageErrors.length === 0, `${rel}: uncaught page error(s): ${pageErrors.join(' | ')}`);
  await page.close();
  console.log(`${rel}: tourniquet sync browser test passed`);
}

async function main() {
  for (const file of files) assert(fs.existsSync(file), `missing file: ${path.relative(root, file)}`);
  // Same pre-installed Chromium preference as scripts/browser_smoke_test.js.
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
