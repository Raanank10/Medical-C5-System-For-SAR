// Real-browser test of the חמ״ל panel (V2.99.92) and the three picture-quality fixes that came with it:
// - chamal gets its own panel (one card per site, clinical alerts apart from picture-quality alerts,
//   devices, open requests) instead of the generic role page; responsibilities sit behind a chip
// - suspected duplicates: never across sites, never from an unknown sector, never from "both not
//   trapped"; same site + same known sector + both trapped still flags; titles use the visual id
// - the full command screen never shows a raw missing-data key (missing_vitals, ...)
// - the external-report gap alert needs a report to compare against
// Checked at 412x915 (phone) and 1440x900 (laptop: sites and alert columns side by side).
// Local demo mode, synthetic data only. Run: npm install && node scripts/browser_chamal_panel_test.js
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
const PIN = '135790';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function open(browser, viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  await page.fill('#pin-gate-setup-new', PIN); await page.fill('#pin-gate-setup-confirm', PIN); await page.click('#pin-gate-setup-btn');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
    const base = { vitals: { pulse: 110, spo2: 94, rr: 24, avpu: 'V' }, events: [], patientStatus: 'identified', createdAt: ago(20) };
    // Unknown sector, different sites, same injury and both not trapped: the old check flagged all of these.
    patients.push({ ...base, id: 'cp-a1', visualId: 'A-01', triage: 'red', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', location: 'לובי', injury: 'פגיעת מעיכה', trapStatus: 'not_trapped' });
    patients.push({ ...base, id: 'cp-a2', visualId: 'A-02', triage: 'yellow', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', location: 'חניה', injury: 'פגיעת מעיכה', trapStatus: 'not_trapped' });
    patients.push({ ...base, id: 'cp-b1', visualId: 'B-01', triage: 'red', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', location: 'מרתף', injury: 'פגיעת מעיכה', trapStatus: 'not_trapped' });
    // Same site, same known sector, both trapped: still a suspected duplicate.
    patients.push({ ...base, id: 'cp-a3', visualId: 'A-03', triage: 'yellow', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', location: 'בניין 3, קומה 2', injury: 'שבר', trapStatus: 'trapped' });
    patients.push({ ...base, id: 'cp-a4', visualId: 'A-04', triage: 'green', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', location: 'בניין 3, קומה 2', injury: 'חתך', trapStatus: 'trapped' });
    // Same known sector and both trapped, but on the other site: never a duplicate.
    patients.push({ ...base, id: 'cp-b2', visualId: 'B-02', triage: 'yellow', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', location: 'בניין 3, קומה 2', injury: 'שבר', trapStatus: 'trapped' });
    createMedicalResourceRequest({ resourceType: 'doctor_treatment', siteId: 'SITE_A', targetLocation: 'לובי' });
    startRoleDashboard('chamal');
  });
  await page.waitForTimeout(400);
  return { page, context, errors };
}

async function checkPanel(browser, viewport) {
  const tag = `${viewport.width}x${viewport.height}`;
  const { page, context, errors } = await open(browser, viewport);

  const info = await page.evaluate(() => {
    const body = document.getElementById('role-dashboard-body');
    const text = body.innerText;
    const sites = [...body.querySelectorAll('[data-chamal-site]')].map((el) => ({ id: el.dataset.chamalSite, rect: el.getBoundingClientRect().toJSON() }));
    const clinical = body.querySelector('[data-chamal-clinical]');
    const quality = body.querySelector('[data-chamal-quality]');
    const alertTitles = (el) => [...el.querySelectorAll('.cmd-strip-alert-title')].map((t) => t.textContent);
    return {
      active: document.querySelector('.screen.active')?.id,
      sticky: !!body.querySelector('#command-sticky'),
      sites,
      clinicalTitles: alertTitles(clinical),
      qualityTitles: alertTitles(quality),
      clinicalRect: clinical.getBoundingClientRect().toJSON(),
      qualityRect: quality.getBoundingClientRect().toJSON(),
      devices: body.querySelectorAll('[data-chamal-device]').length,
      ages: body.querySelectorAll('[data-alert-age]').length,
      responsibilitiesShown: text.includes('אמינות נתונים ו-Sync'),
      hasChip: !!body.querySelector('[data-chamal-responsibilities]'),
      hasGenericMetrics: !!body.querySelector('.role-top-grid'),
      rawKey: /missing_vitals|stale_vitals|pending_handover|missing_trap_status/.test(text),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1 ? [...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>window.innerWidth+1||r.left<-1)}).slice(0,5).map(e=>e.tagName+'.'+e.className+':'+Math.round(e.getBoundingClientRect().left)+'/'+Math.round(e.getBoundingClientRect().right)+' '+(e.textContent||'').slice(0,40)).join(' ;; ') : false,
      evacLine: body.querySelector('[data-chamal-site="SITE_A"] [data-chamal-evac]')?.textContent || '',
      externalLine: body.querySelector('[data-chamal-site="SITE_A"] [data-chamal-external]')?.textContent || '',
    };
  });

  assert(info.active === 'screen-role-dashboard', `${tag}: expected the role dashboard, got ${info.active}`);
  assert(info.sticky, `${tag}: the shared command status strip is missing`);
  assert(!info.hasGenericMetrics, `${tag}: chamal still renders the generic metrics row`);
  assert(info.sites.map((s) => s.id).join(',') === 'SITE_A,SITE_B', `${tag}: expected one card per site, got ${info.sites.map((s) => s.id)}`);
  assert(info.evacLine.includes('בזירה 4') && info.evacLine.includes('בנאפ״ל'), `${tag}: site A evacuation line wrong: ${info.evacLine}`);
  assert(info.externalLine.includes('אין'), `${tag}: site A has no external report, line says: ${info.externalLine}`);
  assert(!info.responsibilitiesShown && info.hasChip, `${tag}: responsibilities must sit behind the chip, not at the top`);
  assert(info.devices >= 1, `${tag}: no device rows`);
  assert(info.ages >= 1, `${tag}: alerts show no age`);
  assert(!info.rawKey, `${tag}: a raw missing-data key is on screen`);
  assert(!info.overflowX, `${tag}: the page scrolls sideways: ${info.overflowX}`);

  // Red casualties are clinical; picture-quality alerts are in their own column, never mixed.
  assert(info.clinicalTitles.some((t) => t.includes('פצוע אדום')), `${tag}: red casualty alert missing from the clinical column: ${info.clinicalTitles}`);
  assert(!info.clinicalTitles.some((t) => t.includes('כפילות')), `${tag}: a duplicate alert is in the clinical column`);
  // Duplicates: exactly the same-sector trapped pair, by visual id, nothing across sites.
  const dupes = info.qualityTitles.filter((t) => t.includes('כפילות'));
  assert(dupes.length === 1, `${tag}: expected exactly one suspected duplicate, got ${JSON.stringify(dupes)}`);
  assert(/A-03 ↔ A-04|A-04 ↔ A-03/.test(dupes[0]), `${tag}: duplicate must name visual ids A-03/A-04: ${dupes[0]}`);
  assert(!info.qualityTitles.some((t) => t.includes('פער דיווח חיצוני')), `${tag}: external-report gap alert with no report filed`);

  if (viewport.width >= 1024) {
    assert(Math.abs(info.sites[0].rect.top - info.sites[1].rect.top) < 2, `${tag}: site cards should sit side by side on a laptop`);
    assert(Math.abs(info.clinicalRect.top - info.qualityRect.top) < 2, `${tag}: clinical and picture-quality columns should sit side by side on a laptop`);
  } else {
    assert(info.qualityRect.top > info.clinicalRect.bottom - 1, `${tag}: on a phone the columns stack (clinical first)`);
  }

  // The chip opens and closes the responsibilities.
  await page.click('[data-chamal-responsibilities]');
  await page.waitForTimeout(150);
  assert(await page.evaluate(() => document.getElementById('role-dashboard-body').innerText.includes('אמינות נתונים ו-Sync')), `${tag}: chip did not open responsibilities`);
  await page.click('[data-chamal-responsibilities]');
  await page.waitForTimeout(150);

  // An external report that disagrees with the field raises the gap alert and the site line says so.
  await page.evaluate(() => {
    siteData.externalReports = [{ id: 'ext-test-1', source: 'mda', red: 0, yellow: 0, green: 0, at: new Date().toISOString() }];
    renderRoleDashboard('chamal');
  });
  await page.waitForTimeout(150);
  const ext = await page.evaluate(() => ({
    line: document.querySelector('[data-chamal-site="SITE_A"] [data-chamal-external]')?.textContent || '',
    alert: [...document.querySelectorAll('[data-chamal-quality] .cmd-strip-alert-title')].some((t) => t.textContent.includes('פער דיווח חיצוני')),
  }));
  assert(ext.line.includes('פערים'), `${tag}: site A external line should report the gap: ${ext.line}`);
  assert(ext.alert, `${tag}: a report that disagrees with the field must raise the gap alert`);

  // "פתח מוקד במסך המלא" opens the full screen on that site, and it shows no raw missing-data key.
  await page.click('[data-chamal-site="SITE_B"] .chamal-site-open');
  await page.waitForTimeout(400);
  const full = await page.evaluate(() => ({
    active: document.querySelector('.screen.active')?.id,
    site: cmdActiveSite,
    role: commandRole,
  }));
  assert(full.active === 'screen-commander' && full.site === 'SITE_B' && full.role === 'chamal', `${tag}: site button should open the full screen on SITE_B as chamal: ${JSON.stringify(full)}`);
  await page.evaluate(() => { switchCmdSite('SITE_A'); });
  await page.waitForTimeout(300);
  const fullText = await page.evaluate(() => document.getElementById('screen-commander').innerText);
  assert(fullText.includes('יש לקחת מדדים:'), `${tag}: expected the missing-data line on the full screen`);
  assert(!/missing_vitals|stale_vitals|pending_handover|missing_trap_status|missing_evac/.test(fullText), `${tag}: raw missing-data key on the full command screen`);

  // The full screen's device panel and the חמ״ל panel read one list (commandDeviceRows): same devices
  // in both, demo path first, then the signed-in path with server presence rows (one silent).
  const sameDevices = async (label) => {
    const r = await page.evaluate(() => {
      goTo('commander'); renderCommander();
      const full = [...document.querySelectorAll('#cmd-device-panel .device-name')].map((e) => e.textContent).sort();
      startRoleDashboard('chamal');
      const panel = [...document.querySelectorAll('[data-chamal-device]')].map((e) => e.dataset.chamalDevice).sort();
      const silent = [...document.querySelectorAll('[data-chamal-device].offline')].map((e) => e.dataset.chamalDevice);
      return { full, panel, silent };
    });
    assert(r.full.length >= 1 && JSON.stringify(r.full) === JSON.stringify(r.panel), `${tag} ${label}: device lists differ: full ${r.full} / panel ${r.panel}`);
    return r;
  };
  await sameDevices('demo');
  const signed = await page.evaluate(() => {
    currentUser = { id: 'USR-CHAMAL-TEST', role: 'chamal', email: 'chamal@example.test' };
    const inc = SITE_TO_INCIDENT_ID.SITE_A || 'INC-TEST';
    _remoteDevicePresence = [
      { device_id: 'PHONE-LIVE-1', incident_id: inc, last_heartbeat_at: new Date(Date.now() - 60000).toISOString(), sync_status: 'ok' },
      { device_id: 'PHONE-QUIET-2', incident_id: inc, last_heartbeat_at: new Date(Date.now() - 25 * 60000).toISOString(), sync_status: 'ok' },
    ];
    return true;
  });
  assert(signed, `${tag}: could not set the signed-in device state`);
  const live = await sameDevices('signed in');
  assert(live.panel.includes('PHONE-LIVE-1') && live.panel.includes('PHONE-QUIET-2'), `${tag}: server presence rows missing: ${live.panel}`);
  assert(live.silent[0] === 'PHONE-QUIET-2', `${tag}: the silent device must be listed first and marked: ${live.silent}`);
  await page.evaluate(() => { currentUser = null; _remoteDevicePresence = []; });

  assert(errors.length === 0, `${tag}: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log(`  ${tag}: ok`);
}

(async () => {
  const browser = await chromium.launch();
  try {
    await checkPanel(browser, { width: 412, height: 915 });
    await checkPanel(browser, { width: 1440, height: 900 });
    console.log('browser_chamal_panel_test: PASS');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('browser_chamal_panel_test: FAIL\n' + (e.stack || e)); process.exit(1); });
