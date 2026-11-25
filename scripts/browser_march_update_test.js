// Real-browser test for V2.99.85 (owner 2026-11-21): MARCH-PAWS for a casualty already on the board.
//
// The medic's add buttons open the sweep marker, so before this a medic, paramedic or physician
// never reached the MARCH-PAWS step. Now:
// - the patient card's "עוד" panel has "טיפולים MARCH-PAWS" for the roles that record treatments
//   (AUTH_MATRIX "Record vitals and interventions"), not for CC / logistics / rescue;
// - it opens the same step 7 screen for that casualty: header with the casualty's id, "שמור טיפולים",
//   back returns to the card, the casualty's age group drives the pediatric dose guard;
// - saving sends the treatments (march_section, source march_update), the medication with the
//   weight under both names, a tourniquet added to the casualty's list, the per-letter review as a
//   NOTE_ADDED, all with the casualty's uuid; no triage or status change;
// - nothing chosen and no letter marked: refused, nothing sent; back: nothing clinical sent;
// - a draft restored on reload stays on its casualty;
// - the medic panel and the zone bar offer "פצוע חדש - טופס מלא", which opens the full form.
// - WP-31 (owner 2026-11-23): reopening shows the letters earlier saves documented; a letter
//   treated earlier offers "בדיקה חוזרת: הטיפול יעיל" and refuses "no treatment needed"; the save
//   sends only what changed and the casualty's review merges newest-per-letter, with reviews from
//   other phones (PATIENT_CREATED / NOTE_ADDED march_review); the card shows what MARCH still
//   lacks; the PC's "חוב הערכה" lists red / yellow casualties with MARCH incomplete; a PC going
//   hands-on records it the same way.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_march_update_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
const PIN = '135790';
const CHILD = 'eeeeeeee-0000-4000-8000-000000000001';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  assert(fs.existsSync(file), 'missing file: index.html');
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
    await page.fill('#pin-gate-setup-new', PIN);
    await page.fill('#pin-gate-setup-confirm', PIN);
    await page.click('#pin-gate-setup-btn');
    await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });

    // A yellow child on the board, one tourniquet already on, with one earlier treatment.
    await page.evaluate((id) => {
      siteData.name = 'מוקד בדיקה';
      activeRoleDashboard = 'medic';
      patients.push({ id, visualId: 'P009-TS', triage: 'yellow', patientStatus: 'observing', patientAgeGroup: 'pediatric', patientAge: 6,
        events: [], txHistory: [{ time: '10:00', text: 'חבישה', medic: 'x' }], siteId: 'SITE_A', vitals: { ...VITALS_NOT_ON_DEVICE },
        tourniquets: [{ id: 'TQ-001', appliedAt: Date.now() - 600000, limb: 'left_leg', limbLabel: 'רגל שמאל', status: 'active', effectiveness: 'unknown' }] });
      openPatient(id);
    }, CHILD);

    // 1. Patient card: the button is under "עוד" for a medic.
    await page.click('#detail-bar-more-btn');
    const btn = page.locator(`[data-march-open="${CHILD}"]`);
    assert(await btn.isVisible(), 'the patient card must offer "טיפולים MARCH-PAWS" to a medic');
    await btn.click();
    const opened = await page.evaluate(() => ({
      screen: document.querySelector('.screen.active')?.id,
      header: document.querySelector('#screen-step7 .flow-step')?.textContent,
      saveText: document.getElementById('btn-step7')?.textContent,
      history: document.getElementById('tx-history-block')?.style.display,
      group: state.patientAgeGroup,
      morphine: doses.morphine,
    }));
    assert(opened.screen === 'screen-step7', `must open the MARCH-PAWS screen, got ${opened.screen}`);
    assert(opened.header === 'טיפול בפצוע P009-TS', `header names the casualty, got "${opened.header}"`);
    assert(opened.saveText === '✓ שמור טיפולים' && opened.history === 'block', `save button and earlier treatments, got ${JSON.stringify(opened)}`);
    assert(opened.group === 'pediatric' && opened.morphine < 5, `the child's age group drives the dose guard, got ${JSON.stringify(opened)}`);

    // 2. Nothing chosen: refused, nothing sent.
    const before0 = await page.evaluate(() => getOutbox().length);
    await page.click('#btn-step7');
    const refused = await page.evaluate((n) => ({ screen: document.querySelector('.screen.active')?.id, sent: getOutbox().length - n }), before0);
    assert(refused.screen === 'screen-step7' && refused.sent === 0, `an empty save must be refused, got ${JSON.stringify(refused)}`);

    // 3. Treatments, a letter marked clear, a medication and a new tourniquet; the medic cannot record a cric.
    await page.evaluate(() => {
      openMarchLetter('r'); toggleChip(document.querySelector('.chip[data-tx="chest_seal"]'), 'chest_seal');
      openMarchLetter('a'); document.querySelector('.chip[data-tx="cric"]').click();
      openMarchLetter('h'); toggleMarchClear(document.getElementById('march-clear-h'), 'h');
      openMarchLetter('m'); toggleChip(document.querySelector('.chip[data-tx="tourniquet"]'), 'tourniquet');
      toggleLimb(document.querySelector('#limb-grid .limb-btn'), 'yl');
      state.interventions.add('morphine'); state.pediatricOverrides.morphine = null;
    });
    const before = await page.evaluate(() => getOutbox().length);
    await page.click('#btn-step7');
    const saved = await page.evaluate(({ id, n }) => {
      const p = patients.find((x) => x.id === id);
      return {
        screen: document.querySelector('.screen.active')?.id,
        status: p.patientStatus, triage: p.triage,
        tqs: p.tourniquets.map((t) => `${t.id}:${t.limb}`),
        history: p.txHistory[0]?.text,
        review: p.marchReview,
        events: getOutbox().slice(n).filter((e) => SYNC_ELIGIBLE_EVENT_TYPES.has(e.type) && !/SUPPLY|INVENTORY_|STOCKOUT/.test(e.type))
          .map((e) => ({ type: e.type, pid: e.patient_id, synced: e.synced, payload: e.payload_json })),
      };
    }, { id: CHILD, n: before });
    assert(saved.screen === 'screen-patient', `save returns to the patient card, got ${saved.screen}`);
    assert(saved.status === 'observing' && saved.triage === 'yellow', `no status or triage change, got ${saved.status}/${saved.triage}`);
    assert(saved.events.length && saved.events.every((e) => e.pid === CHILD && e.synced === false), `every event carries the casualty's uuid and is queued, got ${JSON.stringify(saved.events.map((e) => [e.type, e.pid]))}`);
    const tx = saved.events.filter((e) => e.type === 'INTERVENTION_RECORDED' || e.type === 'AIRWAY_MANAGED');
    assert(tx.length === 1 && tx[0].payload.treatment_type === 'chest_seal' && tx[0].payload.march_section === 'r' && tx[0].payload.source === 'march_update',
      `chest seal sent once with its letter and source, cric never, got ${JSON.stringify(tx.map((e) => e.payload))}`);
    const med = saved.events.find((e) => e.type === 'MEDICATION_ADMINISTERED');
    assert(med && med.payload.weight_estimate_kg > 0 && med.payload.estimated_weight_kg === med.payload.weight_estimate_kg, `the child's medication carries the weight under both names, got ${JSON.stringify(med?.payload)}`);
    const tq = saved.events.find((e) => e.type === 'TOURNIQUET_APPLIED');
    assert(tq && tq.payload.limb === 'left_arm' && tq.payload.source === 'march_update', `the new tourniquet is sent, got ${JSON.stringify(tq?.payload)}`);
    assert(saved.tqs.join() === 'TQ-001:left_leg,TQ-002:left_arm', `the tourniquet is added to the casualty's list, got ${saved.tqs}`);
    const note = saved.events.find((e) => e.type === 'NOTE_ADDED');
    assert(note && note.payload.kind === 'march_review' && note.payload.march_review.h === 'clear' && note.payload.march_review.r === 'treated' && note.payload.march_review.m === 'treated' && note.payload.march_review.w === null,
      `the per-letter review is sent as a NOTE_ADDED, got ${JSON.stringify(note?.payload)}`);
    assert(saved.history && saved.history.includes('חבישה אוטמת לחזה'), `the patient card history shows the treatment, got ${saved.history}`);

    // 4. Back without saving: nothing clinical sent, back on the card.
    await page.evaluate((id) => openMarchForPatient(id), CHILD);
    await page.evaluate(() => { openMarchLetter('r'); toggleChip(document.querySelector('.chip[data-tx="oxygen"]'), 'oxygen'); });
    const before4 = await page.evaluate(() => getOutbox().length);
    await page.click('#screen-step7 .btn-back');
    const cancelled = await page.evaluate((n) => ({
      screen: document.querySelector('.screen.active')?.id,
      clinical: getOutbox().slice(n).filter((e) => /INTERVENTION_RECORDED|AIRWAY_MANAGED|MEDICATION|NOTE_ADDED|TOURNIQUET_APPLIED/.test(e.type)).length,
      mode: state.marchUpdatePid || null,
    }), before4);
    assert(cancelled.screen === 'screen-patient' && cancelled.clinical === 0 && cancelled.mode === null, `back must discard, got ${JSON.stringify(cancelled)}`);

    // 5. A restored draft stays on its casualty.
    const restored = await page.evaluate(async (id) => {
      openMarchForPatient(id);
      const snap = JSON.parse(JSON.stringify(serializeActiveDraft('step7')));
      state = freshState();
      hydrateActiveDraft(snap);
      goTo('step7');
      const r = { pid: state.marchUpdatePid, header: document.querySelector('#screen-step7 .flow-step')?.textContent };
      cancelMarchUpdate();
      return r;
    }, CHILD);
    assert(restored.pid === CHILD && restored.header === 'טיפול בפצוע P009-TS', `a restored draft stays on its casualty, got ${JSON.stringify(restored)}`);

    // 6. Roles: CC and logistics do not get the button; the normal form is unchanged.
    const roles = await page.evaluate((id) => {
      const seen = {};
      for (const r of ['cc', 'logistics', 'rcc', 'paramedic', 'physician', 'pc']) { activeRoleDashboard = r; openPatient(id); seen[r] = !!document.querySelector(`[data-march-open="${id}"]`); }
      activeRoleDashboard = 'medic';
      startNewPatient('extended'); goTo('step7');
      return { seen, btn: document.getElementById('btn-step7').textContent, back: document.querySelector('#screen-step7 .btn-back').getAttribute('onclick'), header: document.querySelector('#screen-step7 .flow-step').textContent };
    }, CHILD);
    assert(!roles.seen.cc && !roles.seen.logistics && !roles.seen.rcc && roles.seen.paramedic && roles.seen.physician && roles.seen.pc, `button only for treatment roles, got ${JSON.stringify(roles.seen)}`);
    assert(roles.btn === 'המשך למיקום' && roles.back === "goTo('step6')" && roles.header === 'שלב 6 / 8', `the New Patient form keeps its own buttons, got ${JSON.stringify(roles)}`);

    // 7. The medic panel offers the full form for a new casualty.
    const full = await page.evaluate(() => {
      const holder = document.createElement('div');
      holder.innerHTML = renderMedicActionPanel();
      document.body.appendChild(holder);
      holder.querySelector('[data-full-form]').click();
      const r = { screen: document.querySelector('.screen.active')?.id, mode: state.flowMode };
      holder.remove();
      return r;
    });
    assert(full.screen === 'screen-step1' && full.mode === 'extended', `"פצוע חדש - טופס מלא" opens the full form, got ${JSON.stringify(full)}`);

    // 8. WP-31: reassessment of an earlier treatment, merge, other phones, card, PC debt row.
    const pcDebt = () => page.evaluate(() => {
      const holder = document.createElement('div');
      holder.innerHTML = renderPcAssessmentDebtBoard();
      const row = [...holder.querySelectorAll('.role-row')].find((el) => el.textContent.includes('MARCH לא הושלם'));
      return row ? row.textContent.replace(/\s+/g, ' ') : null;
    });
    const reopened = await page.evaluate((id) => {
      activeRoleDashboard = 'medic';
      openMarchForPatient(id);
      const tiles = Object.fromEntries([...document.querySelectorAll('#march-strip .march-tile')].map((el) => [el.id.replace('march-tile-', ''), el.querySelector('small').textContent]));
      const btn = getComputedStyle(document.getElementById('march-reassess-m')).display !== 'none';
      openMarchLetter('m');
      toggleMarchClear(document.getElementById('march-clear-m'), 'm');
      return { tiles, btn, clearM: state.marchClear.has('m'), review: marchReviewFromState() };
    }, CHILD);
    assert(reopened.tiles.m === 'בדיקה חוזרת' && reopened.tiles.r === 'בדיקה חוזרת' && reopened.tiles.h === 'חסר AVPU' && reopened.tiles.a === 'לא תועד',
      `reopening shows the earlier letters, got ${JSON.stringify(reopened.tiles)}`);
    assert(reopened.btn && !reopened.clearM, `M treated earlier offers the reassessment and refuses "no treatment needed", got ${JSON.stringify(reopened)}`);
    assert(Object.values(reopened.review).every((v) => v === null), `nothing new before a tap, got ${JSON.stringify(reopened.review)}`);
    await page.click('#march-reassess-m');
    const before8 = await page.evaluate(() => getOutbox().length);
    await page.click('#btn-step7');
    const merged = await page.evaluate(({ id, n }) => {
      const p = patients.find((x) => x.id === id);
      const note = getOutbox().slice(n).find((e) => e.type === 'NOTE_ADDED');
      return { sent: note?.payload_json?.march_review, review: p.marchReview, status: patientMarchStatus(p), card: document.querySelector('[data-march-status]')?.textContent };
    }, { id: CHILD, n: before8 });
    assert(merged.sent.m === 'effective' && ['a', 'r', 'c', 'h', 'p', 'ab', 'w', 's'].every((k) => merged.sent[k] === null), `only the reassessment is sent, got ${JSON.stringify(merged.sent)}`);
    assert(merged.review.m === 'effective' && merged.review.r === 'treated' && merged.review.h === 'clear', `the casualty keeps earlier letters, got ${JSON.stringify(merged.review)}`);
    assert(merged.status.missing.join() === 'a,r,c,h' && merged.card === 'MARCHחסר: A (לא תועד) · R (בדיקה חוזרת) · C (לא תועד) · H (AVPU)', `card shows what is missing, got ${merged.card}`);
    await page.evaluate(() => { activeRoleDashboard = 'pc'; });
    let debt = await pcDebt();
    assert(debt && debt.includes('1 פצועים') && debt.includes('P009-TS'), `the PC's debt board lists the yellow casualty, got ${debt}`);

    // Another phone documented A, R (reassessed) and C; this phone's own rows and other notes are ignored.
    const remote = await page.evaluate((id) => {
      const later = new Date(Date.now() + 60000).toISOString();
      applyRemoteMarchReviews([
        { id: 'e1', patient_id: id, device_id: 'other-phone', type: 'NOTE_ADDED', kind: 'march_review', local_timestamp: later, march_review: { a: 'clear', r: 'effective', c: 'clear', h: 'bogus' } },
        { id: 'e2', patient_id: id, device_id: 'other-phone', type: 'NOTE_ADDED', kind: 'free_text', local_timestamp: later, march_review: { m: 'treated' } },
        { id: 'e3', patient_id: id, device_id: getDeviceId(), type: 'NOTE_ADDED', kind: 'march_review', local_timestamp: later, march_review: { m: 'treated' } },
      ]);
      const p = patients.find((x) => x.id === id);
      return { review: patientMarchReview(p), missing: patientMarchStatus(p).missing.join() };
    }, CHILD);
    assert(remote.review.m === 'effective' && remote.review.r === 'effective' && remote.review.a === 'clear' && remote.review.h === 'clear' && remote.missing === 'h',
      `other phones' reviews merge in, got ${JSON.stringify(remote)}`);
    await page.evaluate((id) => { const p = patients.find((x) => x.id === id); p.vitals = { ...p.vitals, avpu: 'A' }; openPatient(id); }, CHILD);
    const done = await page.evaluate(() => document.querySelector('[data-march-status]')?.getAttribute('data-march-status'));
    debt = await pcDebt();
    assert(done === 'complete' && debt && debt.includes('0 פצועים'), `with AVPU MARCH is complete and leaves the debt board, got ${done} / ${debt}`);

    // A PC going hands-on records MARCH the same way (TREATMENT_RECORDING_ROLES has pc).
    const pcHands = await page.evaluate((id) => { openMarchForPatient(id); const s = document.querySelector('.screen.active')?.id; cancelMarchUpdate(); activeRoleDashboard = 'medic'; return s; }, CHILD);
    assert(pcHands === 'screen-step7', `a PC opens MARCH-PAWS for a casualty, got ${pcHands}`);

    assert(pageErrors.length === 0, `uncaught page error(s): ${pageErrors.join(' | ')}`);
    await page.close();
    console.log('index.html: MARCH-PAWS for a casualty on the board browser test passed');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
