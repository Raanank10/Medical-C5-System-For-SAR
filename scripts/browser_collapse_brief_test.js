// Real-browser test (V2.99.29): a building collapse can come with any incident type. On the
// Movement screen, choosing a collapse building state adds the crush/trapped brief and
// "+ קריסת מבנה" to the chosen type (explosion here), never twice for the missile type, and the
// rescue chain's progressive-collapse status counts too. Local demo mode (not logged in).
// V2.99.57: the building section opens by itself only for a missile strike; other types ask
// "מבנה נפגע / לכודים במבנה?" first ("yes" opens it, "no" clears the collapse) and get their own
// optional questions (shooting, road accident, explosion) with safety warnings.
// Runs in CI through scripts/run_tests.js (WP-13). Run: npm install && node scripts/browser_collapse_brief_test.js
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];
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

  const visible = (sel) => page.isVisible(sel);

  // Explosion without collapse: no crush brief.
  await page.click('#enroute-incident-type-grid [data-incident-type="explosion"]');
  assert(!(await briefText()).includes('Crush'), `${rel}: explosion alone must not get the collapse brief`);
  assert(!(await page.evaluate(() => incidentTypeLabel(currentSiteId()))).includes('קריסת מבנה'), `${rel}: no collapse label before a collapse is reported`);
  await hideBrief();

  // Explosion: building section closed behind the question, explosion questions shown.
  assert(!(await visible('#enroute-building-section')), `${rel}: building section must be hidden for explosion until "yes"`);
  assert(await visible('#enroute-building-ask'), `${rel}: explosion must ask whether a building is involved`);
  assert(await visible('#enroute-incident-details [data-incident-detail="hazmat"]'), `${rel}: explosion must ask about hazmat`);
  await page.click('#enroute-incident-details [data-incident-detail="setting"] [data-detail-value="enclosed"]');
  assert((await page.textContent('#enroute-incident-details')).includes('חבלת פיצוץ ראשונית'), `${rel}: enclosed explosion must warn about primary blast injury`);
  await page.click('#enroute-building-ask-grid [data-building-involved="yes"]');
  assert(await visible('#enroute-building-section'), `${rel}: "yes" must open the building section`);

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
  assert(!(await visible('#enroute-building-ask')), `${rel}: missile must not ask, the building section is always open`);
  assert(await visible('#enroute-building-section'), `${rel}: missile must show the building section`);
  assert((await page.textContent('#enroute-incident-details')).trim() === '', `${rel}: missile has no extra type questions`);
  const missileBrief = await briefText();
  assert((missileBrief.match(/Crush/g) || []).length === 1, `${rel}: missile brief must mention crush once, got ${missileBrief}`);
  assert(!(await page.evaluate(() => incidentTypeLabel(currentSiteId()))).includes('+ קריסת מבנה'), `${rel}: missile type must not get "+ collapse"`);
  await hideBrief();

  // Building standing, nobody trapped: collapse removed.
  await page.click('#enroute-incident-type-grid [data-incident-type="mass_shooting"]');
  await hideBrief();
  assert(await visible('#enroute-building-section'), `${rel}: a reported collapse keeps the building section open after a type change`);
  await page.click('#enroute-type-grid .tap-btn:has-text("לא ידוע")');
  assert(!(await page.evaluate(() => incidentTypeLabel(currentSiteId()))).includes('קריסת מבנה'), `${rel}: "unknown" building must clear the collapse`);

  // Shooting questions: active shooter warns; a second tap clears the pick.
  const shooter = '#enroute-incident-details [data-incident-detail="shooterStatus"] [data-detail-value="active"]';
  await page.click(shooter);
  assert((await page.textContent('#enroute-incident-details')).includes('ירי פעיל: אין כניסה'), `${rel}: active shooter must show the safety warning`);
  await page.click(shooter);
  assert(!(await page.textContent('#enroute-incident-details')).includes('ירי פעיל: אין כניסה'), `${rel}: second tap must clear the pick`);

  // "No" closes the section and clears a collapse the medic reported.
  await page.click('#enroute-type-grid .tap-btn:has-text("קריסה מלאה")');
  await hideBrief();
  assert((await page.evaluate(() => incidentTypeLabel(currentSiteId()))).includes('ירי המוני + קריסת מבנה'), `${rel}: full collapse must add the collapse label`);
  await page.click('#enroute-building-ask-grid [data-building-involved="no"]');
  assert(!(await visible('#enroute-building-section')), `${rel}: "no" must close the building section`);
  assert(!(await page.evaluate(() => incidentTypeLabel(currentSiteId()))).includes('קריסת מבנה'), `${rel}: "no" must clear the collapse`);

  // Road accident questions, per type: the shooting answers are not mixed in.
  await page.click('#enroute-incident-type-grid [data-incident-type="vehicle_accident"]');
  await hideBrief();
  assert(!(await visible('#enroute-building-section')), `${rel}: road accident after "no" keeps the building section closed`);
  await page.click('#enroute-incident-details [data-incident-detail="vehicleKinds"] [data-detail-value="bus"]');
  await page.click('#enroute-incident-details [data-incident-detail="vehicleKinds"] [data-detail-value="pedestrian"]');
  await page.click('#enroute-incident-details [data-incident-detail="trappedInVehicle"] [data-detail-value="yes"]');
  const details = await page.evaluate(() => siteData.incidentDetails);
  assert(JSON.stringify(details.vehicle_accident.vehicleKinds) === '["bus","pedestrian"]', `${rel}: vehicle kinds multi-select, got ${JSON.stringify(details)}`);
  assert(!('shooterStatus' in details.vehicle_accident), `${rel}: answers are kept per type`);
  assert((await page.textContent('#enroute-incident-details')).includes('לכודים ברכב: נדרש צוות חילוץ'), `${rel}: trapped in vehicle must warn`);

  // Rescue chain's progressive-collapse status counts as a collapse too.
  await page.evaluate(() => { ensureSiteStatusFields(currentSiteId()).buildingStatus = 'progressive_collapse'; });
  assert((await page.evaluate(() => incidentTypeLabel(currentSiteId()))).includes('תאונת דרכים + קריסת מבנה'), `${rel}: progressive collapse must add the collapse label`);

  assert(errors.length === 0, `${rel}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`${rel}: collapse brief browser test passed`);
}

(async () => {
  const pre = '/opt/pw-browsers/chromium';
  const browser = await chromium.launch(fs.existsSync(pre) ? { executablePath: pre } : {});
  try { for (const f of files) await checkFile(browser, f); } finally { await browser.close(); }
})().catch((e) => { console.error(e.message || e); process.exit(1); });
