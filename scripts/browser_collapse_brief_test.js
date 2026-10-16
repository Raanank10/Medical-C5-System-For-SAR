// Real-browser test (V2.99.29): a building collapse can come with any incident type. On the
// Movement screen, choosing a collapse building state adds the crush/trapped brief and
// "+ קריסת מבנה" to the chosen type (explosion here), never twice for the missile type, and the
// rescue chain's progressive-collapse status counts too. Local demo mode (not logged in).
// Manual-only, not wired into CI. Run: npm install && node scripts/browser_collapse_brief_test.js
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html'), path.join(root, 'demo', 'rescue-app.html')];
const PIN = '246810';
function assert(c, m) { if (!c) throw new Error(m); }

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active');
  await page.fill('#pin-gate-setup-new', PIN);
  await page.fill('#pin-gate-setup-confirm', PIN);
  await page.click('#pin-gate-setup-btn');
  await page.waitForSelector('#screen-login.active', { timeout: 10000 });
  await page.evaluate(() => goTo('enroute'));
  await page.waitForSelector('#screen-enroute.active');

  const briefText = () => page.textContent('#incident-type-brief-message');
  const hideBrief = () => page.evaluate(() => hideIncidentTypeBriefModal());

  // Explosion without collapse: no crush brief.
  await page.click('#enroute-incident-type-grid [data-incident-type="explosion"]');
  assert(!(await briefText()).includes('Crush'), `${rel}: explosion alone must not get the collapse brief`);
  assert(!(await page.evaluate(() => incidentTypeLabel(currentSiteId()))).includes('קריסת מבנה'), `${rel}: no collapse label before a collapse is reported`);
  await hideBrief();

  // Partial collapse reported: brief pops with the collapse part, label shows it.
  await page.click('#enroute-type-grid .tap-btn:has-text("קריסה חלקית")');
  await page.waitForSelector('#incident-type-brief-modal:not(.hidden)');
  assert((await page.textContent('#incident-type-brief-title')).includes('+ קריסת מבנה'), `${rel}: brief title must add the collapse`);
  assert((await briefText()).includes('Crush'), `${rel}: explosion + collapse must include the crush/trapped brief`);
  assert((await page.evaluate(() => incidentTypeLabel(currentSiteId()))).includes('פיצוץ + קריסת מבנה'), `${rel}: label must read explosion + collapse`);
  assert((await page.textContent('#enroute-assignment-card')).includes('קריסת מבנה'), `${rel}: Movement screen badge must show the collapse`);
  await hideBrief();

  // Missile type already includes collapse: no duplicate.
  await page.click('#enroute-incident-type-grid [data-incident-type="missile_strike_structural_collapse"]');
  const missileBrief = await briefText();
  assert((missileBrief.match(/Crush/g) || []).length === 1, `${rel}: missile brief must mention crush once, got ${missileBrief}`);
  assert(!(await page.evaluate(() => incidentTypeLabel(currentSiteId()))).includes('+ קריסת מבנה'), `${rel}: missile type must not get "+ collapse"`);
  await hideBrief();

  // Building standing, nobody trapped: collapse removed.
  await page.click('#enroute-incident-type-grid [data-incident-type="mass_shooting"]');
  await hideBrief();
  await page.click('#enroute-type-grid .tap-btn:has-text("לא ידוע")');
  assert(!(await page.evaluate(() => incidentTypeLabel(currentSiteId()))).includes('קריסת מבנה'), `${rel}: "unknown" building must clear the collapse`);

  // Rescue chain's progressive-collapse status counts as a collapse too.
  await page.evaluate(() => { ensureSiteStatusFields(currentSiteId()).buildingStatus = 'progressive_collapse'; });
  assert((await page.evaluate(() => incidentTypeLabel(currentSiteId()))).includes('ירי המוני + קריסת מבנה'), `${rel}: progressive collapse must add the collapse label`);

  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: collapse brief browser test passed`);
}

(async () => {
  const pre = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pre) ? { executablePath: pre } : {});
  try { for (const f of files) await checkFile(browser, f); } finally { await browser.close(); }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
