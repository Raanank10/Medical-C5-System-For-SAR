// Real-browser test for D1 (repo owner, 2026-10-20): the phone raises tourniquet time alerts
// itself, from its own clock, with no network at all. The browser context is offline from the
// start, the 30-second alert refresh is driven by Playwright's fake clock, and vibration calls are
// recorded:
// 1. A tourniquet past 60 minutes alerts once (vibration + banner that stays), not on every tick.
// 2. Crossing 120 minutes alerts again, as critical.
// 3. A remote tourniquet refreshed from the server keeps its alert level (no repeat).
// 4. A handed-over patient's tourniquet does not alert.
//
// Manual-only, not wired into CI (same as scripts/browser_smoke_test.js).
// Run: npm install && node scripts/browser_tourniquet_offline_alert_test.js
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
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(() => {
    window.__vibrations = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p) => { window.__vibrations.push(p); return true; } });
  });
  await page.clock.install({ time: new Date('2026-10-20T10:00:00Z') });
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.fill('#pin-gate-setup-new', PIN);
  await page.fill('#pin-gate-setup-confirm', PIN);
  await page.click('#pin-gate-setup-btn');
  await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });
  assert(await page.evaluate(() => navigator.onLine === false), `${rel}: the test must run with the network off`);

  // A patient whose tourniquet went on 59 minutes ago: nothing yet beyond the 45-minute notice.
  await page.evaluate(() => {
    const now = Date.now();
    patients.push({ id: 'eeeeeeee-0000-4000-8000-000000000001', visualId: 'P-TQ-OFF', triage: 'red', patientStatus: 'stabilizing', siteId: 'SITE_A', events: [], vitals: { ...VITALS_NOT_ON_DEVICE },
      tourniquets: [{ id: 'TQ-001', appliedAt: now - 59 * 60000, limb: 'left_leg', limbLabel: 'רגל שמאל', status: 'active', effectiveness: 'unknown', timeAlertedLevel: 'notice' }] });
    patients.push({ id: 'eeeeeeee-0000-4000-8000-000000000002', visualId: 'P-HANDED', triage: 'red', patientStatus: 'handed_over', siteId: 'SITE_A', events: [], vitals: { ...VITALS_NOT_ON_DEVICE },
      tourniquets: [{ id: 'TQ-001', appliedAt: now - 130 * 60000, limb: 'right_arm', status: 'active', effectiveness: 'unknown' }] });
  });
  await page.clock.runFor(31000); // one 30-second alert refresh: still under 60 minutes
  assert((await page.evaluate(() => window.__vibrations.length)) === 0, `${rel}: nothing should alert before 60 minutes`);

  // 1. Past 60 minutes: the 30-second refresh raises it, once, with no network.
  await page.clock.runFor(60000);
  const warn = await page.evaluate(() => ({ v: window.__vibrations.slice(), banner: document.getElementById('tq-time-alert')?.textContent || '', level: document.getElementById('tq-time-alert')?.dataset.level }));
  assert(warn.v.length === 1 && warn.level === 'warn' && warn.banner.includes('עברה שעה') && warn.banner.includes('P-TQ-OFF'), `${rel}: the 60-minute alert must vibrate and show a banner offline (got ${JSON.stringify(warn)})`);
  await page.clock.runFor(5 * 60000);
  assert((await page.evaluate(() => window.__vibrations.length)) === 1, `${rel}: the same level must not alert again on later ticks`);
  assert(await page.evaluate(() => !!document.getElementById('tq-time-alert')), `${rel}: the banner must stay until tapped`);

  // 2. Past 120 minutes: critical.
  await page.clock.runFor(56 * 60000);
  const crit = await page.evaluate(() => ({ n: window.__vibrations.length, level: document.getElementById('tq-time-alert')?.dataset.level, banner: document.getElementById('tq-time-alert')?.textContent || '' }));
  assert(crit.n === 2 && crit.level === 'critical' && crit.banner.includes('120'), `${rel}: crossing 120 minutes must raise a critical alert (got ${JSON.stringify(crit)})`);
  await page.click('#tq-time-alert');
  assert(await page.evaluate(() => !document.getElementById('tq-time-alert') && document.getElementById('detail-pid')?.textContent === 'eeeeeeee-0000-4000-8000-000000000001'), `${rel}: tapping the banner opens the patient`);

  // 3. A remote tourniquet refreshed from the server keeps its alert level.
  const remote = await page.evaluate(() => {
    const inc = SITE_TO_INCIDENT_ID.SITE_A;
    const id = 'eeeeeeee-0000-4000-8000-000000000003';
    patients.push({ id, visualId: 'P-REMOTE-OFF', triage: 'red', sourcedFromRemote: true, siteId: 'SITE_A', patientStatus: 'stabilizing', tourniquets: [], tourniquet: null, events: [], vitals: { ...VITALS_NOT_ON_DEVICE } });
    const row = { id: 'r1', patient_id: id, limb: 'right_leg', applied_at: new Date(Date.now() - 65 * 60000).toISOString(), is_active: true, tourniquet_status: 'applied' };
    applyServerTourniquets([row], inc);
    const before = window.__vibrations.length;
    const first = checkTourniquetTimeAlerts();
    applyServerTourniquets([{ ...row, tourniquet_status: 'effective' }], inc); // a refresh that replaces the row
    const second = checkTourniquetTimeAlerts();
    return { first, second, added: window.__vibrations.length - before };
  });
  assert(remote.first === 'warn' && remote.second === null && remote.added === 1, `${rel}: a remote tourniquet alerts once and a server refresh must not repeat it (got ${JSON.stringify(remote)})`);

  // 4. The handed-over patient never alerted.
  const handed = await page.evaluate(() => patients.find((p) => p.visualId === 'P-HANDED').tourniquets[0].timeAlertedLevel || null);
  assert(handed === null, `${rel}: a handed-over patient's tourniquet must not alert`);

  assert(pageErrors.length === 0, `${rel}: uncaught page error(s): ${pageErrors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: offline tourniquet alert browser test passed`);
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
