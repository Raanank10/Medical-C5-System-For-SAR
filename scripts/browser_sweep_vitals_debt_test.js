// Real-browser test of the owner's 2026-10-23 review (follow-up to the phone-layout fix):
// 1. "No vitals" is one key, missing_vitals: MSTART answers alone do not clear it (they set a
//    placeholder breathing rate), a real vitals save does, and a patient saved before this change
//    with the old full_vitals key no longer shows a stuck chip.
// 2. Unknown tourniquet time is red on a red casualty, orange otherwise; missing_treatment is gone;
//    the new labels are shown.
// 3. The sweep screen has exactly one "add casualty" control (the FAB), always up there, also for
//    a pc running the sweep, and hidden on every other screen.
// 4. A wrong tourniquet limb can be corrected from the patient screen: TOURNIQUET_LIMB_RECORDED
//    with previous_limb (so the server moves its row), and cancelling an entry asks first. A role
//    that may not write clinical events (cc) gets no correction controls.
// 5. The platoon roster panel is offered on the cc, chamal and admin dashboards, not the pc's; the
//    admin dashboard offers user management.
// No backend: currentUser is set in the page, as in scripts/browser_mobile_layout_test.js.
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_sweep_vitals_debt_test.js
const path = require('path');
const { chromium } = require('playwright');

const file = path.join(path.resolve(__dirname, '..'), 'index.html');
const PIN = '135790';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function freshPage(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
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
  return { context, page, errors };
}

async function vitalsKey(browser) {
  const { context, page, errors } = await freshPage(browser);
  const r = await page.evaluate(async () => {
    activeRoleDashboard = 'medic';
    goTo('sweep');
    startSweepCasualtyMarker();
    const p = patients[0];
    const keys = () => assessmentDebtList(p);
    const out = { created: keys() };
    p.mstart.breathing = 'yes'; p.mstart.avpu = 'A'; p.mstart.perfusion = 'radial_strong'; p.mstart.walking = 'no';
    syncPatientFromSweep(p);
    out.mstartOnly = keys();
    out.mstartRr = p.vitals.rr;
    openQuickVitals(p.id);
    modalVitals = { pulse: 92, spo2: 97, rr: 18, avpu: 'A', bp_estimate: 'radial_strong' };
    await saveModalVitals();
    out.measured = keys();
    out.sweepCount = sweepCounts([p]).missingVitals;
    // A patient saved by an older build: the old key never cleared and must not stick now.
    const old = { ...p, id: 'OLD-1', assessmentDebt: ['full_vitals', 'missing_treatment', 'identity'] };
    out.oldSaved = assessmentDebtList(old);
    return out;
  });
  assert(r.created.includes('missing_vitals'), `a new marker must show missing_vitals (got ${r.created})`);
  assert(!r.created.includes('full_vitals'), `full_vitals must no longer be emitted (got ${r.created})`);
  assert(r.mstartRr === 16, `test premise: MSTART "breathing yes" sets a placeholder rr of 16 (got ${r.mstartRr})`);
  assert(r.mstartOnly.includes('missing_vitals'), `MSTART answers alone must not clear missing_vitals (got ${r.mstartOnly})`);
  assert(!r.measured.includes('missing_vitals'), `a saved vitals set must clear missing_vitals (got ${r.measured})`);
  assert(r.sweepCount === 0, `the sweep's "no full vitals" counter must drop after vitals (got ${r.sweepCount})`);
  assert(!r.oldSaved.includes('full_vitals') && !r.oldSaved.includes('missing_treatment'), `retired keys saved by an older build must be dropped (got ${r.oldSaved})`);
  assert(r.oldSaved.includes('identity'), `other saved keys must stay (got ${r.oldSaved})`);
  assert(!errors.length, `page errors: ${errors.join(' | ')}`);
  await context.close();
}

