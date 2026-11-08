// Real-browser test for "remind me later" on tourniquet time alerts (repo owner, 2026-10-26).
// Network off, Playwright's fake clock, vibration calls recorded.
// Medic phone:
// 1. The 60-minute banner offers "open patient" and "remind me in 5 minutes". Putting it off keeps
//    the medic on the screen they were on (registering a new patient), shrinks it to a chip and
//    sends WATCHDOG_ALERT reason 'tourniquet_snoozed'.
// 2. When the delay runs out the banner comes back and vibrates again.
// 3. The second (last) delay at that level is marked escalated; after it no delay is offered.
// 4. Crossing 100 minutes cancels the delays: a new banner, a 2-minute delay offered again.
// 5. Opening the patient from the chip after a delay sends 'tourniquet_alert_opened'.
// PC phone:
// 6. Another phone's delay is listed in the alert strip ("put off by ... until"), without vibrating.
// 7. An escalated delay vibrates once and shows a banner; "seen" closes it and it does not repeat.
// 8. The medic opening the patient clears the line; a delay from an earlier level is not listed.
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_tourniquet_snooze_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
const PIN = '135790';
const PATIENT_ID = 'eeeeeeee-0000-4000-8000-0000000000a1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function openApp(browser) {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  await page.addInitScript(() => {
    window.__vibrations = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p) => { window.__vibrations.push(p); return true; } });
  });
  await page.clock.install({ time: new Date('2026-10-26T10:00:00Z') });
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.fill('#pin-gate-setup-new', PIN);
  await page.fill('#pin-gate-setup-confirm', PIN);
  await page.click('#pin-gate-setup-btn');
  await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });
  return { context, page, pageErrors };
}

const bannerState = () => {
  const el = document.getElementById('tq-time-alert');
  return {
    shown: !!el,
    level: el?.dataset.level || null,
    text: el?.textContent || '',
    snooze: el?.querySelector('[data-tq-action="snooze"]')?.textContent || null,
    chip: document.getElementById('tq-snooze-chip')?.textContent || null,
    vibrations: window.__vibrations.length,
    screen: document.querySelector('.screen.active')?.id || null,
  };
};
const snoozeEvents = () => getOutbox().filter((e) => e.type === 'WATCHDOG_ALERT' && e.payload_json?.reason).map((e) => ({ reason: e.payload_json.reason, level: e.payload_json.level, used: e.payload_json.used, escalated: e.payload_json.escalated, minutes: e.payload_json.snooze_minutes }));

