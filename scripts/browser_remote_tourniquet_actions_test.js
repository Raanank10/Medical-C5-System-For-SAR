// Real-browser test for WP-46 (owner 2026-11-26): acting on a tourniquet another phone recorded.
//
// Owner decisions: every clinical role may act on another phone's tourniquet (a check any time,
// conversion to direct pressure within the role's limit, a typo-cancel, a limb correction); when
// another phone converts (or cancels) a tourniquet, the phone that recorded it alerts about it and
// then cancels every alarm that tourniquet caused.
//
// Recording phone (this page as phone A, the casualty is its own):
// - another phone's "bleeding continues" is followed (tourniquet ineffective, a notice, M reopens);
//   its "דימום נשלט" and a limb correction are followed too;
// - another phone's conversion: a notice that stays until "הבנתי", the tourniquet is converted, its
//   open alarm and snooze are cleared, it leaves the active list (no more time alerts), and stays an
//   M treatment; another phone's typo-cancel: a notice, the tourniquet is removed (removed_error);
// - this phone's own server events change nothing; a casualty with a change still in the outbox is
//   left alone.
// Other phone (this page as phone B, the casualty came from the server):
// - a server tourniquet carries serverLimb, so a check, a conversion and a typo-cancel are sent;
// - a conversion also sends march_tq (M keeps it everywhere), a typo-cancel march_tq_cancelled
//   (it leaves M everywhere).
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_remote_tourniquet_actions_test.js
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
    await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('dialog', (d) => d.accept());
    await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
    await page.fill('#pin-gate-setup-new', PIN);
    await page.fill('#pin-gate-setup-confirm', PIN);
    await page.click('#pin-gate-setup-btn');
    await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });

    // Phone A: its own red casualty with two tourniquets, both sent to the server.
    const setup = await page.evaluate(() => {
      activeRoleDashboard = 'medic';
      const p = { id: 'eeeeeeee-0000-4000-8000-0000000000a1', visualId: 'P-A1', triage: 'red', patientStatus: 'observing', siteId: 'SITE_A',
        events: [], vitals: { ...VITALS_NOT_ON_DEVICE }, vitalsHistory: [], tourniquets: [], marchReviews: [] };
      patients.push(p);
      const t1 = { id: 'TQ-001', limb: 'right_leg', limbLabel: 'רגל ימין', appliedAt: Date.now() - 50 * 60000, status: 'active', effectiveness: 'unknown', serverLimb: 'right_leg', timeAlertOpen: 'notice', timeAlertSnooze: { level: 'notice', until: Date.now() + 60000 } };
      const t2 = { id: 'TQ-002', limb: 'left_arm', limbLabel: 'יד שמאל', appliedAt: Date.now() - 20 * 60000, status: 'active', effectiveness: 'unknown', serverLimb: 'left_arm' };
      p.tourniquets.push(t1, t2);
      queueTourniquetAppliedEvent(p, t1, { source: 'sweep' });
      queueTourniquetAppliedEvent(p, t2, { source: 'sweep' });
      // Pushed: the outbox is empty for this casualty.
      getOutbox().forEach((e) => { e.synced = true; });
      const me = getDeviceId();
      TQ_EVENT_META.set('ev-a1', { device: me, leid: t1.appliedLocalEventId, role: 'medic', type: 'TOURNIQUET_APPLIED' });
      TQ_EVENT_META.set('ev-a2', { device: me, leid: t2.appliedLocalEventId, role: 'medic', type: 'TOURNIQUET_APPLIED' });
      MARCH_TQ_EVENT_KEYS.set('ev-a1', `${me}:${t1.appliedLocalEventId}`);
      MARCH_TQ_EVENT_KEYS.set('ev-a2', `${me}:${t2.appliedLocalEventId}`);
      return { id: p.id, me };
    });
    const row = (over) => ({ id: 'row-1', patient_id: setup.id, limb: 'right_leg', applied_at: new Date().toISOString(), is_active: true,
      tourniquet_status: 'applied', applied_event_id: 'ev-a1', released_event_id: null, released_at: null, last_reassessed_event_id: null, ...over });
    const state = () => page.evaluate((id) => {
      const p = patients.find((x) => x.id === id);
      const t = (tid) => p.tourniquets.find((x) => x.id === tid);
      return { t1: { ...t('TQ-001') }, t2: { ...t('TQ-002') }, active: activeTourniquets(p).map((x) => x.id), m: patientMarchReview(p).m,
        notices: [...document.querySelectorAll('#tq-remote-notice .tq-remote-notice-row')].map((r) => r.textContent) };
    }, setup.id);

    // 1. Phone B records "bleeding continues" on TQ-001.
    await page.evaluate((r) => {
      TQ_EVENT_META.set('ev-b-chk1', { device: 'phone-b', leid: 'local-b-1', role: 'paramedic', type: 'TOURNIQUET_REASSESSMENT' });
      applyOwnTourniquetUpdates([r], null);
    }, row({ tourniquet_status: 'bleeding_continues', last_reassessed_event_id: 'ev-b-chk1' }));
    let s = await state();
    assert(s.t1.effectiveness === 'bleeding_continues' && s.t1.status === 'ineffective' && s.t1.bleedEventKey === 'phone-b:local-b-1', `another phone's "bleeding continues" is followed, got ${JSON.stringify(s.t1)}`);
    assert(s.notices.length === 1 && s.notices[0].includes('דימום ממשיך') && s.notices[0].includes('טלפון אחר'), `a notice says so, got ${JSON.stringify(s.notices)}`);
    assert(s.m === 'treated', `M reopens, got ${s.m}`);

    // 2. Phone B: "דימום נשלט", and corrects the limb to the left leg.
    await page.evaluate((r) => {
      TQ_EVENT_META.set('ev-b-chk2', { device: 'phone-b', leid: 'local-b-2', role: 'paramedic', type: 'TOURNIQUET_REASSESSMENT' });
      applyOwnTourniquetUpdates([r], null);
    }, row({ tourniquet_status: 'effective', last_reassessed_event_id: 'ev-b-chk2', limb: 'left_leg' }));
    s = await state();
    assert(s.t1.effectiveness === 'effective' && s.t1.status === 'active' && !s.t1.bleedEventKey, `"דימום נשלט" from another phone is followed, got ${JSON.stringify(s.t1)}`);
    assert(s.t1.limb === 'left_leg' && s.t1.serverLimb === 'left_leg', `a limb correction from another phone is followed, got ${JSON.stringify(s.t1)}`);
    assert(s.notices.length === 1, `"דימום נשלט" is logged, not alerted, got ${s.notices.length}`);

    // 3. This phone's own check changes nothing.
    await page.evaluate((r) => {
      TQ_EVENT_META.set('ev-a-chk', { device: getDeviceId(), leid: 'local-a-9', role: 'medic', type: 'TOURNIQUET_REASSESSMENT' });
      applyOwnTourniquetUpdates([r], null);
    }, row({ tourniquet_status: 'bleeding_continues', last_reassessed_event_id: 'ev-a-chk', limb: 'left_leg' }));
    s = await state();
    assert(s.t1.effectiveness === 'effective', `this phone's own server event is not re-applied, got ${s.t1.effectiveness}`);

    // 4. A change still in the outbox: left alone.
    const pendingKept = await page.evaluate((r) => {
      const p = patients[patients.length - 1];
      getOutbox().push({ type: 'NOTE_ADDED', patient_id: p.id, synced: false, local_event_id: 'local-x', payload_json: {} });
      TQ_EVENT_META.set('ev-b-rel', { device: 'phone-b', leid: 'local-b-3', role: 'paramedic', type: 'TOURNIQUET_RELEASED', reason: 'converted_direct_pressure' });
      applyOwnTourniquetUpdates([r], null);
      const kept = p.tourniquets.find((x) => x.id === 'TQ-001').status;
      getOutbox().forEach((e) => { e.synced = true; });
      return kept;
    }, row({ is_active: false, released_event_id: 'ev-b-rel', released_at: new Date().toISOString(), limb: 'left_leg', last_reassessed_event_id: 'ev-a-chk' }));
    assert(pendingKept === 'active', `a casualty with an unsent change is left alone, got ${pendingKept}`);

    // 5. Phone B converts TQ-001 to direct pressure: alert, then every alarm of it cancelled.
    await page.evaluate((r) => applyOwnTourniquetUpdates([r], null),
      row({ is_active: false, released_event_id: 'ev-b-rel', released_at: new Date().toISOString(), limb: 'left_leg', last_reassessed_event_id: 'ev-a-chk' }));
    s = await state();
    assert(s.t1.status === 'converted' && s.t1.timeAlertOpen === null && s.t1.timeAlertSnooze === null && !s.active.includes('TQ-001'),
      `converted elsewhere: converted, alarms cleared, no longer active, got ${JSON.stringify({ t1: s.t1, active: s.active })}`);
    assert(s.notices[0].includes('הומר ללחץ ישיר בטלפון אחר') && s.notices[0].includes('כל ההתראות שלו בוטלו') && s.notices[0].includes('פראמדיק'),
      `the conversion is alerted with who did it, got ${JSON.stringify(s.notices)}`);
    assert(s.m === 'treated', `a converted tourniquet stays an M treatment, got ${s.m}`);
    const raised = await page.evaluate(() => { const p = patients[patients.length - 1]; const t = p.tourniquets.find((x) => x.id === 'TQ-001'); return C5Rules.tourniquetAlertToRaise ? activeTourniquets(p).includes(t) : false; });
    assert(!raised, 'the converted tourniquet raises no more time alerts');

    // 6. Phone B cancels TQ-002 as a typo.
    await page.evaluate((r) => {
      TQ_EVENT_META.set('ev-b-rel2', { device: 'phone-b', leid: 'local-b-4', role: 'medic', type: 'TOURNIQUET_RELEASED', reason: 'entry_cancelled' });
      applyOwnTourniquetUpdates([r], null);
    }, row({ id: 'row-2', limb: 'left_arm', applied_event_id: 'ev-a2', is_active: false, released_event_id: 'ev-b-rel2', released_at: new Date().toISOString() }));
    s = await state();
    assert(s.t2.status === 'removed_error' && s.active.length === 0, `a typo-cancel elsewhere removes it here, got ${JSON.stringify({ t2: s.t2, active: s.active })}`);
    assert(s.notices[0].includes('בוטל כטעות הקלדה') && s.notices[0].includes('כל ההתראות שלו בוטלו'), `the cancel is alerted, got ${JSON.stringify(s.notices)}`);
    // "הבנתי" dismisses each notice; the last one removes the box.
    await page.evaluate(() => { document.querySelectorAll('#tq-remote-notice button').forEach((b) => b.click()); });
    assert(!(await page.$('#tq-remote-notice')), '"הבנתי" dismisses the notices');

    // 7. Phone B (this page) acting on a server tourniquet: the actions are sent.
    const b = await page.evaluate(() => {
      currentUser = { id: 'user-paramedic', role: 'paramedic', email: 'paramedic@example.test' };
      const rows = [
        { id: 'srv-1', patient_id: 'eeeeeeee-0000-4000-8000-0000000000b1', limb: 'right_leg', applied_at: new Date(Date.now() - 30 * 60000).toISOString(), is_active: true, tourniquet_status: 'applied' },
        { id: 'srv-2', patient_id: 'eeeeeeee-0000-4000-8000-0000000000b1', limb: 'left_arm', applied_at: new Date(Date.now() - 10 * 60000).toISOString(), is_active: true, tourniquet_status: 'applied' },
      ];
      const meta = [{ id: 'srv-1', time_source: 'phone', applied_event_id: 'ev-x1' }, { id: 'srv-2', time_source: 'phone', applied_event_id: 'ev-x2' }];
      MARCH_TQ_EVENT_KEYS.set('ev-x1', 'phone-a:local-a-1');
      MARCH_TQ_EVENT_KEYS.set('ev-x2', 'phone-a:local-a-2');
      const p = { id: 'eeeeeeee-0000-4000-8000-0000000000b1', visualId: 'P-B1', triage: 'red', patientStatus: 'observing', siteId: 'SITE_A', sourcedFromRemote: true,
        events: [], vitals: { ...VITALS_NOT_ON_DEVICE }, vitalsHistory: [], tourniquets: serverTourniquetRecords(rows, 'eeeeeeee-0000-4000-8000-0000000000b1', meta) };
      patients.push(p);
      const [s1, s2] = p.tourniquets;
      const n = getOutbox().length;
      queueTourniquetReassessment(p, s1, 'effective');
      convertTourniquetToDirectPressure(p.id, s1.id);
      cancelLastTourniquetEntry(s2.id, p.id);
      const sent = getOutbox().slice(n);
      const rel = sent.filter((e) => e.type === 'TOURNIQUET_RELEASED').map((e) => `${e.payload_json.limb}:${e.payload_json.reason}`);
      const notes = sent.filter((e) => e.type === 'NOTE_ADDED').map((e) => e.payload_json);
      // On a third phone, M follows both notes.
      const c = { id: 'eeeeeeee-0000-4000-8000-0000000000c1', triage: 'red', patientStatus: 'observing', tourniquets: [],
        remoteMarchReviews: [{ at: 1, source: 'phone-a', review: {}, seen: {}, tq: ['tq:phone-a:local-a-1', 'tq:phone-a:local-a-2'], tqCancelled: [], id: 'c0' },
          ...notes.map((pl, i) => ({ at: 2 + i, source: 'phone-b', review: {}, seen: {}, tq: pl.march_tq || [], tqCancelled: pl.march_tq_cancelled || [], id: 'c' + (i + 1) }))] };
      const entries = patientMarchEntries(c).filter((e) => e.review.m === 'treated').map((e) => e.source);
      return { serverLimb: s1.serverLimb, check: sent.some((e) => e.type === 'TOURNIQUET_REASSESSMENT' && e.payload_json.limb === 'right_leg'), rel,
        tqNote: notes.some((pl) => (pl.march_tq || []).includes('tq:phone-a:local-a-1')), cancelNote: notes.some((pl) => (pl.march_tq_cancelled || []).includes('tq:phone-a:local-a-2')), entries };
    });
    assert(b.serverLimb === 'right_leg' && b.check, `a check on another phone's tourniquet is sent, got ${JSON.stringify(b)}`);
    assert(b.rel.includes('right_leg:converted_direct_pressure') && b.rel.includes('left_arm:entry_cancelled'), `conversion and typo-cancel are sent, got ${JSON.stringify(b.rel)}`);
    assert(b.tqNote && b.cancelNote, `march_tq / march_tq_cancelled are sent, got ${JSON.stringify(b)}`);
    assert(b.entries.includes('tq:phone-a:local-a-1') && !b.entries.includes('tq:phone-a:local-a-2'), `M keeps the converted one and drops the cancelled one, got ${JSON.stringify(b.entries)}`);

    assert(pageErrors.length === 0, `uncaught page error(s): ${pageErrors.join(' | ')}`);
    await page.close();
    console.log('index.html: acting on another phone\'s tourniquet browser test passed');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