async function chipsAndLabels(browser) {
  const { context, page } = await freshPage(browser);
  const r = await page.evaluate(() => {
    const base = { id: 'X', triage: 'red', location: 'מוקד', txHistory: [], vitals: {}, trapStatus: null, tourniquet: { limb: 'right_leg' }, patientStatus: 'identified' };
    const red = { ...base };
    const yellow = { ...base, triage: 'yellow' };
    return {
      redTqTime: debtChipClass(red, 'tourniquet_time_unknown'),
      yellowTqTime: debtChipClass(yellow, 'tourniquet_time_unknown'),
      redLimb: debtChipClass(red, 'tourniquet_limb_missing'),
      redVitals: debtChipClass(red, 'missing_vitals'),
      yellowIdentity: debtChipClass(yellow, 'identity'),
      keys: assessmentDebtForPatient({ ...base, triage: 'pending' }),
      labels: { triage: debtLabel('missing_triage'), trap: debtLabel('missing_trap_status'), vitals: debtLabel('missing_vitals') },
    };
  });
  assert(r.redTqTime === 'critical', `unknown tourniquet time on a red casualty must be red (got ${r.redTqTime})`);
  assert(r.yellowTqTime === 'overdue', `unknown tourniquet time on a non-red casualty stays orange (got ${r.yellowTqTime})`);
  assert(r.redLimb === 'overdue', `unknown tourniquet limb stays orange (got ${r.redLimb})`);
  assert(r.redVitals === 'critical', `missing vitals on a red casualty is red (got ${r.redVitals})`);
  assert(r.yellowIdentity === '', `other keys are neutral (got ${r.yellowIdentity})`);
  assert(!r.keys.includes('missing_treatment'), `missing_treatment must no longer be emitted (got ${r.keys})`);
  assert(r.keys.includes('tourniquet_time_unknown'), `test premise: a tourniquet with no time is flagged (got ${r.keys})`);
  assert(r.labels.triage === 'ממתין סיווג' && r.labels.trap === 'לכידות לא תועדה' && r.labels.vitals === 'אין מדדים מלאים',
    `labels (got ${JSON.stringify(r.labels)})`);
  await context.close();
}

async function oneAddButton(browser) {
  const { context, page } = await freshPage(browser);
  for (const role of ['medic', 'pc']) {
    const r = await page.evaluate((role) => {
      activeRoleDashboard = role;
      goTo('sweep');
      const visible = (el) => el.checkVisibility() && el.getBoundingClientRect().height > 0;
      const adders = [...document.querySelectorAll('button')].filter((b) => visible(b)
        && (/startSweepCasualtyMarker/.test(b.getAttribute('onclick') || '') || b.id === 'same-zone-fab'));
      return { count: adders.length, fab: document.getElementById('same-zone-fab')?.checkVisibility() || false };
    }, role);
    assert(r.fab, `${role}: the FAB must be up on the sweep screen with no casualty yet`);
    assert(r.count === 1, `${role}: exactly one add-casualty control on the sweep screen (got ${r.count})`);
  }
  await page.click('#same-zone-fab');
  const afterAdd = await page.evaluate(() => ({ n: patients.length, fab: document.getElementById('same-zone-fab').checkVisibility() }));
  assert(afterAdd.n === 1 && afterAdd.fab, `the FAB adds a casualty and stays up (got ${JSON.stringify(afterAdd)})`);
  const elsewhere = await page.evaluate(() => { goTo('role-dashboard'); return document.getElementById('same-zone-fab').checkVisibility(); });
  assert(!elsewhere, 'the FAB must be hidden off the sweep screen');
  await context.close();
}

