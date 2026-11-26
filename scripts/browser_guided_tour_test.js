// Real-browser test of the PC / CC guided tour (WP-43, owner 2026-11-26).
// The tour is driven through the real UI: tap the start button, read the card, tap "הבא" until it
// closes. Every card must point at a panel the user can actually see: highlighted, not inside a
// hidden command-panel tab, inside the free part of the screen (below the sticky strip, above the
// tour card) and showing data rather than only an empty state. The number of cards must equal the
// number of steps for the role, so a step the engine skips fails the test instead of vanishing.
// The tour runs in the sandbox (sample patients, no server reads or writes) and must leave the
// phone exactly as it was. Signed in, it starts only outside an incident: PC from the incident
// picker, CC from the all-incidents view; inside an open incident it is refused, and on exit the
// phone syncs at once.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_guided_tour_test.js
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
const PIN = '135790';
const failures = [];

function check(condition, message) {
  if (!condition) failures.push(message);
}

async function newPage(browser, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  // No real supabase-js: getSupabaseClient() stays null unless a test stubs window.supabase.
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  await page.fill('#pin-gate-setup-new', PIN);
  await page.fill('#pin-gate-setup-confirm', PIN);
  await page.click('#pin-gate-setup-btn');
  await page.waitForTimeout(300);
  return { page, errors, context };
}

// A real patient already on the phone before the tour: it must be back, unchanged, afterwards.
async function seedRealPatient(page) {
  await page.evaluate(() => {
    patients.push({ id: 'real-1', visualId: 'P900', triage: 'yellow', injury: 'אמה', events: [], siteId: 'SITE_A', assignedPlatoonId: 'PLT-A',
      patientStatus: 'in_treatment', trapStatus: 'not_trapped', vitals: { pulse: 96, spo2: 97, rr: 18, avpu: 'A' }, lastVitalsAt: Date.now() - 4 * 60000 });
  });
}

const snapshot = (page) => page.evaluate(() => JSON.stringify({
  screen: activeScreenId(),
  role: activeRoleDashboard,
  tab: typeof commandPanelTab === 'undefined' ? null : commandPanelTab,
  patients: patients.map((p) => [p.id, p.triage, p.patientStatus]),
  requests: (reinforcementRequests || []).length,
  outbox: getOutbox().length,
  localEvents: (state.localEvents || []).length,
}));

// Walk the open tour card by card. Returns one record per card shown.
async function walkTour(page, label) {
  const cards = [];
  for (let guard = 0; guard < 40; guard++) {
    await page.waitForTimeout(700); // smooth scroll + re-render
    const open = await page.evaluate(() => getComputedStyle(document.getElementById('guided-tour-card')).display !== 'none');
    if (!open) break;
    const c = await page.evaluate(() => {
      const card = document.getElementById('guided-tour-card');
      const el = document.querySelector('.tour-highlight');
      const sticky = document.querySelector('#screen-role-dashboard.active #command-sticky');
      const top = sticky ? Math.max(0, sticky.getBoundingClientRect().bottom) : 0;
      const bottom = card.getBoundingClientRect().top;
      const out = { title: document.getElementById('guided-tour-title').textContent, count: document.getElementById('guided-tour-count').textContent, found: !!el };
      if (el) {
        const r = el.getBoundingClientRect();
        out.hidden = !!el.closest('[hidden]');
        out.visible = !out.hidden && r.height > 0 && el.checkVisibility();
        out.shown = Math.max(0, Math.min(r.bottom, bottom) - Math.max(r.top, top));
        out.need = Math.min(r.height, 120);
        const text = el.innerText.replace(/\s+/g, ' ').trim();
        // Empty: a collapsible section whose own count is 0 ("<title> · 0"), or a section whose body
        // is nothing but one "אין ..." line (renderOperationalEmptyState / roleRow's empty row).
        const titleEl = el.querySelector('.role-section-title');
        const countText = titleEl?.querySelector('span')?.textContent.trim() || '';
        const bodyText = titleEl ? text.slice(titleEl.innerText.replace(/\s+/g, ' ').trim().length).trim() : text;
        out.onlyEmpty = /·\s*0$/.test(countText) || (/^אין /.test(bodyText) && bodyText.length < 60);
        out.text = text.slice(0, 80);
      }
      return out;
    });
    cards.push(c);
    check(c.found, `${label} "${c.title}": no highlighted target`);
    if (c.found) {
      check(c.visible, `${label} "${c.title}": target is not visible${c.hidden ? ' (inside a hidden tab)' : ''}`);
      check(c.shown >= c.need, `${label} "${c.title}": only ${Math.round(c.shown)}px of the target is in the free part of the screen (need ${c.need})`);
      check(!c.onlyEmpty, `${label} "${c.title}": the panel shows no data ("${c.text}")`);
    }
    await page.click('#guided-tour-next');
  }
  return cards;
}