async function medicPhone(browser) {
  const { context, page, pageErrors } = await openApp(browser);
  await page.evaluate((id) => {
    const now = Date.now();
    patients.push({ id, visualId: 'P-TQ-SNZ', triage: 'red', patientStatus: 'stabilizing', siteId: 'SITE_A', events: [], vitals: { ...VITALS_NOT_ON_DEVICE },
      tourniquets: [{ id: 'TQ-001', appliedAt: now - 59.5 * 60000, limb: 'left_leg', limbLabel: 'רגל שמאל', status: 'active', effectiveness: 'unknown', timeAlertedLevel: 'notice' }] });
    goTo('step1'); // the medic is in the middle of registering a new patient
  }, PATIENT_ID);
  const intake = await page.evaluate(() => document.querySelector('.screen.active')?.id);
  await page.clock.runFor(61000);

  // 1. The 60-minute banner, put off for 5 minutes without leaving the intake screen.
  let s = await page.evaluate(bannerState);
  assert(s.shown && s.level === 'warn' && s.vibrations === 1 && /5 דק׳/.test(s.snooze || '') && !/יעדכן/.test(s.snooze), `60-minute banner must offer a 5-minute delay (got ${JSON.stringify(s)})`);
  await page.click('#tq-time-alert [data-tq-action="snooze"]');
  s = await page.evaluate(bannerState);
  assert(!s.shown && s.chip && s.chip.includes('P-TQ-SNZ') && s.screen === intake, `putting it off must hide the banner, show the chip and stay on ${intake} (got ${JSON.stringify(s)})`);
  let ev = await page.evaluate(snoozeEvents);
  assert(ev.length === 1 && ev[0].reason === 'tourniquet_snoozed' && ev[0].level === 'warn' && ev[0].used === 1 && ev[0].escalated === false && ev[0].minutes === 5, `the delay must be queued as WATCHDOG_ALERT tourniquet_snoozed (got ${JSON.stringify(ev)})`);

  // 2. Back after 5 minutes, vibrating again; not before.
  await page.clock.runFor(4 * 60000);
  s = await page.evaluate(bannerState);
  assert(!s.shown && s.vibrations === 1, `the banner must stay away during the delay (got ${JSON.stringify(s)})`);
  await page.clock.runFor(61000);
  s = await page.evaluate(bannerState);
  assert(s.shown && s.level === 'warn' && s.vibrations === 2 && !s.chip, `the banner must come back and vibrate when the delay is up (got ${JSON.stringify(s)})`);

  // 3. The last delay at this level says it will tell the PC, and is sent escalated.
  assert(/יעדכן חוג״ד/.test(s.snooze || ''), `the last delay must say the PC will be told (got ${JSON.stringify(s)})`);
  await page.click('#tq-time-alert [data-tq-action="snooze"]');
  ev = await page.evaluate(snoozeEvents);
  assert(ev.length === 2 && ev[1].used === 2 && ev[1].escalated === true, `the last delay must be sent escalated (got ${JSON.stringify(ev)})`);
  await page.clock.runFor(5 * 60000 + 1000);
  s = await page.evaluate(bannerState);
  assert(s.shown && s.snooze === null && s.text.includes('אין דחיות נוספות') && s.vibrations === 3, `after the last delay no further delay is offered (got ${JSON.stringify(s)})`);

  // 4. Crossing 100 minutes: a new level, delays offered again (2 minutes, the only one).
  await page.clock.runFor(30 * 60000);
  s = await page.evaluate(bannerState);
  assert(s.shown && s.level === 'decision' && s.text.includes('20 דקות ל-120') && /2 דק׳/.test(s.snooze || '') && /יעדכן חוג״ד/.test(s.snooze), `100 minutes must raise the decision banner with one 2-minute delay (got ${JSON.stringify(s)})`);
  await page.click('#tq-time-alert [data-tq-action="snooze"]');

  // 5. Opening the patient from the chip ends it and tells command.
  await page.click('#tq-snooze-chip');
  s = await page.evaluate(bannerState);
  ev = await page.evaluate(snoozeEvents);
  const opened = await page.evaluate(() => document.getElementById('detail-pid')?.textContent);
  assert(!s.shown && !s.chip && opened === 'P-TQ-SNZ', `the chip must open the patient and clear the alert (got ${JSON.stringify({ s, opened })})`);
  assert(ev.length === 4 && ev[2].level === 'decision' && ev[2].escalated === true && ev[3].reason === 'tourniquet_alert_opened', `opening after a delay must send tourniquet_alert_opened (got ${JSON.stringify(ev)})`);
  await page.clock.runFor(3 * 60000);
  assert(!(await page.evaluate(bannerState)).shown, 'an opened alert must not come back at the same level');

  assert(pageErrors.length === 0, `medic phone: uncaught page error(s): ${pageErrors.join(' | ')}`);
  await context.close();
}

