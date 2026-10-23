// Real-browser test for V2.99.42 tourniquet follow-ups (docs/GAP_CLOSURE_PLAN.md WP-2b,
// database/056-057):
// 1. A limb recorded after application is sent as a patient-scoped TOURNIQUET_LIMB_RECORDED with
//    the limb the server row was created with (previous_limb) and the application time.
// 2. An effectiveness check is sent as TOURNIQUET_REASSESSMENT for the server limb, with the
//    30-minute cadence the server uses for clinical_context 'unknown'; the MARKED_* note stays local.
// 3. A tourniquet ticked in the vitals-update screen starts a real tourniquet (timer, limb to be
//    recorded) and is sent; a second tick while one is active does not restart the timer.
// 4. Another device's tourniquet shows the effectiveness the server row carries.
//
// Runs in local demo mode and calls the page's own functions; this proves client behavior only.
// The server side (057) is verified against the live database separately.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_tourniquet_followups_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const page = await browser.newPage();
  // No backend in this test: serve an empty supabase-js instead of waiting on the CDN, which
  // otherwise holds DOMContentLoaded (a slow jsDelivr response timed page.goto out in CI).
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.fill('#pin-gate-setup-new', PIN);
  await page.fill('#pin-gate-setup-confirm', PIN);
  await page.click('#pin-gate-setup-btn');
  await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });

  // 1-2. MSTART sweep: tourniquet applied without a limb, limb recorded later, then checked.
  const sweep = await page.evaluate(() => {
    const applied = Date.now() - 20 * 60000;
    const p = { id: 'dddddddd-0000-4000-8000-000000000001', visualId: 'P-TQ', triage: 'red', events: [], vitals: { ...VITALS_NOT_ON_DEVICE }, siteId: 'SITE_A', mstart: {},
      tourniquets: [{ id: 'TQ-001', appliedAt: applied, limb: 'unknown', serverLimb: 'unknown', status: 'active', effectiveness: 'unknown' }] };
    patients.push(p);
    activeSweepPatientId = p.id;
    pendingTourniquetLimbPatientId = p.id;
    const before = getOutbox().length;
    setSweepTourniquetLimb('left_leg', 'TQ-001');
    const limbEvents = getOutbox().slice(before).map((e) => ({ type: e.type, pid: e.patient_id, synced: e.synced, payload: e.payload_json }));
    const mid = getOutbox().length;
    markSweepTourniquetEffectiveness('TQ-001', 'bleeding_continues');
    const checkEvents = getOutbox().slice(mid).map((e) => ({ type: e.type, pid: e.patient_id, synced: e.synced, payload: e.payload_json }));
    return { applied, limbEvents, checkEvents, serverLimb: p.tourniquets[0].serverLimb };
  });
  const limb = sweep.limbEvents.filter((e) => e.type === 'TOURNIQUET_LIMB_RECORDED');
  assert(limb.length === 1 && limb[0].pid && limb[0].synced === false, `${rel}: the later limb must be queued for push, patient-scoped (got ${JSON.stringify(sweep.limbEvents)})`);
  assert(limb[0].payload.limb === 'left_leg' && limb[0].payload.previous_limb === 'unknown' && Date.parse(limb[0].payload.application_time) === sweep.applied,
    `${rel}: the limb event must carry the new limb, the server limb it replaces and the application time (got ${JSON.stringify(limb[0].payload)})`);
  assert(sweep.serverLimb === 'left_leg', `${rel}: after the limb event the server limb must follow`);
  const reassess = sweep.checkEvents.filter((e) => e.type === 'TOURNIQUET_REASSESSMENT');
  assert(reassess.length === 1 && reassess[0].synced === false && reassess[0].payload.limb === 'left_leg' && reassess[0].payload.tourniquet_status === 'bleeding_continues'
    && reassess[0].payload.next_reassessment_interval_minutes === 30, `${rel}: an effectiveness check must be sent as a reassessment of the server limb (got ${JSON.stringify(sweep.checkEvents)})`);
  assert(sweep.checkEvents.filter((e) => /MARKED_/.test(e.type)).every((e) => e.synced === true), `${rel}: the MARKED_* note must stay local`);

  // 3. Vitals-update screen: a ticked tourniquet starts a real one, once.
  const modal = await page.evaluate(() => {
    const p = { id: 'dddddddd-0000-4000-8000-000000000002', visualId: 'P-MODAL-TQ', triage: 'red', patientStatus: 'observing', events: [], txHistory: [], vitals: { ...VITALS_NOT_ON_DEVICE }, siteId: 'SITE_A' };
    patients.push(p);
    modalTreatments = new Set(['tourniquet']);
    const before = getOutbox().length;
    queueModalTreatmentEvents(p, 'חסם עורקים', 'medic-test');
    const first = getOutbox().slice(before).filter((e) => e.type === 'TOURNIQUET_APPLIED').map((e) => ({ pid: e.patient_id, synced: e.synced, limb: e.payload_json.limb, source: e.payload_json.source }));
    const active1 = activeTourniquets(p).map((t) => ({ limb: t.limb, serverLimb: t.serverLimb }));
    const timer = tourniquetTimerLabel(p);
    const mid = getOutbox().length;
    queueModalTreatmentEvents(p, 'חסם עורקים', 'medic-test');
    const second = getOutbox().slice(mid).filter((e) => e.type === 'TOURNIQUET_APPLIED').length;
    return { first, active1, timer: !!timer, second, active2: activeTourniquets(p).length, debt: p.assessmentDebt || [] };
  });
  assert(modal.first.length === 1 && modal.first[0].pid && modal.first[0].synced === false && modal.first[0].limb === 'unknown' && modal.first[0].source === 'vitals_modal',
    `${rel}: a tourniquet from the vitals screen must be sent patient-scoped (got ${JSON.stringify(modal.first)})`);
  assert(modal.active1.length === 1 && modal.active1[0].serverLimb === 'unknown' && modal.timer, `${rel}: it must start a tourniquet with a timer on this device`);
  assert(modal.debt.includes('tourniquet_limb_missing'), `${rel}: the missing limb must be flagged for later`);
  assert(modal.second === 0 && modal.active2 === 1, `${rel}: ticking it again while one is active must not restart the timer`);

  // 4. Another device's tourniquet carries the server's effectiveness.
  const remote = await page.evaluate(() => {
    const inc = SITE_TO_INCIDENT_ID.SITE_A;
    const id = 'dddddddd-0000-4000-8000-000000000003';
    patients.push({ id, visualId: 'P-REMOTE-TQ', triage: 'red', sourcedFromRemote: true, siteId: 'SITE_A', tourniquets: [], tourniquet: null, events: [], vitals: { ...VITALS_NOT_ON_DEVICE } });
    applyServerTourniquets([{ id: 'r1', patient_id: id, limb: 'right_arm', applied_at: new Date(Date.now() - 10 * 60000).toISOString(), is_active: true, tourniquet_status: 'bleeding_continues' }], inc);
    const t = activeTourniquets(patients.find((x) => x.id === id))[0] || ensureTourniquetArray(patients.find((x) => x.id === id))[0];
    return { effectiveness: t?.effectiveness, label: t ? tourniquetStatusLabel(t) : null };
  });
  assert(remote.effectiveness === 'bleeding_continues' && /דימום ממשיך/.test(remote.label || ''), `${rel}: a remote tourniquet must show the server's effectiveness (got ${JSON.stringify(remote)})`);

  assert(pageErrors.length === 0, `${rel}: uncaught page error(s): ${pageErrors.join(' | ')}`);
  await page.close();
  console.log(`${rel}: tourniquet follow-ups browser test passed`);
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