async function limbCorrection(browser) {
  const { context, page, errors } = await freshPage(browser);
  const setup = await page.evaluate(() => {
    activeRoleDashboard = 'medic';
    goTo('sweep');
    startSweepCasualtyMarker();
    const p = patients[0];
    recordSweepTourniquetWithLimb('right_arm');
    const tq = activeTourniquets(p)[0];
    activeSweepPatientId = null;
    openPatient(p.id);
    return { pid: p.id, tqId: tq.id, limb: tq.limb, screen: activeScreenId() };
  });
  assert(setup.screen === 'patient' && setup.limb === 'right_arm', `test premise (got ${JSON.stringify(setup)})`);
  await page.click('#detail-body summary:has-text("תקן גפה")');
  await page.click('#detail-body button:has-text("רגל שמאל")');
  const fixed = await page.evaluate(({ pid, tqId }) => {
    const p = patients.find((x) => x.id === pid);
    const ev = getOutbox().filter((e) => e.type === 'TOURNIQUET_LIMB_RECORDED').pop();
    return { limb: p.tourniquets.find((t) => t.id === tqId).limb, ev: ev && ev.payload_json, screen: activeScreenId(),
      shown: document.getElementById('detail-body').innerText.includes('רגל שמאל') };
  }, setup);
  assert(fixed.limb === 'left_leg', `the limb must change (got ${fixed.limb})`);
  assert(fixed.ev && fixed.ev.limb === 'left_leg' && fixed.ev.previous_limb === 'right_arm', `TOURNIQUET_LIMB_RECORDED must carry the new and previous limb (got ${JSON.stringify(fixed.ev)})`);
  assert(fixed.screen === 'patient' && fixed.shown, 'the patient screen must stay open and show the corrected limb');

  // Cancel: dismissing the confirmation changes nothing; accepting cancels the entry.
  await page.click('#detail-body summary:has-text("תקן גפה")');
  page.once('dialog', (d) => d.dismiss());
  await page.click('#detail-body button:has-text("בטל רישום")');
  const kept = await page.evaluate(({ pid }) => activeTourniquets(patients.find((x) => x.id === pid)).length, setup);
  assert(kept === 1, `a dismissed confirmation must keep the tourniquet (got ${kept} active)`);
  page.once('dialog', (d) => d.accept());
  await page.click('#detail-body button:has-text("בטל רישום")');
  const gone = await page.evaluate(({ pid }) => ({ n: activeTourniquets(patients.find((x) => x.id === pid)).length,
    ev: getOutbox().some((e) => e.type === 'TOURNIQUET_ENTRY_CANCELLED') }), setup);
  assert(gone.n === 0 && gone.ev, `an accepted cancel must cancel the entry (got ${JSON.stringify(gone)})`);

  // A cc may not write clinical events: the patient screen shows the tourniquet, no fix controls.
  const cc = await page.evaluate(() => {
    const p = patients[0];
    activeSweepPatientId = p.id; // recordSweepTourniquetWithLimb() works on the open sweep casualty
    recordSweepTourniquetWithLimb('right_arm');
    activeSweepPatientId = null;
    currentUser ={ id: 'c1', email: 'cc@example.test', role: 'cc' };
    openPatient(p.id);
    const body = document.getElementById('detail-body').innerText;
    return { listed: body.includes('חסמים פעילים'), fix: body.includes('תקן גפה') };
  });
  assert(cc.listed && !cc.fix, `cc sees active tourniquets but no correction (got ${JSON.stringify(cc)})`);
  assert(!errors.length, `page errors: ${errors.join(' | ')}`);
  await context.close();
}

async function rosterPanels(browser) {
  const { context, page } = await freshPage(browser);
  const r = await page.evaluate(() => {
    const out = {};
    for (const role of ['cc', 'chamal', 'admin', 'pc']) {
      currentUser = { id: 'u-' + role, email: role + '@example.test', role };
      activeRoleDashboard = role;
      goTo('role-dashboard');
      renderRoleDashboard(role);
      out[role] = {
        roster: !!document.getElementById('platoon-roster-panel'),
        users: [...document.querySelectorAll('#role-dashboard-body button, #screen-role-dashboard button')].some((b) => /openAdminUsers/.test(b.getAttribute('onclick') || '')),
      };
    }
    return out;
  });
  for (const role of ['cc', 'chamal', 'admin']) assert(r[role].roster, `${role} dashboard must offer the roster panel (got ${JSON.stringify(r[role])})`);
  assert(!r.pc.roster, 'the pc dashboard must not offer the roster panel');
  assert(r.admin.users, 'the admin dashboard must offer user management');
  assert(!r.cc.users && !r.chamal.users && !r.pc.users, `only the admin dashboard offers user management (got ${JSON.stringify(r)})`);
  await context.close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await vitalsKey(browser);
    await chipsAndLabels(browser);
    await oneAddButton(browser);
    await limbCorrection(browser);
    await rosterPanels(browser);
  } finally {
    await browser.close();
  }
  console.log('browser_sweep_vitals_debt_test: passed - one vitals key, chip tiers and labels, one add button, limb correction from the patient screen, roster/user-management panels');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
