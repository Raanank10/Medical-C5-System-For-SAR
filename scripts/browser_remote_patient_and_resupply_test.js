// Real-browser test for V2.99.32, two field-test fixes:
// 1. A patient received from another device has no measured vitals on this device (the pull
//    carries last_vitals_at only). It must show "—", never VITALS_BASELINE's starting values
//    (pulse 80 / RR 16) as if they were measured, and remote patients cached before this fix
//    are cleared on the next pull.
// 2. A medic's resupply request (RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE /
//    RESUPPLY_REQUEST_ESCALATED_CC) must reach the sync outbox as unsynced, so syncPush sends it
//    and database/033 projects it into supply_requests. PC-side status updates stay local.
//
// Runs in local demo mode and calls the page's own functions; no Supabase client is involved,
// so this proves client behavior only, not the server side.
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_remote_patient_and_resupply_test.js
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

  // 1a. A patient first seen through the pull gets no invented vitals.
  const fresh = await page.evaluate(() => {
    patients = [];
    applyProjectedPatientState([{
      id: 'aaaaaaaa-0000-4000-8000-000000000001', incident_id: SITE_TO_INCIDENT_ID.SITE_A, visual_id: 'P-REMOTE-1',
      current_triage: 'red', current_status: 'stabilizing', access_status: 'accessible', needs_full_assessment: true,
      is_pediatric: false, pediatric_age_years: null, last_vitals_at: null, version: 3,
      optional_name: null, identifying_description: null, physician_death_confirmed_at: null, physician_death_confirmed_by: null,
    }]);
    const p = patients.find((x) => x.visualId === 'P-REMOTE-1');
    commandRole = 'cc';
    cmdActiveSite = 'ALL';
    goTo('commander');
    renderCmdPatients();
    const html = document.getElementById('cmd-patient-table')?.innerHTML || '';
    return { vitals: p && p.vitals, sourced: p && p.sourcedFromRemote, html };
  });
  assert(fresh.sourced === true, `${rel}: the pulled patient must be marked as received from another device`);
  assert(fresh.vitals && fresh.vitals.pulse === null && fresh.vitals.rr === null, `${rel}: a remote patient must have no pulse/RR on this device, got ${JSON.stringify(fresh.vitals)}`);
  assert(fresh.html.includes('P-REMOTE-1'), `${rel}: the CC patient list must show the remote patient`);
  assert(!fresh.html.includes('80♥') && !fresh.html.includes('null♥'), `${rel}: the CC patient list must not show a placeholder or null pulse`);
  assert(fresh.html.includes('—♥') && fresh.html.includes('מדדים אצל החובש'), `${rel}: the CC patient list must say the vitals are on the medic's device`);

  // 1b. A remote patient cached before V2.99.32 (baseline vitals) is cleared on the next pull,
  // even when the server version has not changed; one with real local vitals is left alone.
  const migrated = await page.evaluate(() => {
    const base = { incident_id: SITE_TO_INCIDENT_ID.SITE_A, current_triage: 'yellow', current_status: 'observing', access_status: 'accessible',
      needs_full_assessment: false, is_pediatric: false, pediatric_age_years: null, last_vitals_at: null, version: 5,
      optional_name: null, identifying_description: null, physician_death_confirmed_at: null, physician_death_confirmed_by: null };
    patients = [
      { id: 'aaaaaaaa-0000-4000-8000-000000000002', visualId: 'P-OLD', triage: 'yellow', vitals: { ...VITALS_BASELINE }, vitalsHistory: [], sourcedFromRemote: true, _serverVersion: 5, events: [] },
      { id: 'aaaaaaaa-0000-4000-8000-000000000003', visualId: 'P-MEASURED', triage: 'yellow', vitals: { ...VITALS_BASELINE }, vitalsHistory: [{ t: Date.now(), pulse: 80, rr: 16 }], sourcedFromRemote: true, _serverVersion: 5, events: [] },
    ];
    applyProjectedPatientState([
      { ...base, id: 'aaaaaaaa-0000-4000-8000-000000000002', visual_id: 'P-OLD' },
      { ...base, id: 'aaaaaaaa-0000-4000-8000-000000000003', visual_id: 'P-MEASURED' },
    ]);
    return patients.map((p) => ({ v: p.visualId, pulse: p.vitals.pulse }));
  });
  assert(migrated.find((x) => x.v === 'P-OLD').pulse === null, `${rel}: a cached remote patient with placeholder vitals must be cleared`);
  assert(migrated.find((x) => x.v === 'P-MEASURED').pulse === 80, `${rel}: vitals actually recorded on this device must be kept`);

  // 2. Resupply request events are queued for push; PC-side status updates are not.
  const outbox = await page.evaluate(() => {
    const before = getOutbox().length;
    saveLocalEvent({ type: 'RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE', detail: 'test', payload_json: { id: 'REQ-T1', items: [] } });
    saveLocalEvent({ type: 'RESUPPLY_REQUEST_ESCALATED_CC', detail: 'test', payload_json: { id: 'REQ-T2', items: [] } });
    saveLocalEvent({ type: 'RESUPPLY_APPROVED_FROM_PC_TRUCK', detail: 'test', payload_json: { request_id: 'REQ-T1' } });
    return getOutbox().slice(before).map((e) => ({ type: e.type, synced: e.synced }));
  });
  const byType = Object.fromEntries(outbox.map((e) => [e.type, e.synced]));
  assert(byType.RESUPPLY_REQUESTED_PC_TRUCK_AVAILABLE === false, `${rel}: a resupply request must be queued unsynced for push`);
  assert(byType.RESUPPLY_REQUEST_ESCALATED_CC === false, `${rel}: an escalated resupply request must be queued unsynced for push`);
  assert(byType.RESUPPLY_APPROVED_FROM_PC_TRUCK === true, `${rel}: PC-side status updates must stay local (033 matches them by the creating device)`);

  assert(pageErrors.length === 0, `${rel}: uncaught page error(s): ${pageErrors.join(' | ')}`);
  await page.close();
  console.log(`${rel}: remote patient vitals + resupply push browser test passed`);
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
