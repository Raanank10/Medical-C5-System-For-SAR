// Real-browser test of the PC / CC command panel layout (V2.99.62): a sticky status strip above
// four tap-only tabs (תמונת מצב / פעולה / כוחות / ציוד, right to left), per-tab badges counted in
// patients from the existing alert pipeline (roleAlertRows), every routed alert listed in the strip
// so none is visible only inside a tab, entry always on תמונת מצב while re-renders keep the tab,
// the real server-contact indicator, the blocked-events chip, the חפ״ק button, and the three
// evacuation stages per site (extraction site / evacuation point / evacuated).
// Local demo mode with synthetic patients; signed-in state is stubbed where noted.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_command_panel_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
const PIN = '135790';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext({ viewport: { width: 420, height: 860 } });
  const page = await context.newPage();
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  await page.fill('#pin-gate-setup-new', PIN); await page.fill('#pin-gate-setup-confirm', PIN); await page.click('#pin-gate-setup-btn');
  await page.waitForTimeout(300);

  // Synthetic platoon-A site: a deteriorating red with a 70-minute tourniquet, a trapped red, a
  // yellow with stale vitals, a green waiting at the evacuation point and a red handed over.
  await page.evaluate(() => {
    const now = Date.now();
    const base = { events: [], location: 'בניין 3, קומה 2', patientStatus: 'in_treatment', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', locDetail: 'קומה 2', trapStatus: 'not_trapped' };
    patients.push({ ...base, id: 'cp-r1', visualId: 'P001', triage: 'red', injury: 'קטיעה', vitals: { pulse: 128, spo2: 91, rr: 30, avpu: 'V' }, deterioration: ['דופק גבוה'], alert: true,
      tourniquet: { appliedAt: now - 70 * 60000, limb: 'רגל ימין' }, tourniquets: [{ id: 'TQ1', limb: 'rl', appliedAt: now - 70 * 60000, status: 'active' }], lastVitalsAt: now - 14 * 60000 });
    patients.push({ ...base, id: 'cp-r2', visualId: 'P002', triage: 'red', injury: 'חזה', vitals: { pulse: 118, spo2: 93, rr: 28, avpu: 'A' }, trapStatus: 'trapped', lastVitalsAt: now - 12 * 60000 });
    patients.push({ ...base, id: 'cp-y1', visualId: 'P003', triage: 'yellow', injury: 'אגן', vitals: { pulse: 100, spo2: 96, rr: 20, avpu: 'A' }, lastVitalsAt: now - 25 * 60000 });
    patients.push({ ...base, id: 'cp-g1', visualId: 'P004', triage: 'green', injury: 'חתכים', vitals: { pulse: 84, spo2: 99, rr: 16, avpu: 'A' }, lastVitalsAt: now - 5 * 60000, patientStatus: 'evacuating', evacPointArrivedAt: now - 7 * 60000, locDetail: 'חצר' });
    patients.push({ ...base, id: 'cp-r3', visualId: 'P006', triage: 'red', injury: 'ראש', vitals: { pulse: 110, spo2: 95, rr: 22, avpu: 'A' }, lastVitalsAt: now - 3 * 60000, patientStatus: 'handed_over', evacDestination: 'שיבא' });
    patients.push({ ...base, id: 'cp-b1', visualId: 'P005', triage: 'yellow', injury: 'כוויות', vitals: { pulse: 96, spo2: 97, rr: 18, avpu: 'A' }, siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', lastVitalsAt: now - 8 * 60000 });
    createMedicalResourceRequest({ resourceType: 'paramedic', urgency: 'immediate', siteId: 'SITE_A', targetLocation: 'בניין 3', reasonCodes: ['red_patient'], linkedPatientIds: ['cp-r1'] });
  });

  const state = () => page.evaluate(() => ({
    tabs: [...document.querySelectorAll('[data-cmd-tab]')].map((b) => ({ key: b.dataset.cmdTab, text: b.textContent.trim(), active: b.classList.contains('active'), x: b.getBoundingClientRect().x, isButton: b.tagName === 'BUTTON' })),
    visible: [...document.querySelectorAll('[data-cmd-panel]')].filter((el) => !el.hidden).map((el) => el.dataset.cmdPanel),
  }));

  for (const role of ['pc', 'cc']) {
    // 1. Entering the panel opens תמונת מצב; four tap-only buttons, first tab rightmost (RTL).
    await page.evaluate((r) => { goTo('demo'); startRoleDashboard(r); }, role);
    let s = await state();
    assert(s.tabs.map((t) => t.key).join() === 'overview,action,forces,supply', `${rel} ${role}: tabs must be the four agreed tabs in order (got ${s.tabs.map((t) => t.key)})`);
    assert(s.tabs.every((t) => t.isButton), `${rel} ${role}: tabs must be plain tap buttons`);
    assert(s.tabs[0].x > s.tabs[1].x && s.tabs[1].x > s.tabs[2].x && s.tabs[2].x > s.tabs[3].x, `${rel} ${role}: first tab must be rightmost (RTL)`);
    assert(s.tabs[0].active && s.visible.join() === 'overview', `${rel} ${role}: the panel must open on תמונת מצב (visible ${s.visible})`);

    // 2. Tapping a tab switches it; an automatic re-render keeps it; re-entering resets it.
    await page.click('[data-cmd-tab="action"]');
    await page.evaluate((r) => renderRoleDashboard(r), role);
    s = await state();
    assert(s.visible.join() === 'action' && s.tabs[1].active, `${rel} ${role}: a re-render must keep the tab (visible ${s.visible})`);
    await page.evaluate((r) => { openPatient('cp-r1'); goTo('patient'); goTo('role-dashboard'); }, role);
    s = await state();
    assert(s.visible.join() === 'overview', `${rel} ${role}: coming back to the panel must open תמונת מצב (visible ${s.visible})`);

    // 3. Every routed alert is in the strip (grouped by patient); badges count patients per tab.
    const strip = await page.evaluate((r) => {
      const alerts = roleAlertRows(r);
      const keys = [...new Set(alerts.map((a) => (a.patientId ? `p:${a.patientId}` : `s:${a.id}`)))];
      const collapsed = [...document.querySelectorAll('#command-status-strip [data-alert-group]')].map((el) => el.dataset.alertGroup);
      const moreText = document.querySelector('#command-status-strip .cmd-strip-more')?.textContent || '';
      toggleCommandStrip();
      const expanded = [...document.querySelectorAll('#command-status-strip [data-alert-group]')].map((el) => el.dataset.alertGroup);
      toggleCommandStrip();
      const byTab = { overview: new Set(), action: new Set(), forces: new Set(), supply: new Set() };
      alerts.forEach((a) => {
        const tab = a.type === 'TRAPPED_NO_MEDIC_CONTACT' ? 'forces' : ['MEDIC_RESUPPLY_REQUEST', 'PC_TRUCK_SHORTAGE_ESCALATED'].includes(a.type) ? 'supply' : ['urgent', 'evac', 'forces'].includes(a.category) ? 'action' : 'overview';
        byTab[tab].add(a.patientId ? `p:${a.patientId}` : `s:${a.id}`);
      });
      const badges = Object.fromEntries([...document.querySelectorAll('[data-cmd-tab]')].map((b) => [b.dataset.cmdTab, Number(b.querySelector('.cmd-tab-badge')?.textContent || 0)]));
      return { keys, collapsed, expanded, moreText, expected: Object.fromEntries(Object.entries(byTab).map(([k, v]) => [k, v.size])), badges };
    }, role);
    assert(strip.keys.length >= 2, `${rel} ${role}: the scenario must route several alerts (got ${strip.keys.length})`);
    assert(strip.collapsed.length === 1 && strip.moreText.includes(`+${strip.keys.length - 1}`), `${rel} ${role}: collapsed strip shows the top line and "+N" (got ${strip.collapsed.length}, "${strip.moreText}")`);
    assert(strip.keys.every((k) => strip.expanded.includes(k)) && strip.expanded.length === strip.keys.length, `${rel} ${role}: every alert must be in the expanded strip, one line per patient (missing ${strip.keys.filter((k) => !strip.expanded.includes(k))})`);
    assert(JSON.stringify(strip.badges) === JSON.stringify(strip.expected), `${rel} ${role}: badges must count patients per tab (got ${JSON.stringify(strip.badges)}, expected ${JSON.stringify(strip.expected)})`);
    if (role === 'pc') assert(strip.collapsed[0] === 'p:cp-r1', `${rel}: the most severe patient (critical P001) must lead the strip (got ${strip.collapsed[0]})`);

    // 4. Strip contents: demo connection label, longest tourniquet, triage totals.
    const chips = await page.evaluate(() => ({ conn: document.getElementById('role-strip-conn').textContent, text: document.getElementById('command-status-strip').textContent }));
    assert(chips.conn.includes('מצב דמו'), `${rel} ${role}: demo mode must say it has no server (got "${chips.conn}")`);
    assert(/חסם 70 דק׳ · P001/.test(chips.text), `${rel} ${role}: the longest tourniquet must be in the strip`);

    // 5. The strip and tab bar stay under the header when the page scrolls.
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(100);
    const sticky = await page.evaluate(() => {
      const header = document.querySelector('#screen-role-dashboard .header').getBoundingClientRect();
      const bar = document.querySelector('.cmd-tabs').getBoundingClientRect();
      return { headerBottom: header.bottom, stickyTop: document.getElementById('command-sticky').getBoundingClientRect().top, barBottom: bar.bottom, scrolled: window.scrollY };
    });
    assert(sticky.scrolled > 200 && Math.abs(sticky.stickyTop - sticky.headerBottom) <= 2 && sticky.barBottom < 860, `${rel} ${role}: strip and tabs must stick under the header (${JSON.stringify(sticky)})`);
    await page.evaluate(() => window.scrollTo(0, 0));

    // 6. The full command screen is one tap away on כוחות.
    await page.click('[data-cmd-tab="forces"]');
    await page.click('[data-cmd-panel="forces"] button:has-text("מסך בקרה מלא (חפ״ק)")');
    assert(await page.evaluate(() => document.getElementById('screen-commander').classList.contains('active') && commandRole), `${rel} ${role}: the חפ״ק button must open the command screen`);
  }

  // 7. Three evacuation stages per site on the PC overview, and the PC funnel.
  await page.evaluate(() => { goTo('demo'); startRoleDashboard('pc'); });
  const board = await page.evaluate(() => {
    const panel = document.querySelector('[data-cmd-panel="overview"]');
    const text = panel.textContent;
    const cut = (from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined);
    return {
      summary: text.includes('בזירה 3 · בנקודת פינוי 1 (עד 7 דק׳) · פונו 1'),
      evacPoint: cut('בנקודת פינוי — ממתינים לפינוי מד״א', 'פונו — לפי יעד'),
      evacuated: cut('פונו — לפי יעד', 'משפך פינוי מחלקתי'),
      funnel: text.includes('משפך פינוי מחלקתי') && text.includes('תעדוף פינוי מחלקתי'),
      truck: cut('בנקודת פינוי — ממתינים לפינוי מד״א', 'פונו — לפי יעד').includes('רכב חוג״ד בנקודה'),
      priority: cut('תעדוף פינוי מחלקתי', 'פונו לפני הגעת כוח רפואי'),
    };
  });
  assert(board.summary, `${rel}: the site card must count on scene / at the evacuation point / evacuated separately`);
  assert(board.evacPoint.includes('P004') && !board.evacuated.includes('P004'), `${rel}: a patient at the evacuation point must not be counted as evacuated`);
  assert(board.evacuated.includes('P006') && board.evacuated.includes('שיבא'), `${rel}: a handed-over patient is listed as evacuated with its destination`);
  assert(board.funnel && board.truck, `${rel}: PC overview must show the platoon funnel, evacuation priority and the truck at the evacuation point`);
  // Owner 2026-10-23: patients at the evacuation point still wait for MDA, so they stay on the
  // evacuation-to-hospital list (green P004 too), marked as at the evacuation point; a handed-over
  // patient is not on it.
  assert(/ממתין לפינוי מד״א · P004/.test(board.priority) && board.priority.includes('בנקודת פינוי') && board.priority.includes('P001') && !board.priority.includes('P006'),
    `${rel}: the evacuation priority list must include patients at the evacuation point (got "${board.priority.slice(0, 300)}")`);
  // WP-18: evacuating with no recorded arrival is "on the way"; arrived reads with the wait.
  assert(await page.evaluate(() => STATUS_LABELS.evacuating === 'בדרך לנקודת פינוי' && patientStatusLabel(patients.find(p => p.id === 'cp-g1')) === 'בנקודת פינוי · ממתין 7 דק׳'),
    `${rel}: the evacuating status reads "בדרך לנקודת פינוי" until the arrival, then "בנקודת פינוי" with the wait`);

  // 7b. "בטיפול" in the strip acknowledges the patient and the strip updates at once.
  await page.click('#command-status-strip [data-alert-group="p:cp-r1"] .ack-btn');
  const afterAck = await page.evaluate(() => ({
    critical: roleAlertRows('pc').some((a) => a.type === 'CRITICAL_CLINICAL_ACTION' && a.patientId === 'cp-r1'),
    line: document.querySelector('#command-status-strip [data-alert-group="p:cp-r1"]')?.textContent || '',
    ackedAt: patients.find((p) => p.id === 'cp-r1').alertAcknowledgedAt,
  }));
  assert(afterAck.ackedAt && !afterAck.critical && !afterAck.line.includes('הידרדרות'), `${rel}: acknowledging from the strip must clear the critical alert and refresh the strip (got ${JSON.stringify(afterAck)})`);

  // 8. Signed in (stubbed): real server contact drives the label; blocked events get a chip.
  const signedIn = await page.evaluate(() => {
    currentUser = { id: 'stub-pc', email: 'pc@test', role: 'pc' };
    const now = Date.now();
    const label = (age) => { lastServerContactAt = age === null ? null : now - age; return serverContactLabel(serverContactState(now)); };
    const out = { fresh: label(20000), stale: label(3 * 60000), offline: label(7 * 60000), never: label(null) };
    lastServerContactAt = now;
    _syncIngestionErrors[SITE_TO_INCIDENT_ID.SITE_A] = [{ id: 'err-1' }];
    renderRoleDashboard('pc');
    out.chip = document.querySelector('#command-status-strip .cmd-strip-chip.blocked')?.textContent || '';
    out.conn = document.getElementById('role-strip-conn').className;
    return out;
  });
  assert(signedIn.fresh.includes('מחובר לשרת') && signedIn.stale.includes('עדכון אחרון מהשרת') && signedIn.offline.includes('אין קשר לשרת') && signedIn.never.startsWith('אין קשר לשרת') && !signedIn.never.includes('נתונים'),
    `${rel}: server contact label must follow the last server answer (got ${JSON.stringify(signedIn)})`);
  assert(signedIn.conn.includes('fresh'), `${rel}: a fresh server contact colours the strip chip (got ${signedIn.conn})`);
  assert(signedIn.chip.includes('1 אירועים חסומים'), `${rel}: unresolved blocked events must show in the strip (got "${signedIn.chip}")`);
  await page.click('#command-status-strip .cmd-strip-chip.blocked');
  await page.waitForTimeout(100);
  assert(await page.evaluate(() => document.getElementById('screen-commander').classList.contains('active') && cmdPanelOpen.quarantine), `${rel}: the blocked-events chip must open the command screen's blocked-events panel`);
  await page.evaluate(() => { currentUser = null; });

  // 9. Option A (owner, 2026-10-23): open evacuations are split by where the patient waits. A yellow
  // at the evacuation point is still waiting for MDA, so it counts as not evacuated, in its own part.
  const evac = await page.evaluate(() => {
    patients.push({ events: [], id: 'cp-y2', visualId: 'P007', triage: 'yellow', injury: 'שבר', vitals: { pulse: 98, spo2: 97, rr: 18, avpu: 'A' },
      location: 'חצר', locDetail: 'חצר', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', patientStatus: 'evacuating', evacPointArrivedAt: Date.now() - 3 * 60000, trapStatus: 'not_trapped', lastVitalsAt: Date.now() - 4 * 60000 });
    const split = openEvacuationSplit(patients);
    goTo('demo'); startRoleDashboard('cc');
    const action = document.querySelector('[data-cmd-panel="action"]').textContent;
    const overview = document.querySelector('[data-cmd-panel="overview"]').textContent;
    return { onScene: split.onScene.map((p) => p.visualId).sort(), atPoint: split.atPoint.map((p) => p.visualId), action, overview, queue: DecisionSupportEngine.forCc().operationalPressure.components.evacQueue };
  });
  assert(evac.onScene.join() === 'P001,P002,P003,P005' && evac.atPoint.join() === 'P007', `${rel}: open evacuations split by stage (got ${JSON.stringify({ onScene: evac.onScene, atPoint: evac.atPoint })})`);
  assert(evac.action.includes('5 אדום/צהוב ללא פינוי סגור: 4 באתר החילוץ · 1 ממתינים למד״א'), `${rel}: the CC evacuation bottleneck card must show the split`);
  assert(evac.queue === 5, `${rel}: the pressure gauge's evacuation queue must include patients waiting for MDA (got ${evac.queue})`);
  assert(evac.overview.includes('פינוי לא סגור · באתר החילוץ') && evac.overview.includes('פינוי לא סגור · ממתינים למד״א'), `${rel}: the CC metrics must show both parts`);

  // 10. Owner, 2026-10-24: advice by where patients wait. One yellow at the evacuation point raises no
  // ambulance request yet; the 4 still at the extraction site raise the extraction-site advice.
  const advice = await page.evaluate(() => {
    const text = () => document.querySelector('[data-cmd-panel="action"]').textContent;
    const before = text();
    patients.push({ events: [], id: 'cp-r4', visualId: 'P008', triage: 'red', injury: 'בטן', vitals: { pulse: 120, spo2: 94, rr: 24, avpu: 'A' },
      location: 'חצר', locDetail: 'חצר', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', patientStatus: 'evacuating', evacPointArrivedAt: Date.now() - 2 * 60000, trapStatus: 'not_trapped', lastVitalsAt: Date.now() - 2 * 60000 });
    renderRoleDashboard('cc');
    const after = text();
    const pcRecIds = DecisionSupportEngine.forPc().recommendations.map((r) => r.id);
    const now = Date.now();
    const base = { events: [], location: 'בניין 3', siteId: 'SITE_A', patientStatus: 'in_treatment', triage: 'red', vitals: { pulse: 120, avpu: 'A', rr: 20 } };
    const hints = companyEvacuationPriorityRows([
      { ...base, id: 'h1', visualId: 'H1', trapStatus: 'trapped', tourniquet: { appliedAt: now - 30 * 60000 } },
      { ...base, id: 'h2', visualId: 'H2', trapStatus: 'not_trapped', tourniquet: { appliedAt: now - 20 * 60000 } },
    ]);
    return { before, after, pcRecIds, hints };
  });
  assert(!advice.before.includes('ממתינים לאמבולנס בנקודת פינוי') && advice.before.includes('צוואר בקבוק פינוי באתר החילוץ') && advice.before.includes('אמבולנס הרופא'),
    `${rel}: one yellow waiting raises no ambulance request; the extraction-site advice names medics / the physician's ambulance`);
  assert(advice.after.includes('ממתינים לאמבולנס בנקודת פינוי') && advice.after.includes('בקש אמבולנסים אזרחיים נוספים'), `${rel}: a red waiting at the evacuation point must raise the civilian-ambulance request`);
  assert(advice.pcRecIds.includes('REC_EVAC_WAITING_AMBULANCE'), `${rel}: the PC must get the civilian-ambulance recommendation too (got ${advice.pcRecIds})`);
  assert(advice.hints.includes('טיפול לפני החילוץ') && advice.hints.includes('החילוץ מעביר לנקודת פינוי') && !advice.hints.includes('שייך אמבולנס'),
    `${rel}: extraction-site hints: treat trapped patients before extraction, rescuers carry free ones; never "assign an ambulance"`);

  // 11. CC overview: every open incident's patients by triage colour in one table (owner, 2026-10-25).
  const table = await page.evaluate(async () => {
    const rowsOf = () => [...document.querySelectorAll('[data-cmd-panel="overview"] [data-incident-triage-table] tr')]
      .map((tr) => [...tr.children].map((c) => c.textContent.trim()));
    goTo('demo'); startRoleDashboard('cc');
    const demo = rowsOf();
    const demoExpected = ['SITE_A', 'SITE_B'].map((id) => getSitePatients(id).length);
    // Signed in (stubbed): other incidents come from one patients query; the active one from this phone.
    const fakeClient = { from: (t) => ({ select: () => ({ in: async (_c, ids) => ({ error: null, data: t !== 'patients' ? [] : [
      { incident_id: 'inc-b', current_triage: 'red' }, { incident_id: 'inc-b', current_triage: 'red' },
      { incident_id: 'inc-b', current_triage: 'yellow' }, { incident_id: 'inc-b', current_triage: 'unknown' },
      { incident_id: 'inc-x', current_triage: 'red' },
    ].filter((r) => ids.includes(r.incident_id)) }) }) }) };
    currentUser = { id: 'stub-cc', email: 'cc@test', role: 'cc' };
    _openIncidents = [{ id: 'inc-a', visual_id: 'INC-1', location_name: 'אתר א' }, { id: 'inc-b', visual_id: 'INC-2', location_name: 'אתר ב' }];
    activeIncident = { id: 'inc-a', visual_id: 'INC-1' };
    await pullAllIncidentTriage(fakeClient);
    renderRoleDashboard('cc');
    const live = rowsOf();
    const ownLocal = getSitePatients('SITE_A').length;
    currentUser = null; activeIncident = null; _openIncidents = []; _allIncidentTriage = {};
    return { demo, demoExpected, live, ownLocal };
  });
  const head = table.demo[0];
  assert(head.join('|') === 'אירוע|אדום|צהוב|ירוק|שחור|ממתין|סה״כ', `${rel}: triage table columns (got ${head})`);
  assert(table.demo.length === 4 && Number(table.demo[1][6]) === table.demoExpected[0] && Number(table.demo[2][6]) === table.demoExpected[1]
    && Number(table.demo[3][6]) === table.demoExpected[0] + table.demoExpected[1], `${rel}: demo table has one row per site plus a total (got ${JSON.stringify(table.demo)})`);
  const incB = table.live.find((r) => r[0].startsWith('INC-2'));
  const incA = table.live.find((r) => r[0].startsWith('INC-1'));
  assert(incB && incB.slice(1).join(',') === '2,1,0,0,1,4', `${rel}: another incident's counts come from the server query, unknown as pending (got ${incB})`);
  assert(incA && incA[0].includes('שלי') && Number(incA[6]) === table.ownLocal, `${rel}: the active incident is counted from this phone (got ${incA})`);
  assert(!table.live.some((r) => r[0].startsWith('inc-x')), `${rel}: only open incidents are listed`);

  assert(!errors.length, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: command panel strip + tabs browser test passed`);
}

(async () => {
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  try {
    for (const file of files) await checkFile(browser, file);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
