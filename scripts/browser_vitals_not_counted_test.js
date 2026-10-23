// Real-browser test of the owner's 2026-10-23 decisions on invented vitals, chips and the patient
// screen's bottom bar:
// 1. Nothing nobody measured is recorded or shown as measured: MSTART "breathing yes" leaves the
//    breathing rate empty (was 16); the quick flow invents no rate from breathing/AVPU and no pulse
//    from a pulse location; a vitals counter is "לא נספר" until the medic changes it, picks a
//    bracket or taps the number, and an untouched counter records nothing (was 80 / 16).
// 2. A vitals sheet saved with nothing counted or chosen is refused (it would restart the
//    reassessment clock and tell the server vitals were taken); a full patient flow with nothing
//    measured sends no VITALS_RECORDED.
// 3. "אין מדדים מלאים" clears only with a counted breathing rate, AVPU and a pulse rate or
//    perfusion; an uncounted breathing rate never triggers a "deterioration" recommendation.
// 4. The patient screen and MIST say "נושם — לא נספר" and tag values taken from MSTART or inferred
//    from walking; the vitals sheet does not pre-select an AVPU inferred from walking.
// 5. A critical chip is a white chip with "!", an overdue one has "⏱".
// 6. Patient screen: two actions (עדכן מדדים, יצא לנקודת פינוי) and "עוד"; nothing at the end of
//    the page stays under the bar, also with "עוד" open.
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_vitals_not_counted_test.js
const path = require('path');
const { chromium } = require('playwright');

const file = path.join(path.resolve(__dirname, '..'), 'index.html');
const PIN = '135790';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freshPage(browser) {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);
  await page.fill('#pin-gate-setup-new', PIN);
  await page.fill('#pin-gate-setup-confirm', PIN);
  await page.click('#pin-gate-setup-btn');
  await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });
  await page.evaluate(() => { activeRoleDashboard = 'medic'; applyFieldMode(true); });
  return { context, page, errors };
}

// A non-walking sweep casualty: breathing yes, AVPU A, strong radial pulse - all answered by the medic.
const MARK_SWEEP = `(() => {
  goTo('sweep');
  startSweepCasualtyMarker();
  const x = patients[0];
  x.mstart.walking = 'no'; x.mstart.breathing = 'yes'; x.mstart.avpu = 'A'; x.mstart.perfusion = 'radial_strong';
  syncPatientFromSweep(x);
  activeSweepPatientId = null;
  return x.id;
})()`;

async function sweepAndDisplays(browser) {
  const { context, page, errors } = await freshPage(browser);
  const r = await page.evaluate((mark) => {
    const id = eval(mark);
    const p = patients.find((x) => x.id === id);
    openPatient(id);
    const detail = document.getElementById('detail-body').innerText;
    const mist = mistTextForPatient(p);
    return { rr: p.vitals.rr, obs: p.vitalsObserved, detailNotCounted: detail.includes('נושם — לא נספר'), mist };
  }, MARK_SWEEP);
  assert(r.rr === null, `MSTART breathing yes must leave the rate empty (got ${r.rr})`);
  assert(r.obs.avpu?.src === 'mstart' && r.obs.bp_estimate?.src === 'mstart' && !r.obs.rr, `observed from MSTART: AVPU and perfusion, not a rate (got ${JSON.stringify(r.obs)})`);
  assert(r.detailNotCounted, 'the patient screen must say "נושם — לא נספר"');
  assert(r.mist.includes('נשימות נושם — לא נספר') && !/נשימות 16/.test(r.mist), `MIST must not report a breathing rate nobody counted (got ${r.mist})`);
  assert(r.mist.includes('הכרה A (MSTART)'), `MIST must tag MSTART findings (got ${r.mist})`);

  // Walking casualty: AVPU/perfusion inferred from walking are not observations.
  const w = await page.evaluate(() => {
    goTo('sweep');
    startSweepCasualtyMarker();
    const x = patients[0];
    applyWalkingAutofill(x);
    syncPatientFromSweep(x);
    activeSweepPatientId = null;
    const mist = mistTextForPatient(x);
    openQuickVitals(x.id);
    const preselected = !!document.querySelector('#modal-avpu-grid .avpu-btn.selected');
    document.getElementById('vitals-modal').classList.add('hidden');
    return { observedAvpu: vitalObserved(x, 'avpu'), mist, preselected, triage: x.triage };
  });
  assert(!w.observedAvpu, 'AVPU inferred from walking is not an observation');
  assert(w.mist.includes('(נגזר מהליכה)'), `MIST must tag values inferred from walking (got ${w.mist})`);
  assert(!w.preselected, 'the vitals sheet must not pre-select an AVPU inferred from walking');
  assert(!errors.length, `page errors: ${errors.join(' | ')}`);
  await context.close();
}

