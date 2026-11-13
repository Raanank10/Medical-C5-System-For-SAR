// Real-browser test for entering a tourniquet's time from the body (repo owner, 2026-11-08).
// Network off, Playwright's fake clock, vibration calls recorded.
// 1. Sweep: "היה על הפצוע" records the tourniquet with no time (time_source 'unknown'), takes no
//    tourniquet from the medic's bag and opens the time entry; "הונח עכשיו" keeps the phone's time.
// 2. A time later than the phone's clock by more than 5 minutes is refused with the agreed message.
// 3. With no time: conversion is blocked for everyone and the "שעת חסם לא ידועה" debt is shown.
// 4. Entering a time 70 minutes ago from the patient screen: no banner, no vibration; the levels
//    already passed are seen; TOURNIQUET_TIME_RECORDED is queued; the next level (100) alerts.
// 5. Correcting the time keeps the history; a time more than 12 hours ago needs a confirmation.
// 6. Another phone's tourniquet with an entered time does not alert here for levels passed at entry,
//    and one the server marks 'unknown' cannot be converted here.
// 7. New Patient form: a typed time is 'entered' (passed levels seen), "עכשיו" is 'phone', an empty
//    field is 'unknown', and a time later than the phone's clock is refused.
// 8. New Patient forms' bag stock: only "עכשיו" takes a tourniquet from the medic's bag.
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_tourniquet_time_entry_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
const PIN = '135790';
const P1 = 'eeeeeeee-0000-4000-8000-0000000000d1';
const P2 = 'eeeeeeee-0000-4000-8000-0000000000d2';
const P3 = 'eeeeeeee-0000-4000-8000-0000000000d3';

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
  let dialogAnswer = true;
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('dialog', async (d) => { dialogs.push(d.message()); if (dialogAnswer) await d.accept(); else await d.dismiss(); });
  await page.addInitScript(() => {
    window.__vibrations = [];
    Object.defineProperty(navigator, 'vibrate', { configurable: true, value: (p) => { window.__vibrations.push(p); return true; } });
  });
  try {
    await page.clock.install({ time: new Date('2026-11-08T12:20:00') });
    await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
    await page.fill('#pin-gate-setup-new', PIN);
    await page.fill('#pin-gate-setup-confirm', PIN);
    await page.click('#pin-gate-setup-btn');
    await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });

    await page.evaluate(({ P1, P2 }) => {
      currentUser = { id: 'user-medic', role: 'medic', email: 'medic@example.test' };
      window.codeAgo = (min) => { const d = new Date(Date.now() - min * 60000); return String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0'); };
      window.__supply = [];
      const realReconcile = reconcileSupplySource;
      reconcileSupplySource = function (...args) { window.__supply.push(args.slice(0, 3)); return realReconcile.apply(this, args); };
      for (const [id, visualId] of [[P1, 'P-TE1'], [P2, 'P-TE2']]) {
        patients.push({ id, visualId, triage: 'red', patientStatus: 'stabilizing', siteId: 'SITE_A', events: [], vitals: { ...VITALS_NOT_ON_DEVICE }, mstart: {}, tourniquets: [] });
      }
    }, { P1, P2 });

    // 1. Sweep, "already on the patient".
    let r = await page.evaluate((id) => {
      activeSweepPatientId = id;
      askSweepTourniquetOrigin('left_leg');
      const modal = document.getElementById('tq-origin')?.textContent || '';
      document.querySelector('#tq-origin [data-tq-origin="pre"]').click();
      const p = patients.find((x) => x.id === id);
      const tq = activeTourniquets(p)[0];
      const applied = getOutbox().filter((e) => e.type === 'TOURNIQUET_APPLIED' && e.patient_id === id).map((e) => e.payload_json);
      return { modal, entryOpen: !!document.getElementById('tq-time-entry'), timeSource: tq?.timeSource, unknown: tourniquetTimeUnknown(tq), timeCode: tq?.timeCode,
        supply: window.__supply.filter((s) => s[1] === 'tourniquets').length, applied };
    }, P1);
    assert(r.modal.includes('הונח עכשיו') && r.modal.includes('היה על הפצוע'), `the sweep must ask who placed it (got ${r.modal})`);
    assert(r.entryOpen && r.timeSource === 'unknown' && r.unknown && !r.timeCode, `"already on the patient" must record no time and open the entry (got ${JSON.stringify(r)})`);
    assert(r.supply === 0, `a tourniquet already on the patient must not come from the medic's bag (got ${r.supply})`);
    assert(r.applied.length === 1 && r.applied[0].time_source === 'unknown', `TOURNIQUET_APPLIED must say time_source unknown (got ${JSON.stringify(r.applied)})`);

    // 2. 25 minutes later than the phone's clock: refused.
    await page.fill('#tq-time-entry-input', await page.evaluate(() => codeAgo(-25)));
    await page.click('#tq-time-entry [data-tq-time-action="save"]');
    r = await page.evaluate((id) => ({ error: document.getElementById('tq-time-entry-error')?.textContent || '', unknown: tourniquetTimeUnknown(activeTourniquets(patients.find((x) => x.id === id))[0]) }), P1);
    assert(r.error.includes('מאוחרת ב-25 דק׳') && r.error.includes('בדוק את השעה שנכתבה על הגוף') && r.unknown, `a later time must be refused (got ${JSON.stringify(r)})`);

    // 3. Left with no time.
    await page.click('#tq-time-entry [data-tq-time-action="skip"]');
    r = await page.evaluate((id) => {
      const p = patients.find((x) => x.id === id);
      return { open: !!document.getElementById('tq-time-entry'), check: tourniquetConversionCheck(activeTourniquets(p)[0]), debt: assessmentDebtForPatient(p).includes('tourniquet_time_unknown') };
    }, P1);
    assert(!r.open && !r.check.allowed && r.check.reason === 'time_unknown' && r.debt, `no time: conversion blocked and debt shown (got ${JSON.stringify(r)})`);

    // 4. Enter 70 minutes ago from the patient screen.
    await page.evaluate((id) => openPatient(id), P1);
    let btn = await page.textContent('[data-tq-time-entry]');
    assert(btn.includes('הזן שעת הנחה'), `the patient screen must offer the time entry (got ${btn})`);
    await page.click('[data-tq-time-entry]');
    const v0 = await page.evaluate(() => window.__vibrations.length);
    await page.fill('#tq-time-entry-input', await page.evaluate(() => codeAgo(70)));
    await page.click('#tq-time-entry [data-tq-time-action="save"]');
    r = await page.evaluate((id) => {
      const p = patients.find((x) => x.id === id);
      const tq = activeTourniquets(p)[0];
      const sent = getOutbox().filter((e) => e.type === 'TOURNIQUET_TIME_RECORDED' && e.patient_id === id).map((e) => e.payload_json);
      checkTourniquetTimeAlerts();
      return { minutes: Math.round((Date.now() - tq.appliedAt) / 60000), timeSource: tq.timeSource, seen: tq.timeAlertedLevel, sent, banner: !!document.getElementById('tq-time-alert'),
        vib: window.__vibrations.length, debt: assessmentDebtForPatient(p).includes('tourniquet_time_unknown'), card: document.querySelector('#screen-patient.active .sweep-tq-card, .screen.active .sweep-tq-card')?.textContent || '' };
    }, P1);
    assert(r.minutes === 70 && r.timeSource === 'entered' && r.seen === 'warn', `entered time must be 70 min with 60 seen (got ${JSON.stringify(r)})`);
    assert(!r.banner && r.vib === v0, `entering a time must not raise a banner or vibrate (got ${JSON.stringify(r)})`);
    assert(r.sent.length === 1 && r.sent[0].limb === 'left_leg' && r.sent[0].previous_time_source === 'unknown' && r.sent[0].previous_application_time && r.sent[0].application_time && r.sent[0].time_code,
      `TOURNIQUET_TIME_RECORDED must be queued (got ${JSON.stringify(r.sent)})`);
    assert(!r.debt && r.card.includes('שעה מהגוף') && r.card.includes('+70'), `debt cleared and the card shows the time (got ${JSON.stringify(r)})`);
    await page.clock.runFor(31 * 60000); // now 101 minutes on
    r = await page.evaluate(() => ({ level: document.getElementById('tq-time-alert')?.dataset.level || null }));
    assert(r.level === 'decision', `the next level (100) must alert as usual (got ${JSON.stringify(r)})`);
    await page.evaluate(() => document.querySelector('#tq-time-alert [data-tq-action="open"]')?.click());

    // 5. Correct to 20 minutes ago; then more than 12 hours ago needs a confirmation.
    await page.evaluate((id) => openPatient(id), P1);
    btn = await page.textContent('[data-tq-time-entry]');
    assert(btn.includes('תקן שעת הנחה'), `an entered time can be corrected (got ${btn})`);
    await page.evaluate((id) => openTourniquetTimeEntry(id, 'TQ-001'), P1);
    await page.evaluate(() => saveTourniquetEnteredTime(codeAgo(20)));
    r = await page.evaluate((id) => {
      const tq = activeTourniquets(patients.find((x) => x.id === id))[0];
      const sent = getOutbox().filter((e) => e.type === 'TOURNIQUET_TIME_RECORDED' && e.patient_id === id).map((e) => e.payload_json);
      return { minutes: Math.round((Date.now() - tq.appliedAt) / 60000), history: tq.timeHistory.length, prev: sent[sent.length - 1].previous_time_source, seen: tq.timeAlertedLevel };
    }, P1);
    assert(r.minutes === 20 && r.history === 2 && r.prev === 'entered' && r.seen === null, `a correction must be kept in the history (got ${JSON.stringify(r)})`);
    dialogAnswer = false;
    await page.evaluate((id) => openTourniquetTimeEntry(id, 'TQ-001'), P1);
    await page.evaluate(() => saveTourniquetEnteredTime(codeAgo(13 * 60)));
    r = await page.evaluate((id) => Math.round((Date.now() - activeTourniquets(patients.find((x) => x.id === id))[0].appliedAt) / 60000), P1);
    assert(dialogs.some((d) => d.includes('החסם הונח לפני 13 שעות')) && r === 20, `a time 13 h ago must ask first, and a "no" changes nothing (got ${r}, ${JSON.stringify(dialogs)})`);
    dialogAnswer = true;
    await page.evaluate(() => saveTourniquetEnteredTime(codeAgo(13 * 60)));
    r = await page.evaluate((id) => Math.round((Date.now() - activeTourniquets(patients.find((x) => x.id === id))[0].appliedAt) / 60000), P1);
    assert(r === 780, `a confirmed old time is saved (got ${r})`);
    await page.evaluate(() => closeTourniquetTimeEntry());

    // 1b. Sweep, "placed now": the phone's time, from the medic's bag, no time entry.
    r = await page.evaluate((id) => {
      activeSweepPatientId = id;
      const before = window.__supply.filter((s) => s[1] === 'tourniquets').length;
      askSweepTourniquetOrigin('right_arm');
      document.querySelector('#tq-origin [data-tq-origin="now"]').click();
      const tq = activeTourniquets(patients.find((x) => x.id === id))[0];
      return { timeSource: tq.timeSource, unknown: tourniquetTimeUnknown(tq), minutes: Math.round((Date.now() - tq.appliedAt) / 60000),
        supply: window.__supply.filter((s) => s[1] === 'tourniquets').length - before, entryOpen: !!document.getElementById('tq-time-entry') };
    }, P2);
    assert(r.timeSource === 'phone' && !r.unknown && r.minutes === 0 && r.supply === 1 && !r.entryOpen, `"placed now" keeps the phone's time (got ${JSON.stringify(r)})`);

    // 6. Another phone's tourniquets.
    r = await page.evaluate((id) => {
      const inc = SITE_TO_INCIDENT_ID.SITE_A;
      document.getElementById('tq-time-alert')?.remove();
      patients.push({ id, visualId: 'P-TE3', triage: 'red', sourcedFromRemote: true, siteId: 'SITE_A', patientStatus: 'stabilizing', tourniquets: [], tourniquet: null, events: [], vitals: { ...VITALS_NOT_ON_DEVICE } });
      const iso = (min) => new Date(Date.now() - min * 60000).toISOString();
      const rows = [{ id: 'r1', patient_id: id, limb: 'right_leg', applied_at: iso(70), is_active: true, tourniquet_status: 'applied' },
        { id: 'r2', patient_id: id, limb: 'left_arm', applied_at: iso(10), is_active: true, tourniquet_status: 'applied' }];
      const meta = [{ id: 'r1', time_source: 'entered', time_entered_at: iso(1) }, { id: 'r2', time_source: 'unknown', time_entered_at: null }];
      applyServerTourniquets(rows, inc, meta);
      const p = patients.find((x) => x.id === id);
      const before = window.__vibrations.length;
      checkTourniquetTimeAlerts();
      const [a, b] = activeTourniquets(p);
      return { vib: window.__vibrations.length - before, aSeen: a.timeAlertedLevel, aSource: a.timeSource, bCheck: tourniquetConversionCheck(b), debt: assessmentDebtForPatient(p).includes('tourniquet_time_unknown') };
    }, P3);
    assert(r.vib === 0 && r.aSeen === 'warn' && r.aSource === 'entered', `another phone's entered time must not alert for passed levels here (got ${JSON.stringify(r)})`);
    assert(!r.bCheck.allowed && r.bCheck.reason === 'time_unknown' && r.debt, `a server 'unknown' tourniquet cannot be converted here (got ${JSON.stringify(r)})`);

    // 7. New Patient form time field.
    r = await page.evaluate(() => {
      const display = document.createElement('div');
      const out = {};
      quickTqData = { applied: true, time: null, timeTyped: false, limbs: new Set(['rl']) };
      out.empty = tourniquetEntriesFromState()[0].timeSource;
      quickTqData.time = codeAgo(0); quickTqData.timeTyped = false;
      out.now = tourniquetEntriesFromState()[0].timeSource;
      quickTqData.time = codeAgo(70); quickTqData.timeTyped = true;
      const typed = tourniquetEntriesFromState()[0];
      out.typed = typed.timeSource; out.typedSeen = typed.timeAlertedLevel; out.typedMin = Math.round((Date.now() - typed.appliedAt) / 60000);
      quickTqData.time = codeAgo(-25);
      out.futureOk = checkFlowTourniquetTime(codeAgo(-25), quickTqData, display, false);
      out.futureMsg = display.textContent; out.futureCleared = quickTqData.time === null;
      quickTqData = { applied: false, time: null, timeTyped: false, limbs: new Set() };
      return out;
    });
    assert(r.empty === 'unknown' && r.now === 'phone' && r.typed === 'entered' && r.typedSeen === 'warn' && r.typedMin === 70, `form time sources (got ${JSON.stringify(r)})`);
    assert(r.futureOk === false && r.futureMsg.includes('מאוחרת ב-25 דק׳') && r.futureCleared, `a later time in the form is refused (got ${JSON.stringify(r)})`);

    // 8. Bag stock in the New Patient forms (owner, 2026-11-13): only "עכשיו" (placed now) takes a
    //    tourniquet from the medic's bag; a typed time or an emptied field gives it back.
    r = await page.evaluate(() => {
      const qty = (key) => state.supplyMovements?.[key]?.qty || 0;
      const out = {};
      quickTqData = { applied: false, time: null, timeTyped: false, limbs: new Set() };
      toggleQuickTQ(document.getElementById('quick-tq-yes-btn'), true);
      out.quickTicked = qty('quick:tq');
      onQuickTQTimeInput(codeAgo(70));
      out.quickTyped = qty('quick:tq');
      setQuickTQTimeNow();
      out.quickNow = qty('quick:tq');
      onQuickTQTimeInput('');
      out.quickEmptied = qty('quick:tq');
      toggleQuickTQ(document.getElementById('quick-tq-no-btn'), false);
      toggleQuickTQ(document.getElementById('quick-tq-yes-btn'), true);
      out.quickRetickTyped = qty('quick:tq');
      quickTqData = { applied: false, time: null, timeTyped: false, limbs: new Set() };
      reconcileSupplySource('quick:tq', 'tourniquets', 0);
      const chip = document.querySelector('[data-tx="tourniquet"]');
      toggleChip(chip, 'tourniquet');
      out.fullTicked = qty('tx:tourniquet');
      onTQTimeInput(codeAgo(70));
      out.fullTyped = qty('tx:tourniquet');
      queueInventoryBeforeSave(null);
      out.fullSaveTyped = qty('tx:tourniquet');
      setTQTimeNow();
      out.fullNow = qty('tx:tourniquet');
      toggleChip(chip, 'tourniquet');
      out.fullOff = qty('tx:tourniquet');
      return out;
    });
    assert(r.quickTicked === 1 && r.quickTyped === 0 && r.quickNow === 1 && r.quickEmptied === 0 && r.quickRetickTyped === 0,
      `quick form: only "now" takes from the bag (got ${JSON.stringify(r)})`);
    assert(r.fullTicked === 1 && r.fullTyped === 0 && r.fullSaveTyped === 0 && r.fullNow === 1 && r.fullOff === 0,
      `full form: only "now" takes from the bag (got ${JSON.stringify(r)})`);

    assert(pageErrors.length === 0, `uncaught page error(s): ${pageErrors.join(' | ')}`);
  } finally {
    await browser.close();
  }
  console.log('index.html: tourniquet time entry browser test passed');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
