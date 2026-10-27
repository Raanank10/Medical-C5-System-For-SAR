// Real-browser test for converting a tourniquet to direct pressure (repo owner, 2026-10-26 / 27).
// Network off, one phone, the role switched between checks:
// 1. A medic at 60 minutes: "המרה ללחץ ישיר" on the patient screen, a confirmation, then the
//    tourniquet is no longer active, its alerts stop, and TOURNIQUET_RELEASED is queued with reason
//    'converted_direct_pressure'.
// 2. A medic past 120 minutes: the button is disabled and says who may; a tap does nothing.
// 3. A paramedic: allowed at 200 minutes, blocked past 4 hours.
// 4. A physician past 6 hours: allowed, with the 6-hour warning on the button and in the dialog.
// 5. An admin sees the button disabled; a CC sees none (no clinical writes).
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_tourniquet_conversion_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
const PIN = '135790';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  assert(fs.existsSync(file), 'missing index.html');
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  const context = await browser.newContext({ offline: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const pageErrors = [];
  const dialogs = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.accept(); });
  try {
    await page.clock.install({ time: new Date('2026-10-27T10:00:00Z') });
    await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
    await page.fill('#pin-gate-setup-new', PIN);
    await page.fill('#pin-gate-setup-confirm', PIN);
    await page.click('#pin-gate-setup-btn');
    await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });

    // One patient per case, each with one tourniquet applied the given number of minutes ago.
    const setup = (role, minutes, n) => page.evaluate(({ role, minutes, n }) => {
      currentUser = role ? { id: `user-${role}`, role, email: `${role}@example.test` } : null;
      const id = `eeeeeeee-0000-4000-8000-${String(n).padStart(12, '0')}`;
      patients.push({ id, visualId: `P-CV${n}`, triage: 'red', patientStatus: 'stabilizing', siteId: 'SITE_A', events: [], vitals: { ...VITALS_NOT_ON_DEVICE },
        tourniquets: [{ id: 'TQ-001', appliedAt: Date.now() - minutes * 60000, limb: 'left_leg', limbLabel: 'רגל שמאל', serverLimb: 'left_leg', status: 'active', effectiveness: 'unknown', timeAlertedLevel: 'critical' }] });
      openPatient(id);
      const btn = document.querySelector('[data-tq-convert="TQ-001"]');
      return { id, shown: !!btn, disabled: !!btn?.disabled, text: btn?.textContent || '' };
    }, { role, minutes, n });
    const tap = (id) => page.evaluate((id) => {
      const before = getOutbox().length;
      convertTourniquetToDirectPressure(id, 'TQ-001');
      const p = patients.find((x) => x.id === id);
      const sent = getOutbox().slice(before).filter((e) => e.type === 'TOURNIQUET_RELEASED');
      return { active: activeTourniquets(p).length, status: p.tourniquets[0].status, sent: sent.map((e) => e.payload_json) };
    }, id);

    // 1. Medic, 60 minutes: allowed.
    let s = await setup('medic', 60, 1);
    assert(s.shown && !s.disabled && s.text.includes('המרה ללחץ ישיר'), `medic at 60 min must get an enabled button (got ${JSON.stringify(s)})`);
    await page.click('[data-tq-convert="TQ-001"]');
    let r = await page.evaluate((id) => { const p = patients.find((x) => x.id === id); return { active: activeTourniquets(p).length, status: p.tourniquets[0].status, sent: getOutbox().filter((e) => e.type === 'TOURNIQUET_RELEASED' && e.patient_id === id).map((e) => e.payload_json), label: tourniquetStatusLabel(p.tourniquets[0]) }; }, s.id);
    assert(dialogs.length === 1 && dialogs[0].includes('ללחץ ישיר'), `conversion must ask first (got ${JSON.stringify(dialogs)})`);
    assert(r.active === 0 && r.status === 'converted' && r.label === 'הומר ללחץ ישיר', `the tourniquet must be converted (got ${JSON.stringify(r)})`);
    assert(r.sent.length === 1 && r.sent[0].reason === 'converted_direct_pressure' && r.sent[0].limb === 'left_leg' && r.sent[0].minutes_on_limb === 60, `TOURNIQUET_RELEASED must be queued (got ${JSON.stringify(r.sent)})`);
    const stillAlerting = await page.evaluate(() => { checkTourniquetTimeAlerts(Date.now() + 3 * 3600000); return document.getElementById('tq-time-alert')?.dataset.patientId || null; });
    assert(stillAlerting !== s.id, 'a converted tourniquet must not alert again');
    await page.evaluate(() => document.getElementById('tq-time-alert')?.remove());

    // 2. Medic past 120 minutes: blocked.
    s = await setup('medic', 125, 2);
    assert(s.shown && s.disabled && s.text.includes('פראמדיק / רופא בלבד'), `medic past 120 min must be blocked (got ${JSON.stringify(s)})`);
    r = await tap(s.id);
    assert(r.active === 1 && r.status === 'active' && r.sent.length === 0 && dialogs.length === 1, `a blocked conversion must change nothing (got ${JSON.stringify(r)})`);

    // 3. Paramedic: allowed at 200 minutes, blocked past 4 hours.
    s = await setup('paramedic', 200, 3);
    assert(s.shown && !s.disabled, `paramedic at 200 min must be allowed (got ${JSON.stringify(s)})`);
    r = await tap(s.id);
    assert(r.active === 0 && r.sent.length === 1, `paramedic at 200 min converts (got ${JSON.stringify(r)})`);
    s = await setup('paramedic', 245, 4);
    assert(s.disabled && s.text.includes('עברו 4 שעות') && s.text.includes('רופא בלבד'), `paramedic past 4 h must be blocked (got ${JSON.stringify(s)})`);
    r = await tap(s.id);
    assert(r.active === 1 && r.sent.length === 0, `paramedic past 4 h changes nothing (got ${JSON.stringify(r)})`);

    // 4. Physician past 6 hours: allowed, warned.
    s = await setup('physician', 400, 5);
    assert(s.shown && !s.disabled && s.text.includes('עברו 6 שעות'), `physician past 6 h must be allowed with a warning (got ${JSON.stringify(s)})`);
    r = await tap(s.id);
    assert(r.active === 0 && r.sent.length === 1 && r.sent[0].past_physician_window === true && dialogs[dialogs.length - 1].includes('6 שעות'), `physician past 6 h converts with the warning (got ${JSON.stringify({ r, dialog: dialogs[dialogs.length - 1] })})`);

    // 5. Admin: disabled; CC: no button.
    s = await setup('admin', 30, 6);
    assert(s.shown && s.disabled && s.text.includes('חובש / פראמדיק / רופא בלבד'), `admin must see it disabled (got ${JSON.stringify(s)})`);
    s = await setup('cc', 30, 7);
    assert(!s.shown, `CC must not get the button (got ${JSON.stringify(s)})`);

    assert(pageErrors.length === 0, `uncaught page error(s): ${pageErrors.join(' | ')}`);
  } finally {
    await browser.close();
  }
  console.log('index.html: tourniquet conversion to direct pressure browser test passed');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