async function vitalsSheet(browser) {
  const { context, page, errors } = await freshPage(browser);
  const id = await page.evaluate((mark) => eval(mark), MARK_SWEEP);
  const outboxVitals = () => page.evaluate(() => getOutbox().filter((e) => e.type === 'VITALS_RECORDED'));

  // Untouched counters show "not counted" and record nothing; saving nothing is refused.
  const untouched = await page.evaluate(async (id) => {
    const p = patients.find((x) => x.id === id);
    const clock = p.lastVitalsAt;
    openQuickVitals(id);
    const ui = { rate: document.getElementById('mv-rr-rate').textContent, grey: document.getElementById('mv-rr30').classList.contains('not-counted'),
      pulse: modalVitals.pulse, rr: modalVitals.rr,
      warning: (document.getElementById('vital-warn-mrr30')?.innerText || '') + (document.getElementById('vital-warn-mpulse15')?.innerText || '') };
    await saveModalVitals();
    return { ui, clockKept: p.lastVitalsAt === clock, open: !document.getElementById('vitals-modal').classList.contains('hidden') };
  }, id);
  assert(untouched.ui.rate === '—' && untouched.ui.grey, `an untouched breathing counter must show "—" greyed (got ${JSON.stringify(untouched.ui)})`);
  assert(untouched.ui.pulse === null && untouched.ui.rr === null, `untouched counters record nothing (got ${JSON.stringify(untouched.ui)})`);
  assert(!untouched.ui.warning, `an uncounted value must not raise a range warning (got "${untouched.ui.warning}")`);
  assert(untouched.clockKept && untouched.open, `an empty save must be refused: clock kept, sheet open (got ${JSON.stringify(untouched)})`);
  assert((await outboxVitals()).length === 0, 'an empty save must not send VITALS_RECORDED');

  // Pulse counted only: saved, breathing rate stays empty, chip stays, no false recommendation.
  const pulseOnly = await page.evaluate(async (id) => {
    const p = patients.find((x) => x.id === id);
    changeCount('mpulse15', 1);
    await saveModalVitals();
    return { pulse: p.vitals.pulse, rr: p.vitals.rr, chip: assessmentDebtList(p).includes('missing_vitals'), rec: p.priorityRecommendation || null, triage: p.triage };
  }, id);
  assert(pulseOnly.pulse === 84 && pulseOnly.rr === null, `only the counted pulse is recorded (got ${JSON.stringify(pulseOnly)})`);
  assert(pulseOnly.chip, '"אין מדדים מלאים" must stay without a counted breathing rate');
  assert(!pulseOnly.rec, `an uncounted breathing rate must not produce a priority recommendation (got ${JSON.stringify(pulseOnly.rec)})`);
  const sent = (await outboxVitals()).pop();
  assert(sent && sent.payload_json.pulse === 84 && sent.payload_json.rr == null, `the server gets the pulse and no breathing rate (got ${JSON.stringify(sent && sent.payload_json)})`);

  // Breathing rate confirmed by tapping the number: four of five (no SpO₂ yet), chip stays.
  await page.evaluate((id) => openQuickVitals(id), id);
  await page.click('#mv-rr30');
  const four = await page.evaluate(async (id) => {
    const p = patients.find((x) => x.id === id);
    await saveModalVitals();
    return { rr: p.vitals.rr, chip: assessmentDebtList(p).includes('missing_vitals'), pulseKept: p.vitals.pulse };
  }, id);
  assert(four.rr === 16, `a confirmed count is recorded (got ${JSON.stringify(four)})`);
  assert(four.chip, `all five vital signs are needed: without SpO₂ the chip stays (got ${JSON.stringify(four)})`);
  assert(four.pulseKept === 84, `a vital not re-measured keeps its last observed value (got ${four.pulseKept})`);

  // SpO₂ switched on but not touched records nothing; "אין מד" counts and completes the set.
  await page.evaluate((id) => openQuickVitals(id), id);
  const spo2 = await page.evaluate(async (id) => {
    toggleModalSpo2();
    const untouched = { value: modalVitals.spo2, grey: document.getElementById('mv-spo2').classList.contains('not-counted') };
    toggleModalSpo2();
    return { untouched };
  }, id);
  assert(spo2.untouched.value === null && spo2.untouched.grey, `SpO₂ switched on but untouched records nothing (got ${JSON.stringify(spo2.untouched)})`);
  await page.click('#mspo2-na-btn');
  const full = await page.evaluate(async (id) => {
    const p = patients.find((x) => x.id === id);
    await saveModalVitals();
    const ev = getOutbox().filter((e) => e.type === 'VITALS_RECORDED').pop();
    return { chip: assessmentDebtList(p).includes('missing_vitals'), unavailableSent: ev?.payload_json?.spo2_unavailable === true, spo2: ev?.payload_json?.spo2 };
  }, id);
  assert(!full.chip, `"אין מד סטורציה" + the other four completes the set (got ${JSON.stringify(full)})`);
  assert(full.unavailableSent && full.spo2 == null, `the server is told there was no oximeter, with no SpO₂ value (got ${JSON.stringify(full)})`);

  // A confirmed SpO₂ value is recorded as measured.
  await page.evaluate((id) => { openQuickVitals(id); toggleModalSpo2(); }, id);
  await page.click('#mv-spo2');
  const confirmed = await page.evaluate(async (id) => {
    await saveModalVitals();
    return getOutbox().filter((e) => e.type === 'VITALS_RECORDED').pop()?.payload_json?.spo2;
  }, id);
  assert(confirmed === 98, `a tapped (confirmed) SpO₂ is recorded (got ${confirmed})`);
  assert(!errors.length, `page errors: ${errors.join(' | ')}`);
  await context.close();
}

