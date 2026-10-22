// Real-browser test for V2.99.35 (docs/GAP_CLOSURE_PLAN.md WP-0b): a patient the server rejects
// must be loud on the phone, not a quiet count.
//
// Found live 2026-10-19: admin patient creates were blocked by patients_insert RLS (fixed in
// database/047), every later event for those patients failed the patient FK, and the phone kept
// showing the patients as if all was well. This checks the client side:
// 1. syncPush keeps the server's error code/message on each rejected outbox entry.
// 2. The patient tile shows "לא הגיע לשרת", the patient card shows a red banner, and the sync pill
//    turns red.
// 3. "שלח שוב לשרת" re-queues only that patient's rejected events, and a successful re-push clears
//    the banner.
//
// The Supabase client and the sync-log endpoint are stubbed in the page; this proves client
// behavior only, not the server side (verified separately against the live project).
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_sync_rejection_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';
const INCIDENT = '66666666-0000-4000-8000-000000000001';
const PATIENT = 'bbbbbbbb-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';

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

  // Stub a logged-in session and a sync-log endpoint that rejects the first patient's create and
  // its tourniquet (as the live server did), and accepts everything else.
  await page.evaluate(({ INCIDENT, PATIENT, OTHER }) => {
    window.__pushes = [];
    window.__rejectPatient = true;
    currentUser = { id: 'user-admin-test', role: 'admin' };
    getSupabaseClient = () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }) } });
    syncPullAll = async () => {};
    reconcileTriageSync = () => {};
    reconcileLocationSync = () => {};
    window.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      window.__pushes.push(body.events.map((e) => e.type + ':' + (e.patient_id || '-')));
      const accepted = [];
      const rejected = [];
      body.events.forEach((e) => {
        if (window.__rejectPatient && e.patient_id === PATIENT) {
          rejected.push(e.type.endsWith('PATIENT_CREATED')
            ? { local_event_id: e.local_event_id, terminal: false, error_code: 'PATIENT_CREATE_FAILED', message: 'new row violates row-level security policy for table "patients"' }
            : { local_event_id: e.local_event_id, terminal: true, error_code: 'MALFORMED_EVENT_ENVELOPE', message: 'violates foreign key constraint "events_patient_id_fkey"' });
        } else {
          accepted.push({ local_event_id: e.local_event_id });
        }
      });
      return { ok: true, json: async () => ({ accepted, duplicates: [], rejected, high_risk_flags: [], field_conflicts: [] }) };
    };
    patients = [
      { id: PATIENT, visualId: 'P-REJ', triage: 'red', patientStatus: 'stabilizing', location: 'בניין A', injury: 'ריסוק', events: [], vitals: { ...VITALS_NOT_ON_DEVICE }, vitalsHistory: [], time: '10:00' },
      { id: OTHER, visualId: 'P-OK', triage: 'yellow', patientStatus: 'observing', location: 'בניין A', injury: 'שבר', events: [], vitals: { ...VITALS_NOT_ON_DEVICE }, vitalsHistory: [], time: '10:01' },
    ];
    const stamp = (ev) => { saveLocalEvent(ev); const e = getOutbox()[getOutbox().length - 1]; e.incident_id = INCIDENT; e.synced = false; };
    stamp({ type: 'QUICK_PATIENT_CREATED', detail: 'P-REJ', patient_id: PATIENT, payload_json: { visual_id: 'P-REJ', triage: 'red' } });
    stamp({ type: 'TOURNIQUET_APPLIED', detail: 'P-REJ TQ', payload_json: { patient_id: PATIENT, tourniquet_id: 'TQ-001', limb: 'right_arm' } });
    stamp({ type: 'QUICK_PATIENT_CREATED', detail: 'P-OK', patient_id: OTHER, payload_json: { visual_id: 'P-OK', triage: 'yellow' } });
  }, { INCIDENT, PATIENT, OTHER });

  // 1. Push: rejection reasons are kept on the outbox entries.
  const afterPush = await page.evaluate(async ({ PATIENT, OTHER }) => {
    await syncPush();
    const mine = getOutbox().filter((e) => e.patient_id === PATIENT);
    const other = getOutbox().filter((e) => e.patient_id === OTHER);
    return {
      mine: mine.map((e) => ({ type: e.type, rejected: !!e.syncRejected, code: e.syncRejectReason, msg: e.syncRejectMessage })),
      otherRejected: other.some((e) => e.syncRejected),
      otherSynced: other.every((e) => e.synced),
      rejection: patientSyncRejection(patients.find((p) => p.id === PATIENT)),
      otherRejection: patientSyncRejection(patients.find((p) => p.id === OTHER)),
    };
  }, { PATIENT, OTHER });
  assert(afterPush.mine.length === 2 && afterPush.mine.every((e) => e.rejected), `${rel}: both events of the rejected patient must be marked rejected, got ${JSON.stringify(afterPush.mine)}`);
  assert(afterPush.mine.find((e) => e.type === 'QUICK_PATIENT_CREATED').code === 'PATIENT_CREATE_FAILED', `${rel}: the server error code must be kept on the rejected create`);
  assert((afterPush.mine.find((e) => e.type === 'QUICK_PATIENT_CREATED').msg || '').includes('row-level security'), `${rel}: the server message must be kept on the rejected create`);
  assert(!afterPush.otherRejected && afterPush.otherSynced, `${rel}: another patient's accepted events must not be affected`);
  assert(afterPush.rejection && afterPush.rejection.createRejected && afterPush.rejection.count === 2, `${rel}: patientSyncRejection must report the rejected create, got ${JSON.stringify(afterPush.rejection)}`);
  assert(afterPush.otherRejection === null, `${rel}: an accepted patient must have no rejection`);

  // 2. Loud on screen: tile badge, card banner, red sync pill.
  const screen = await page.evaluate(({ PATIENT }) => {
    goTo('dashboard');
    renderDashboard();
    updateDemoStatus();
    const list = document.getElementById('patient-list').innerHTML;
    const pill = document.getElementById('sync-pill-dashboard');
    openPatient(PATIENT);
    const card = document.getElementById('detail-body').innerHTML;
    return { list, pillClass: pill ? pill.className : '', pillText: pill ? pill.textContent : '', card };
  }, { PATIENT });
  const badgeCount = (screen.list.match(/לא הגיע לשרת/g) || []).length;
  assert(badgeCount === 1, `${rel}: exactly one patient tile (the rejected one) must show "לא הגיע לשרת", got ${badgeCount}`);
  assert(screen.pillClass.includes('offline') && screen.pillText.includes('2 נדחו'), `${rel}: the sync pill must be red and count 2 rejected, got "${screen.pillClass}" / "${screen.pillText}"`);
  assert(screen.card.includes('פצוע זה לא נקלט בשרת') && screen.card.includes('PATIENT_CREATE_FAILED') && screen.card.includes('שלח שוב לשרת'), `${rel}: the patient card must show the red banner with the error code and a resend button`);

  // 3. Retry after the server is fixed: re-queues only this patient's events, create first.
  const afterRetry = await page.evaluate(async ({ PATIENT }) => {
    window.__rejectPatient = false;
    window.__pushes = [];
    await retryPatientSync(PATIENT);
    const card = document.getElementById('detail-body').innerHTML;
    return {
      pushes: window.__pushes,
      rejection: patientSyncRejection(patients.find((p) => p.id === PATIENT)),
      rejectedTotal: rejectedOutboxCount(),
      card,
    };
  }, { PATIENT });
  assert(afterRetry.pushes.length === 1, `${rel}: retry must push once, got ${afterRetry.pushes.length}`);
  assert(JSON.stringify(afterRetry.pushes[0]) === JSON.stringify([`QUICK_PATIENT_CREATED:${PATIENT}`, `TOURNIQUET_APPLIED:${PATIENT}`]), `${rel}: retry must resend only this patient's events, create first, got ${JSON.stringify(afterRetry.pushes[0])}`);
  assert(afterRetry.rejection === null && afterRetry.rejectedTotal === 0, `${rel}: after a successful resend nothing may stay rejected`);
  assert(!afterRetry.card.includes('פצוע זה לא נקלט בשרת'), `${rel}: the banner must disappear after a successful resend`);

  assert(pageErrors.length === 0, `${rel}: uncaught page error(s): ${pageErrors.join(' | ')}`);
  await page.close();
  console.log(`${rel}: sync rejection visibility browser test passed`);
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
