// Real-browser test of the command hierarchy on the command screen and role dashboards (V2.99.33):
// מ״פ רפואה (cc) sees every site; חוג״ד (pc), the medical commander of a rescue company, sees every
// site of its own company and no other (docs/ROLE_COMMAND_MODEL_v2.8.md "Companies and platoons",
// owner 2026-11-28; the server has the same rule in app.can_access_incident since database/053).
// Local demo mode, which has two sites (SITE_A = PLT-A, SITE_B = PLT-B), both platoons of the
// PC's company COMP-1; the test then moves PLT-B to another company and checks the PC loses it.
// Signed in there is only the active incident, so nothing narrows further there.
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_command_scope_test.js
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
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  // No backend in this test: serve an empty supabase-js instead of waiting on the CDN, which
  // otherwise holds DOMContentLoaded (a slow jsDelivr response timed page.goto out in CI).
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  await page.fill('#pin-gate-setup-new', PIN); await page.fill('#pin-gate-setup-confirm', PIN); await page.click('#pin-gate-setup-btn');
  await page.waitForTimeout(300);

  // One patient and one reinforcement request per platoon site.
  await page.evaluate(() => {
    const base = { vitals: { pulse: 90, spo2: 98, rr: 16, avpu: 'A' }, events: [], injury: 'בדיקה', location: 'מוקד', patientStatus: 'identified' };
    patients.push({ ...base, id: 'scope-a', visualId: 'PA1', triage: 'red', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', locDetail: 'קומה 1' });
    patients.push({ ...base, id: 'scope-b', visualId: 'PB1', triage: 'yellow', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', locDetail: 'חניון' });
    createMedicalResourceRequest({ resourceType: 'doctor', siteId: 'SITE_A', targetLocation: 'A' });
    createMedicalResourceRequest({ resourceType: 'doctor', siteId: 'SITE_B', targetLocation: 'B' });
  });

  const view = (role) => page.evaluate((r) => {
    switchCommandRole(r); goTo('commander'); renderCommander();
    const tabs = [...document.querySelectorAll('#cmd-site-tabs .cmd-site-tab')].map((b) => b.textContent.trim());
    const board = document.getElementById('cmd-location-board').textContent;
    const reinf = document.getElementById('cmd-panel-reinforcement-meta').textContent;
    const header = document.getElementById('cmd-header-label').textContent;
    const active = cmdActiveSite;
    const triedB = (switchCmdSite('SITE_B'), cmdActiveSite);
    const boardAfterB = document.getElementById('cmd-location-board').textContent;
    return { tabs, board, reinf, header, active, triedB, boardAfterB };
  }, role);

  // CC: every site, including "all sites", starting on all sites.
  const cc = await view('cc');
  assert(cc.tabs.length === 3 && cc.tabs[0].includes('הכל'), `${rel}: CC must see the all-sites tab plus both sites (got ${JSON.stringify(cc.tabs)})`);
  assert(cc.board.includes('PA1') && cc.board.includes('PB1'), `${rel}: CC board must show both platoons' sites`);
  assert(cc.reinf.includes('מתוך 2'), `${rel}: CC must see both platoons' reinforcement requests (got ${cc.reinf})`);
  assert(cc.header.includes('מ״פ רפואה'), `${rel}: CC header must name the role (got ${cc.header})`);
  assert(cc.triedB === 'SITE_B', `${rel}: CC may switch to any site`);

  // PC: every site of its company (both demo platoons are COMP-1), no "all sites" tab.
  const pc = await view('pc');
  assert(pc.tabs.length === 2 && !pc.tabs.some((t) => t.includes('הכל')), `${rel}: PC must see both company sites and no all-sites tab (got ${JSON.stringify(pc.tabs)})`);
  assert(pc.active === 'SITE_A' && pc.triedB === 'SITE_B', `${rel}: PC starts on its home site and may switch to the company's other site (active ${pc.active}, after switch ${pc.triedB})`);
  assert(pc.board.includes('PA1') && !pc.board.includes('PB1') && pc.boardAfterB.includes('PB1'), `${rel}: PC command board shows the active company site, and the other one after switching`);
  assert(pc.reinf.includes('מתוך 2'), `${rel}: PC must see the company's reinforcement requests (got ${pc.reinf})`);
  assert(pc.header.includes('חוג״ד') && pc.header.includes('מחלקה רפואית א'), `${rel}: PC header must name the site's platoon (got ${pc.header})`);

  // Role dashboards follow the same hierarchy.
  const dash = async (role) => page.evaluate((r) => { startRoleDashboard(r); return document.getElementById('role-dashboard-body').textContent; }, role);
  const ccDash = await dash('cc');
  const pcDash = await dash('pc');
  assert(ccDash.includes('PA1') && ccDash.includes('PB1'), `${rel}: CC dashboard board must show both sites`);
  const pcBoard = pcDash.slice(pcDash.indexOf('לוח נפגעים לפי מיקום'));
  assert(pcBoard.includes('PA1') && pcBoard.includes('PB1'), `${rel}: PC dashboard board must show both company sites`);
  const pcRecs = await page.evaluate(() => JSON.stringify(DecisionSupportEngine.forPc().recommendations));
  assert(pcRecs.includes('scope-a') || pcRecs.includes('PA1'), `${rel}: PC recommendations must cover its company's red patient`);

  // Move PLT-B (and so SITE_B) to another company: the PC loses it, the CC keeps it.
  await page.evaluate(() => { DEMO_PLATOONS.find((pl) => pl.platoonId === 'PLT-B').companyId = 'COMP-2'; });
  const pcOther = await view('pc');
  assert(pcOther.tabs.length === 1 && pcOther.active === 'SITE_A' && pcOther.triedB === 'SITE_A', `${rel}: PC must not reach another company's site (tabs ${JSON.stringify(pcOther.tabs)}, after switch ${pcOther.triedB})`);
  assert(pcOther.board.includes('PA1') && !pcOther.boardAfterB.includes('PB1'), `${rel}: PC board must not show another company's site`);
  assert(pcOther.reinf.includes('מתוך 1'), `${rel}: PC must not see another company's reinforcement requests (got ${pcOther.reinf})`);
  const pcOtherDash = await dash('pc');
  assert(!pcOtherDash.slice(pcOtherDash.indexOf('לוח נפגעים לפי מיקום')).includes('PB1'), `${rel}: PC dashboard must not show another company's site`);
  const pcOtherRecs = await page.evaluate(() => JSON.stringify(DecisionSupportEngine.forPc().recommendations));
  assert(!pcOtherRecs.includes('scope-b') && !pcOtherRecs.includes('PB1'), `${rel}: PC recommendations must stay inside its company`);
  const ccOther = await view('cc');
  assert(ccOther.board.includes('PB1') && ccOther.triedB === 'SITE_B', `${rel}: CC still sees every site`);

  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: command scope (CC every site, PC own company) browser test passed`);
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