async function patientFlows(browser) {
  const { context, page, errors } = await freshPage(browser);
  const quick = await page.evaluate(() => {
    startNewPatient('quick');
    selectRapidBreathing(null, true);
    const afterBreathing = flowVitals.rr;
    selectRapidAvpu(null, 'U');
    const afterAvpu = flowVitals.rr;
    selectRapidBp(null, 'radial_strong');
    return { afterBreathing, afterAvpu, pulse: flowVitals.pulse, bp: flowVitals.bp_estimate };
  });
  assert(quick.afterBreathing === null && quick.afterAvpu === null, `quick flow must not invent a breathing rate (got ${JSON.stringify(quick)})`);
  assert(quick.pulse === null && quick.bp === 'radial_strong', `quick flow must not invent a pulse rate from a pulse location (got ${JSON.stringify(quick)})`);

  const full = await page.evaluate(() => {
    startNewPatient('extended');
    selectFlowMode(document.querySelector('#flow-mode-grid .tap-btn') || document.createElement('button'), 'extended');
    state.triage = 'yellow'; state.trapStatus = 'not_trapped'; state.injury = 'שבר';
    projectPatientStatus('observing', 'VITALS_RECORDED');
    const before = getOutbox().length;
    const fv = { ...flowVitals };
    savePatient();
    const p = patients[patients.length - 1];
    const added = getOutbox().slice(before).filter((e) => e.type === 'VITALS_RECORDED' && e.patient_id === p.id);
    return { fv, sentVitals: added.length, chip: assessmentDebtList(p).includes('missing_vitals'), pulse: p.vitals.pulse, rr: p.vitals.rr };
  });
  assert(full.fv.pulse === null && full.fv.rr === null, `untouched flow counters record nothing (got ${JSON.stringify(full.fv)})`);
  assert(full.sentVitals === 0, `a patient flow with nothing measured must not send VITALS_RECORDED (got ${full.sentVitals})`);
  assert(full.chip && full.pulse === null && full.rr === null, `nothing measured: no values, chip stays (got ${JSON.stringify(full)})`);

  // Range buttons record the range, never a stand-in number; triage uses the band; not a count.
  const ranges = await page.evaluate(() => {
    startNewPatient('extended');
    selectFlowMode(document.querySelector('#flow-mode-grid .tap-btn') || document.createElement('button'), 'extended');
    goTo('step4');
    setVitalRR(document.querySelector('#rr-bracket-grid .tap-btn:nth-child(3)'), 16);
    setVitalPulseBracket(document.querySelector('#pulse-bracket-grid .tap-btn:nth-child(2)'), 80);
    const fv = { ...flowVitals };
    const rateShown = document.getElementById('v-rr-rate').textContent;
    selectAVPU(document.querySelector('#avpu-grid .avpu-btn'), 'A');
    selectBP(document.querySelector('#bp-grid .bp-btn'), 'radial_strong');
    const triageRr = triageVitalsFromFlow().rr;
    state.triage = 'yellow'; state.trapStatus = 'not_trapped'; state.injury = 'שבר';
    projectPatientStatus('observing', 'VITALS_RECORDED');
    const before = getOutbox().length;
    savePatient();
    const p = patients[patients.length - 1];
    const ev = getOutbox().slice(before).find((e) => e.type === 'VITALS_RECORDED' && e.patient_id === p.id);
    // Exact count afterwards replaces the range.
    startNewPatient('extended');
    setVitalRR(document.querySelector('#rr-bracket-grid .tap-btn:nth-child(3)'), 16);
    changeCount('rr30', 1);
    const afterCount = { rr: flowVitals.rr, range: flowVitals.rr_range || null };
    return { fv, rateShown, triageRr, chip: assessmentDebtList(p).includes('missing_vitals'), mist: mistTextForPatient(p),
      sentRr: ev?.payload_json?.rr, sentRange: ev?.payload_json?.rr_range, afterCount };
  });
  assert(ranges.fv.rr === null && ranges.fv.rr_range === '10-30', `"10-30" must record the range, not 16 (got ${JSON.stringify(ranges.fv)})`);
  assert(ranges.fv.pulse === null && ranges.fv.pulse_range === '60-100', `"60-100" must record the range, not 80 (got ${JSON.stringify(ranges.fv)})`);
  assert(ranges.rateShown === '10-30', `the screen shows the range (got ${ranges.rateShown})`);
  assert(ranges.triageRr === 16, `triage still uses the range's band (got ${ranges.triageRr})`);
  assert(ranges.sentRr == null && ranges.sentRange === '10-30', `the server gets the range, no number (got rr ${ranges.sentRr}, range ${ranges.sentRange})`);
  assert(ranges.chip, 'a range is not an exact count: "אין מדדים מלאים" stays');
  assert(ranges.mist.includes('10-30 (טווח, לא נספר)'), `MIST says it was a range (got ${ranges.mist})`);
  assert(ranges.afterCount.rr === 18 && ranges.afterCount.range === null, `an exact count replaces the range (got ${JSON.stringify(ranges.afterCount)})`);
  assert(!errors.length, `page errors: ${errors.join(' | ')}`);
  await context.close();
}