async function pcPhone(browser) {
  const { context, page, pageErrors } = await openApp(browser);
  const result = await page.evaluate((id) => {
    const inc = SITE_TO_INCIDENT_ID.SITE_A;
    const now = Date.now();
    currentUser = { id: 'pc-user', role: 'pc', email: 'pc@example.test' };
    patients.push({ id, visualId: 'P-TQ-SNZ', triage: 'red', patientStatus: 'stabilizing', siteId: 'SITE_A', sourcedFromRemote: true, events: [], vitals: { ...VITALS_NOT_ON_DEVICE },
      tourniquets: [{ id: 'srv-1', appliedAt: now - 66 * 60000, limb: 'left_leg', status: 'active', effectiveness: 'unknown', timeAlertedLevel: 'warn' }] });
    const row = (minutesAgo, payload) => ({ patient_id: id, device_id: 'medic-device-1', actor_role: 'medic', local_timestamp: new Date(now - minutesAgo * 60000).toISOString(),
      payload_json: { patient_id: id, limb: 'left_leg', by_name: 'דני', ...payload } });
    const snoozeAlerts = () => buildAlertObjects(patients).filter((a) => a.type.startsWith('TOURNIQUET_ALERT_SNOOZE'));
    const out = {};
    const first = row(2, { reason: 'tourniquet_snoozed', level: 'warn', used: 1, max: 2, escalated: false, snooze_minutes: 5, snoozed_until: new Date(now + 3 * 60000).toISOString() });
    // 6. listed, no vibration; this phone's own delays and unrelated WATCHDOG_ALERTs ignored
    applyTourniquetSnoozes([first, { ...row(1, { reason: 'reescalated' }) }, { ...row(0, { reason: 'tourniquet_snoozed', level: 'warn', escalated: true }), device_id: getDeviceId() }], inc);
    out.listed = snoozeAlerts().map((a) => ({ type: a.type, title: a.title, severity: a.severity, audience: a.audience }));
    out.v1 = window.__vibrations.length;
    out.banner1 = !!document.getElementById('tq-snooze-escalation');
    // 7. escalated: vibrate once, banner, "seen" closes it, no repeat
    const second = row(1, { reason: 'tourniquet_snoozed', level: 'warn', used: 2, max: 2, escalated: true, snooze_minutes: 5, snoozed_until: new Date(now + 4 * 60000).toISOString() });
    applyTourniquetSnoozes([first, second], inc);
    out.escalated = snoozeAlerts().map((a) => ({ type: a.type, severity: a.severity, detail: a.detail }));
    out.v2 = window.__vibrations.length;
    out.banner2 = document.getElementById('tq-snooze-escalation')?.textContent || '';
    document.querySelector('#tq-snooze-escalation [data-tq-action="seen"]').click();
    out.banner2Closed = !document.getElementById('tq-snooze-escalation');
    tourniquetSnoozesByIncident[inc] = [];
    applyTourniquetSnoozes([first, second], inc);
    out.v3 = window.__vibrations.length;
    out.banner3 = !!document.getElementById('tq-snooze-escalation');
    // 8. opened clears it; a delay from an earlier level is not listed
    applyTourniquetSnoozes([first, second, row(0, { reason: 'tourniquet_alert_opened', level: 'warn' })], inc);
    out.afterOpen = snoozeAlerts().length;
    patients[patients.length - 1].tourniquets[0].appliedAt = now - 101 * 60000;
    applyTourniquetSnoozes([first, second], inc);
    out.staleLevel = snoozeAlerts().length;
    return out;
  }, PATIENT_ID);

  assert(result.listed.length === 1 && result.listed[0].type === 'TOURNIQUET_ALERT_SNOOZED' && result.listed[0].title.includes('נדחה ע״י דני') && result.listed[0].title.includes('66 דק׳') && result.listed[0].audience.includes('pc'),
    `another phone's delay must be listed for the PC (got ${JSON.stringify(result.listed)})`);
  assert(result.v1 === 0 && !result.banner1, `a first delay must not vibrate the PC (got ${JSON.stringify(result)})`);
  assert(result.escalated.length === 1 && result.escalated[0].type === 'TOURNIQUET_ALERT_SNOOZE_LIMIT' && result.escalated[0].severity === 'critical' && result.escalated[0].detail.includes('נוצלו כל הדחיות'),
    `an escalated delay must be a critical line (got ${JSON.stringify(result.escalated)})`);
  assert(result.v2 === 1 && result.banner2.includes('P-TQ-SNZ') && result.banner2.includes('ניצל/ה את כל הדחיות') && result.banner2Closed, `an escalated delay must vibrate the PC once with a banner (got ${JSON.stringify(result)})`);
  assert(result.v3 === 1 && !result.banner3, `a seen escalation must not alert again (got ${JSON.stringify(result)})`);
  assert(result.afterOpen === 0, `the medic opening the patient must clear the line (got ${result.afterOpen})`);
  assert(result.staleLevel === 0, `a delay from an earlier level must not be listed (got ${result.staleLevel})`);
  assert(pageErrors.length === 0, `PC phone: uncaught page error(s): ${pageErrors.join(' | ')}`);
  await context.close();
}

async function main() {
  assert(fs.existsSync(file), 'missing index.html');
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  try {
    await medicPhone(browser);
    await pcPhone(browser);
  } finally {
    await browser.close();
  }
  console.log('index.html: tourniquet alert "remind me later" browser test passed');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
