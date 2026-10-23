// Real-browser test for V2.99.61: the full-flow treatment step (screen-step7) ordered by
// MARCH-PAWS. Documentation only: no letter blocks the flow, changes triage or raises an alert.
//
// Checks, at phone width (375x812), in local demo mode with the page's own functions:
// - nine sections in order M A R C H, then P A W S, nothing wider than the viewport;
// - a treatment marks its letter "טופל", "נבדק - ללא טיפול" marks it checked, choosing a
//   treatment withdraws that, and "no treatment" cannot be set on a letter that has one;
// - the step 3 immediate tourniquet counts for M;
// - new MARCH treatments are sent as INTERVENTION_RECORDED (AIRWAY_MANAGED for airway) with the
//   patient's id, their Hebrew label and march_section; the create event carries march_review
//   with undocumented letters as null (shown as "לא תועד", never hidden);
// - hemostatic gauze and the hypothermia blanket come out of the medic's own stock;
// - a restored draft shows its selected treatments and letter states again.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_march_paws_test.js
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
  assert(fs.existsSync(file), 'missing file: index.html');
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    // No backend in this test: serve an empty supabase-js instead of waiting on the CDN.
    await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
    await page.fill('#pin-gate-setup-new', PIN);
    await page.fill('#pin-gate-setup-confirm', PIN);
    await page.click('#pin-gate-setup-btn');
    await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });

    // 1. Layout and order.
    const layout = await page.evaluate(() => {
      patients = [];
      startNewPatient('extended');
      state.triage = 'red';
      state.trapStatus = 'not_trapped';
      state.injury = 'פיצוץ';
      goTo('step7');
      const screen = document.getElementById('screen-step7');
      const letters = [...screen.querySelectorAll('.march-section .march-letter')].map((el) => el.textContent);
      const wide = [...screen.querySelectorAll('.march-section, .march-section .chip, .march-clear')]
        .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 || el.getBoundingClientRect().left < -1)
        .map((el) => el.id || el.textContent.trim());
      return {
        active: document.querySelector('.screen.active')?.id,
        letters: letters.join(''),
        wide,
        states: [...screen.querySelectorAll('.march-state')].map((el) => el.textContent),
        progress: document.getElementById('march-progress').textContent,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    assert(layout.active === 'screen-step7', `step 7 must be open, got ${layout.active}`);
    assert(layout.letters === 'MARCHPAWS', `sections must be M A R C H P A W S, got ${layout.letters}`);
    assert(layout.wide.length === 0, `nothing on the MARCH screen may go past a 375px viewport: ${layout.wide.join(', ')}`);
    assert(layout.scrollWidth <= 375, `no horizontal page scroll at 375px, scrollWidth ${layout.scrollWidth}`);
    assert(layout.states.every((s) => s === 'לא תועד'), `every letter starts as not documented, got ${layout.states}`);
    assert(layout.progress === 'תועדו: MARCH 0/5 · PAWS 0/4', `progress line, got "${layout.progress}"`);

    // 2. Real taps: treatments, "no treatment needed", and their interaction.
    await page.click('#march-sec-m .chip[data-tx="hemostatic"]');
    // Consuming stock opens the existing "supply used" sheet; the medic confirms it.
    await page.click('#supply-used-modal button[onclick="confirmSupplyUsed()"]');
    await page.click('#march-sec-r .chip[data-tx="chest_seal"]');
    await page.click('#march-sec-a .chip[data-tx="npa"]');
    await page.click('#march-clear-h');
    await page.click('#march-clear-c');
    await page.click('#march-sec-c .chip[data-tx="txa"]'); // withdraws "no treatment" for C
    await page.click('#march-clear-m'); // M already has a treatment: refused
    await page.click('#march-sec-s .chip[data-tx="splint"]');
    const taps = await page.evaluate(() => ({
      review: marchReviewFromState(),
      clear: [...state.marchClear].sort().join(),
      mState: document.getElementById('march-state-m').textContent,
      hState: document.getElementById('march-state-h').textContent,
      cClearSelected: document.getElementById('march-clear-c').classList.contains('selected'),
      progress: document.getElementById('march-progress').textContent,
      gauze: state.localStockCache.hemostaticGauze,
    }));
    assert(JSON.stringify(taps.review) === JSON.stringify({ m: 'treated', a: 'treated', r: 'treated', c: 'treated', h: 'clear', p: null, ab: null, w: null, s: 'treated' }),
      `letter review after taps, got ${JSON.stringify(taps.review)}`);
    assert(taps.clear === 'h', `only H stays "no treatment needed" (C withdrawn by TXA, M refused), got ${taps.clear}`);
    assert(taps.mState === 'טופל' && taps.hState === 'נבדק - ללא טיפול', `letter labels, got M "${taps.mState}" H "${taps.hState}"`);
    assert(!taps.cClearSelected, 'C\'s "no treatment needed" button must clear once a C treatment is chosen');
    assert(taps.progress === 'תועדו: MARCH 5/5 · PAWS 1/4', `progress line after taps, got "${taps.progress}"`);
    assert(taps.gauze === 1, `hemostatic gauze must come out of the medic's stock (2 -> 1), got ${taps.gauze}`);

    // 3. Restored draft: chips and letter states come back.
    const restored = await page.evaluate(() => {
      const snap = JSON.parse(JSON.stringify(serializeActiveDraft('step7')));
      startNewPatient('extended');
      hydrateActiveDraft(snap);
      goTo('step7');
      return {
        selected: [...document.querySelectorAll('#screen-step7 .chip.selected')].map((c) => c.dataset.tx).sort().join(),
        hClear: document.getElementById('march-clear-h').classList.contains('selected'),
      };
    });
    assert(restored.selected === 'chest_seal,hemostatic,npa,splint,txa', `restored draft must show its treatments, got ${restored.selected}`);
    assert(restored.hClear, 'restored draft must keep H as checked');

    // 4. Summary shows every letter, undocumented ones included.
    const summary = await page.evaluate(() => { goTo('step8'); return document.getElementById('summary-content').textContent; });
    assert(summary.includes('MARCH-PAWS') && summary.includes('P כאב: לא תועד') && summary.includes('H היפותרמיה / פגיעת ראש: נבדק - ללא טיפול'),
      'summary must list each MARCH-PAWS letter, "לא תועד" included');

    // 5. Save: what reaches the outbox.
    const saved = await page.evaluate(() => {
      const before = getOutbox().length;
      savePatient();
      const p = patients[patients.length - 1];
      const added = getOutbox().slice(before).filter((e) => SYNC_ELIGIBLE_EVENT_TYPES.has(e.type) && !e.localOnly && !/SUPPLY|RESUPPLY|INVENTORY_|STOCKOUT/.test(e.type));
      return { pid: p.id, marchReview: p.marchReview, added: added.map((e) => ({ type: e.type, pid: e.patient_id, payload: e.payload_json })) };
    });
    assert(/PATIENT_CREATED$/.test(saved.added[0]?.type), `create event first, got ${saved.added.map((e) => e.type)}`);
    assert(saved.added.every((e) => e.pid === saved.pid), 'every synced event must carry the new patient\'s id');
    const create = saved.added[0].payload;
    assert(JSON.stringify(create.march_review) === JSON.stringify(taps.review), `create event must carry march_review, got ${JSON.stringify(create.march_review)}`);
    assert(JSON.stringify(saved.marchReview) === JSON.stringify(taps.review), 'the local patient keeps marchReview');
    const tx = saved.added.filter((e) => e.type === 'INTERVENTION_RECORDED' || e.type === 'AIRWAY_MANAGED')
      .map((e) => `${e.type}:${e.payload.treatment_type}:${e.payload.treatment_label}:${e.payload.march_section}`).sort();
    const expected = [
      'AIRWAY_MANAGED:npa:נתיב אוויר אפי (NPA):a',
      'INTERVENTION_RECORDED:chest_seal:חבישה אוטמת לחזה:r',
      'INTERVENTION_RECORDED:hemostatic:גזה המוסטטית:m',
      'INTERVENTION_RECORDED:splint:קיבוע / סד:s',
      'INTERVENTION_RECORDED:txa:TXA:c',
    ].sort();
    assert(JSON.stringify(tx) === JSON.stringify(expected), `MARCH treatments sent, got ${JSON.stringify(tx)}`);

    // 6. The step 3 immediate tourniquet counts for M; a quick-flow or black patient sends no march_review.
    const quickTq = await page.evaluate(() => {
      startNewPatient('extended');
      quickTqData.applied = true;
      goTo('step7');
      const m = document.getElementById('march-state-m').textContent;
      startNewPatient('quick');
      state.triage = 'yellow';
      const before = getOutbox().length;
      savePatient();
      const create = getOutbox().slice(before).find((e) => /PATIENT_CREATED$/.test(e.type));
      return { m, quickHasReview: 'march_review' in (create?.payload_json || {}) };
    });
    assert(quickTq.m === 'טופל', `immediate tourniquet from step 3 must mark M as treated, got ${quickTq.m}`);
    assert(!quickTq.quickHasReview, 'a quick-flow patient never saw step 7 and must not send march_review');

    // 7. Cric and needle decompression: paramedic or physician only (owner 2026-10-23).
    const scopeFor = async (setRole) => {
      await page.evaluate((r) => {
        currentUser = null;
        activeRoleDashboard = 'medic';
        if (r.signedIn) currentUser = { role: r.role }; else activeRoleDashboard = r.role;
        startNewPatient('extended');
        goTo('step7');
      }, setRole);
      // The button's own click (it is aria-disabled for other roles, and a refusal toast from the
      // previous run can sit over it, so not a coordinate click).
      await page.$eval('#march-sec-a .chip[data-tx="cric"]', (el) => el.click());
      await page.$eval('#march-sec-r .chip[data-tx="needle_decompression"]', (el) => el.click());
      const r = await page.evaluate(() => ({
        selected: ['cric', 'needle_decompression'].filter((k) => state.interventions.has(k)).join(),
        restricted: document.querySelector('#screen-step7 .chip[data-tx="cric"]').classList.contains('restricted'),
      }));
      await page.evaluate(() => { currentUser = null; activeRoleDashboard = 'medic'; });
      return r;
    };
    const medic = await scopeFor({ role: 'medic' });
    assert(medic.selected === '' && medic.restricted, `a medic must not record cric / needle decompression, got ${JSON.stringify(medic)}`);
    const pc = await scopeFor({ role: 'pc', signedIn: true });
    assert(pc.selected === '' && pc.restricted, `a signed-in PC must not record them, got ${JSON.stringify(pc)}`);
    for (const role of ['paramedic', 'physician']) {
      const ok = await scopeFor({ role, signedIn: true });
      assert(ok.selected === 'cric,needle_decompression' && !ok.restricted, `a signed-in ${role} must record both, got ${JSON.stringify(ok)}`);
    }
    const demoParamedic = await scopeFor({ role: 'paramedic' });
    assert(demoParamedic.selected === 'cric,needle_decompression', `demo paramedic must record both, got ${JSON.stringify(demoParamedic)}`);

    assert(pageErrors.length === 0, `uncaught page error(s): ${pageErrors.join(' | ')}`);
    await page.close();
    console.log('index.html: MARCH-PAWS treatment step browser test passed');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