async function chipsAndPatientBar(browser) {
  const { context, page, errors } = await freshPage(browser);
  const chips = await page.evaluate(() => {
    const host = document.createElement('div');
    host.innerHTML = '<span class="debt-chip critical">x</span><span class="debt-chip overdue">y</span>';
    document.body.appendChild(host);
    const [c, o] = host.querySelectorAll('.debt-chip');
    const r = { critBg: getComputedStyle(c).backgroundColor, critBefore: getComputedStyle(c, '::before').content, overBefore: getComputedStyle(o, '::before').content };
    host.remove();
    return r;
  });
  assert(chips.critBg === 'rgb(255, 255, 255)' && chips.critBefore.includes('!'), `critical chip: white with "!" (got ${JSON.stringify(chips)})`);
  assert(chips.overBefore.includes('⏱'), `overdue chip: "⏱" (got ${JSON.stringify(chips)})`);

  const id = await page.evaluate((mark) => { const id = eval(mark); openPatient(id); return id; }, MARK_SWEEP);
  const bar = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('#detail-bottom-bar button')].filter((b) => b.checkVisibility()).map((b) => b.innerText.trim());
    return { visible, height: Math.round(document.getElementById('detail-bottom-bar').getBoundingClientRect().height) };
  });
  assert(bar.visible.length === 3 && /עדכן מדדים/.test(bar.visible[0]) && /יצא לנקודת פינוי/.test(bar.visible[1]) && /עוד/.test(bar.visible[2]),
    `bar: עדכן מדדים, יצא לנקודת פינוי, עוד (got ${JSON.stringify(bar.visible)})`);
  assert(bar.height <= 130, `the bar must be about half its old 251px (got ${bar.height}px)`);

  const endClear = async () => page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => requestAnimationFrame(r));
    const barTop = document.getElementById('detail-bottom-bar').getBoundingClientRect().top;
    const content = [...document.querySelectorAll('#screen-patient > :not(.bottom-bar) *')].filter((e) => e.checkVisibility() && e.getBoundingClientRect().height > 0);
    const lowest = Math.max(...content.map((e) => e.getBoundingClientRect().bottom));
    return { barTop: Math.round(barTop), lowest: Math.round(lowest) };
  });
  const closed = await endClear();
  assert(closed.lowest <= closed.barTop + 1, `end of the patient page must clear the bar (content ends ${closed.lowest}, bar starts ${closed.barTop})`);
  await page.click('#detail-bar-more-btn');
  const moreVisible = await page.locator('#detail-bottom-bar button:has-text("הועבר למד״א — עכשיו")').isVisible();
  assert(moreVisible, '"עוד" must reveal the handover button');
  const opened = await endClear();
  assert(opened.lowest <= opened.barTop + 1, `with "עוד" open the page must still clear the bar (content ends ${opened.lowest}, bar starts ${opened.barTop})`);
  assert(!errors.length, `page errors: ${errors.join(' | ')}`);
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await sweepAndDisplays(browser);
    await vitalsSheet(browser);
    await patientFlows(browser);
    await chipsAndPatientBar(browser);
  } finally {
    await browser.close();
  }
  console.log('browser_vitals_not_counted_test: passed - no invented vitals (sweep, quick flow, counters), empty saves refused, stricter full set, honest MIST, white "!" chips, short patient bar that never covers content');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