(async () => {
  const preinstalled = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {});
  try {
    for (const viewport of [{ width: 375, height: 812 }, { width: 412, height: 915 }]) {
      const vp = `${viewport.width}x${viewport.height}`;

      // 1. Local demo: the tour from screen-demo covers PC and CC, every card on a visible panel.
      {
        const { page, errors, context } = await newPage(browser, viewport);
        await seedRealPatient(page);
        await page.evaluate(() => goTo('demo'));
        const before = await snapshot(page);
        const expected = await page.evaluate(() => GUIDED_TOUR_STEPS.length);
        await page.click('#screen-demo button[onclick="startGuidedTour()"]');
        const cards = await walkTour(page, `${vp} demo`);
        check(cards.length === expected, `${vp} demo: ${cards.length} cards shown for ${expected} steps (a step was skipped or the tour never closed)`);
        check(await page.evaluate(() => _guidedTour === null && !inDemoSandbox()), `${vp} demo: the tour and its sandbox must be closed after the last step`);
        const after = await snapshot(page);
        check(after === before, `${vp} demo: the phone must be exactly as before the tour\n  before ${before}\n  after  ${after}`);
        // Leaving early with "יציאה" restores the phone the same way.
        await page.click('#screen-demo button[onclick="startGuidedTour()"]');
        await page.waitForTimeout(700);
        await page.click('#guided-tour-next');
        await page.waitForTimeout(700);
        await page.click('#guided-tour-card button[onclick="endGuidedTour()"]');
        await page.waitForTimeout(300);
        const early = await snapshot(page);
        check(early === before && await page.evaluate(() => _guidedTour === null && !inDemoSandbox()), `${vp} demo: "יציאה" at card 2 must restore the phone\n  before ${before}\n  after  ${early}`);
        check(!errors.length, `${vp} demo: page errors ${errors.join(' | ')}`);
        await context.close();
      }

      // 2. Signed-in PC on the incident picker: a tour button there; no server traffic while it runs;
      //    back on the picker afterwards with an immediate sync.
      {
        const { page, errors, context } = await newPage(browser, viewport);
        await seedRealPatient(page);
        await page.evaluate(() => {
          currentUser = { id: 'stub-pc', email: 'pc@test', role: 'pc' };
          activeIncident = null; _openIncidents = []; _openIncidentsAt = Date.now();
          window.__calls = { push: 0, alerts: 0, client: 0 };
          const origClient = getSupabaseClient;
          window.getSupabaseClient = () => { if (!inDemoSandbox()) window.__calls.client++; else window.__calls.sandboxClient = (window.__calls.sandboxClient || 0) + 1; return origClient(); };
          const origPush = syncPush; window.syncPush = (...a) => { window.__calls.push++; return origPush(...a); };
          const origAlerts = pollIncidentOpenAlerts; window.pollIncidentOpenAlerts = (...a) => { window.__calls.alerts++; return origAlerts(...a); };
          // An unsent event from an earlier incident: the tour must not touch it.
          getOutbox().push({ local_event_id: 'real-ev-1', type: 'NOTE_ADDED', patient_id: null, synced: false });
          openIncidentPicker();
        });
        const stored = () => page.evaluate(() => JSON.stringify({
          outbox: getOutbox().map((e) => e.local_event_id),
          keys: [OUTBOX_KEY, CONFLICT_LOG_KEY, MEDIC_BAG_KEY].map((k) => localStorage.getItem(k)),
          user: currentUser && [currentUser.id, currentUser.role],
        }));
        const storedBefore = await stored();
        const btn = await page.$('#screen-incident-picker [data-guided-tour-start]');
        check(!!btn && await btn.isVisible(), `${vp} signed-in PC: the incident picker must offer the tour ([data-guided-tour-start])`);
        if (btn) {
          const before = await snapshot(page);
          const expected = await page.evaluate(() => GUIDED_TOUR_STEPS.filter((s) => s.role === 'pc').length);
          await btn.click();
          const during = await page.evaluate(() => ({ sandbox: inDemoSandbox(), banner: document.getElementById('guided-tour-text')?.closest('#guided-tour-card')?.innerText || '' }));
          check(during.sandbox, `${vp} signed-in PC: the tour must run in the sandbox`);
          check(/נתוני הדגמה/.test(during.banner), `${vp} signed-in PC: the tour card must say the data is sample data ("נתוני הדגמה")`);
          // While it runs: no way out to the demo home, and the demo clear buttons are refused.
          const blocked = await page.evaluate(() => {
            goHome(); const afterHome = activeScreenId();
            clearDemoPatientsOnly({ confirmReset: false });
            return { afterHome, tour: !!_guidedTour, outbox: getOutbox().length };
          });
          check(blocked.afterHome === 'role-dashboard' && blocked.tour, `${vp} signed-in PC: "ראשי" during the tour must be refused (got ${JSON.stringify(blocked)})`);
          const pushBefore = await page.evaluate(() => window.__calls.push);
          const cards = await walkTour(page, `${vp} signed-in PC`);
          check(cards.length === expected, `${vp} signed-in PC: ${cards.length} cards for ${expected} PC steps (the picker tour is the PC's own steps only)`);
          const after = await page.evaluate(() => ({ screen: activeScreenId(), sandbox: inDemoSandbox(), push: window.__calls.push, alerts: window.__calls.alerts }));
          check(after.screen === 'incident-picker' && !after.sandbox, `${vp} signed-in PC: back on the incident picker, sandbox closed (got ${JSON.stringify(after)})`);
          check(after.push > pushBefore && after.alerts > 0, `${vp} signed-in PC: exiting must sync at once (push ${pushBefore} -> ${after.push}, open-incident alerts polled ${after.alerts})`);
          const restored = await snapshot(page);
          check(JSON.parse(restored).patients.join() === JSON.parse(before).patients.join(), `${vp} signed-in PC: real patients must be back unchanged`);
          const storedAfter = await stored();
          check(storedAfter === storedBefore, `${vp} signed-in PC: the real outbox, conflict log, bags and signed-in user must be unchanged\n  before ${storedBefore}\n  after  ${storedAfter}`);
          // The exit re-saves the phone's state (encrypted): it must be the real patients, never the sample ones.
          await page.waitForTimeout(500);
          const saved = await page.evaluate(async () => { const raw = await secureGetItem(DEMO_STORAGE_KEY); return raw ? JSON.parse(raw).patients.map((p) => p.id) : null; });
          check(saved && saved.includes('real-1') && !saved.some((id) => id.startsWith('tour-')), `${vp} signed-in PC: stored state after the tour must hold the real patients only (got ${JSON.stringify(saved)})`);
        }
        check(!errors.length, `${vp} signed-in PC: page errors ${errors.join(' | ')}`);
        await context.close();
      }

      // 3. Signed-in PC inside an open incident: no tour button on the panel, and starting it is refused.
      {
        const { page, errors, context } = await newPage(browser, viewport);
        await seedRealPatient(page);
        await page.evaluate(() => {
          currentUser = { id: 'stub-pc', email: 'pc@test', role: 'pc' };
          activeIncident = { id: '00000000-0000-4000-8000-000000000001', visual_id: 'INC-1', status: 'official' };
          startRoleDashboard('pc');
        });
        const onPanel = await page.$('#screen-role-dashboard.active [data-guided-tour-start]');
        check(!onPanel || !(await onPanel.isVisible()), `${vp} PC inside an incident: the panel must not offer the tour`);
        const refused = await page.evaluate(() => { startGuidedTour(); return { tour: !!_guidedTour, sandbox: inDemoSandbox(), screen: activeScreenId() }; });
        check(!refused.tour && !refused.sandbox && refused.screen === 'role-dashboard', `${vp} PC inside an incident: startGuidedTour() must be refused (got ${JSON.stringify(refused)})`);
        check(!errors.length, `${vp} PC inside an incident: page errors ${errors.join(' | ')}`);
        await context.close();
      }

      // 3a. The rule is "the server said within 2 minutes that no incident is open" (owner 2026-11-26):
      //     a list the phone never got from the server, or any open incident, refuses the tour.
      for (const [name, setup] of [
        ['stale list', () => { _openIncidents = []; _openIncidentsAt = 0; }],
        ['list 3 minutes old', () => { _openIncidents = []; _openIncidentsAt = Date.now() - 3 * 60000; }],
        ['an open incident elsewhere', () => { _openIncidents = [{ id: '00000000-0000-4000-8000-000000000009', visual_id: 'INC-9', status: 'official' }]; _openIncidentsAt = Date.now(); }],
      ]) {
        const { page, errors, context } = await newPage(browser, viewport);
        await page.evaluate((src) => {
          currentUser = { id: 'stub-pc', email: 'pc@test', role: 'pc' }; activeIncident = null;
          (new Function(src))();
          renderIncidentPicker(); goTo('incident-picker');
        }, `(${setup.toString()})()`);
        const btn = await page.$('#screen-incident-picker [data-guided-tour-start]');
        check(!btn || !(await btn.isVisible()), `${vp} ${name}: the picker must not offer the tour`);
        const r = await page.evaluate(() => { startGuidedTour(); return { tour: !!_guidedTour, sandbox: inDemoSandbox() }; });
        check(!r.tour && !r.sandbox, `${vp} ${name}: startGuidedTour() must be refused (got ${JSON.stringify(r)})`);
        check(!errors.length, `${vp} ${name}: page errors ${errors.join(' | ')}`);
        await context.close();
      }

      // 3e. The screen locks or the app goes to the background: the tour ends at once.
      {
        const { page, errors, context } = await newPage(browser, viewport);
        await page.evaluate(() => { currentUser = { id: 'stub-pc', email: 'pc@test', role: 'pc' }; activeIncident = null; _openIncidents = []; _openIncidentsAt = Date.now(); openIncidentPicker(); startGuidedTour(); });
        await page.waitForTimeout(400);
        const open = await page.evaluate(() => !!_guidedTour);
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => ({ tour: !!_guidedTour, sandbox: inDemoSandbox(), user: currentUser && currentUser.id, screen: activeScreenId() }));
        check(open && !after.tour && !after.sandbox && after.user === 'stub-pc' && after.screen === 'incident-picker', `${vp} screen locked: the tour must end, signed in, back on the picker (got ${JSON.stringify(after)})`);
        check(!errors.length, `${vp} screen locked: page errors ${errors.join(' | ')}`);
        await context.close();
      }

      // 3b. Signing out mid-tour (by hand, or the automatic sign-out of a deactivated account) ends
      //     the tour and really signs out: the user does not come back when the card is gone.
      {
        const { page, errors, context } = await newPage(browser, viewport);
        await page.evaluate(() => { currentUser = { id: 'stub-pc', email: 'pc@test', role: 'pc' }; activeIncident = null; _openIncidents = []; _openIncidentsAt = Date.now(); openIncidentPicker(); startGuidedTour(); });
        await page.waitForTimeout(500);
        await page.evaluate(() => signOut());
        await page.waitForTimeout(500);
        const out = await page.evaluate(() => ({ user: currentUser, tour: !!_guidedTour, sandbox: inDemoSandbox(), card: getComputedStyle(document.getElementById('guided-tour-card')).display }));
        check(out.user === null && !out.tour && !out.sandbox && out.card === 'none', `${vp} sign-out mid-tour: must end the tour and stay signed out (got ${JSON.stringify(out)})`);
        check(!errors.length, `${vp} sign-out mid-tour: page errors ${errors.join(' | ')}`);
        await context.close();
      }

      // 3c. An active tourniquet on the phone: the tour is refused (its alarms would be held back).
      {
        const { page, errors, context } = await newPage(browser, viewport);
        await page.evaluate(() => {
          patients.push({ id: 'real-tq', visualId: 'P901', triage: 'red', events: [], siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', patientStatus: 'in_treatment',
            tourniquet: { appliedAt: Date.now() - 50 * 60000, limb: 'יד שמאל' }, tourniquets: [{ id: 'TQ-R1', limb: 'la', appliedAt: Date.now() - 50 * 60000, status: 'active' }] });
          goTo('demo');
        });
        const r = await page.evaluate(() => { startGuidedTour(); return { tour: !!_guidedTour, sandbox: inDemoSandbox(), patients: patients.map((p) => p.id) }; });
        check(!r.tour && !r.sandbox && r.patients.join() === 'real-tq', `${vp} active tourniquet: the tour must be refused (got ${JSON.stringify(r)})`);
        check(!errors.length, `${vp} active tourniquet: page errors ${errors.join(' | ')}`);
        await context.close();
      }

      // 3d. Left open, the tour ends by itself after 3 minutes (owner 2026-11-26) and the phone syncs.
      {
        const { page, errors, context } = await newPage(browser, viewport);
        await page.clock.install();
        await page.evaluate(() => {
          currentUser = { id: 'stub-pc', email: 'pc@test', role: 'pc' }; activeIncident = null; _openIncidents = []; _openIncidentsAt = Date.now();
          window.__push = 0; const origPush = syncPush; window.syncPush = (...a) => { window.__push++; return origPush(...a); };
          openIncidentPicker(); startGuidedTour();
        });
        await page.clock.fastForward(2 * 60 * 1000 + 50 * 1000);
        const before = await page.evaluate(() => !!_guidedTour);
        await page.clock.fastForward(20 * 1000);
        const after = await page.evaluate(() => ({ tour: !!_guidedTour, sandbox: inDemoSandbox(), screen: activeScreenId(), user: currentUser && currentUser.id, push: window.__push }));
        check(before, `${vp} time limit: the tour must still be open at 2:50`);
        check(!after.tour && !after.sandbox && after.screen === 'incident-picker' && after.user === 'stub-pc' && after.push > 0,
          `${vp} time limit: after 3 minutes the tour must end, back on the picker, signed in, synced (got ${JSON.stringify(after)})`);
        check(!errors.length, `${vp} time limit: page errors ${errors.join(' | ')}`);
        await context.close();
      }

      // 4b. Signed-in CC while the all-incidents strip shows an alert line: no button, refused.
      {
        const { page, errors, context } = await newPage(browser, viewport);
        await page.evaluate(() => {
          currentUser = { id: 'stub-cc', email: 'cc@test', role: 'cc' };
          activeIncident = null; _openIncidents = []; _openIncidentsAt = Date.now(); _openIncidents = []; _allIncidentTriage = {};
          window.ccOverviewIncidentAlerts = () => [{ inc: { id: 'inc-x', visual_id: 'INC-9' }, groups: [{ rank: 0, alerts: [{ title: 'פצוע אדום' }] }] }];
          enterCcAllIncidentsView();
        });
        await page.waitForTimeout(300);
        const btn = await page.$('#screen-role-dashboard.active [data-guided-tour-start]');
        check(!btn || !(await btn.isVisible()), `${vp} CC with an open alert: the all-incidents view must not offer the tour`);
        const r = await page.evaluate(() => { startGuidedTour(); return { tour: !!_guidedTour, sandbox: inDemoSandbox() }; });
        check(!r.tour && !r.sandbox, `${vp} CC with an open alert: startGuidedTour() must be refused (got ${JSON.stringify(r)})`);
        check(!errors.length, `${vp} CC with an open alert: page errors ${errors.join(' | ')}`);
        await context.close();
      }

      // 4. Signed-in CC in the all-incidents view: a tour button there, CC steps on visible panels.
      {
        const { page, errors, context } = await newPage(browser, viewport);
        await page.evaluate(() => {
          currentUser = { id: 'stub-cc', email: 'cc@test', role: 'cc' };
          activeIncident = null; _openIncidents = []; _openIncidentsAt = Date.now(); _openIncidents = []; _allIncidentTriage = {};
          enterCcAllIncidentsView();
        });
        await page.waitForTimeout(300);
        const btn = await page.$('#screen-role-dashboard.active [data-guided-tour-start]');
        check(!!btn && await btn.isVisible(), `${vp} signed-in CC: the all-incidents view must offer the tour ([data-guided-tour-start])`);
        if (btn) {
          const expected = await page.evaluate(() => GUIDED_TOUR_STEPS.filter((s) => s.role === 'cc').length);
          await btn.click();
          const cards = await walkTour(page, `${vp} signed-in CC`);
          check(cards.length === expected, `${vp} signed-in CC: ${cards.length} cards for ${expected} CC steps`);
          const after = await page.evaluate(() => ({ screen: activeScreenId(), overview: isCcOverviewMode(), sandbox: inDemoSandbox() }));
          check(after.screen === 'role-dashboard' && after.overview && !after.sandbox, `${vp} signed-in CC: back on the all-incidents view (got ${JSON.stringify(after)})`);
        }
        check(!errors.length, `${vp} signed-in CC: page errors ${errors.join(' | ')}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (failures.length) {
    console.error(`browser_guided_tour_test: ${failures.length} failure(s)\n- ` + failures.join('\n- '));
    process.exit(1);
  }
  console.log('browser_guided_tour_test: the PC / CC guided tour passed (local demo, signed-in PC picker, refusal inside an incident / with an open incident elsewhere / with a stale incident list / with an active tourniquet / for a CC with open alerts, ends on screen lock, sign-out mid-tour, 3-minute limit, signed-in CC all-incidents view; 375x812 and 412x915)');
})();
