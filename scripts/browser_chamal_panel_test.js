// Real-browser test of the חמ״ל רפואי (role key chamal) panel (V2.99.93) and the three picture-quality fixes that came with it:
// - chamal gets its own panel (one card per site, clinical alerts apart from picture-quality alerts,
//   devices, open requests) instead of the generic role page; responsibilities sit behind a chip
// - suspected duplicates: by the recorded zone (locDetail, as the field flows write it; location is the
//   site address), never across sites, never from an unknown zone, never from "both not trapped";
//   same site + same zone + both trapped / no access still flags; titles use the visual id
// - the full command screen never shows a raw missing-data key (missing_vitals, ...)
// - the external-report gap alert is per site and needs that site's report
// - golden-hour line leaves out black casualties and says how many injury times are estimates; pending triage shown
// Checked at 412x915 (phone) and 1440x900 (laptop: sites and alert columns side by side).
// Local demo mode, synthetic data only. Run: npm install && node scripts/browser_chamal_panel_test.js
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
const PIN = '135790';

const siteNameByIdSafe = (id) => ({ SITE_A: 'מוקד A', SITE_B: 'מוקד B' }[id]);

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
    patients.push({ ...base, id: 'cp-a1', visualId: 'A-01', triage: 'red', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', location: 'הרצל 12', locDetail: 'לובי', injury: 'פגיעת מעיכה', trapStatus: 'not_trapped' });
    patients.push({ ...base, id: 'cp-a2', visualId: 'A-02', triage: 'yellow', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', location: 'הרצל 12', locDetail: 'חניה', injury: 'פגיעת מעיכה', trapStatus: 'not_trapped' });
    patients.push({ ...base, id: 'cp-b1', visualId: 'B-01', triage: 'red', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', location: 'ב.ג. 45', locDetail: 'מרתף', injury: 'פגיעת מעיכה', trapStatus: 'not_trapped' });
    // Same site, same zone (a description after " · " is not part of it), trapped + no access: a suspected duplicate.
    patients.push({ ...base, id: 'cp-a3', visualId: 'A-03', triage: 'yellow', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', location: 'הרצל 12', locDetail: 'קומה 2 / דירה 5', injury: 'שבר', trapStatus: 'trapped' });
    patients.push({ ...base, id: 'cp-a4', visualId: 'A-04', triage: 'green', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', location: 'הרצל 12', locDetail: 'קומה 2 / דירה 5 · חולצה כחולה', injury: 'חתך', trapStatus: 'access_blocked' });
    // Same zone and trapped, but on the other site: never a duplicate. A black casualty and one waiting for triage.
    patients.push({ ...base, id: 'cp-b3', visualId: 'B-03', triage: 'black', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', location: 'ב.ג. 45', locDetail: 'קומה 3', injury: 'מעיכה', createdAt: ago(90), tInjury: Date.now() - 90 * 60000, tInjurySource: 'entered' });
    patients.push({ ...base, id: 'cp-b4', visualId: 'B-04', triage: 'pending', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', location: 'ב.ג. 45', locDetail: 'חצר', injury: 'לא ידוע' });
    patients.push({ ...base, id: 'cp-b2', visualId: 'B-02', triage: 'yellow', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', location: 'ב.ג. 45', locDetail: 'קומה 2 / דירה 5', injury: 'שבר', trapStatus: 'trapped' });
    // Same zone, both registered without an injury (placeholder text), not trapped: never a duplicate.
    // A-07's injury time is in the future (wrong device clock): named on the golden-hour line, not counted.
    patients.push({ ...base, id: 'cp-a6', visualId: 'A-06', triage: 'green', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', location: 'הרצל 12', locDetail: 'קומה 4', injury: 'לא תועד', trapStatus: 'not_trapped' });
    patients.push({ ...base, id: 'cp-a7', visualId: 'A-07', triage: 'green', siteId: 'SITE_A', assignedPlatoonId: 'PLT-A', location: 'הרצל 12', locDetail: 'קומה 4', injury: 'לא תועד', trapStatus: 'not_trapped', tInjury: Date.now() + 3 * 3600000, tInjurySource: 'entered' });
    // A true pair by injury: same site and zone, not trapped, "שבר ירך" / "חשד לשבר בירך" (prefix ב).
    // The last injury typed on this phone is the same words: it must not hide the pair.
    patients.push({ ...base, id: 'cp-b5', visualId: 'B-05', triage: 'yellow', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', location: 'ב.ג. 45', locDetail: 'חדר מדרגות', injury: 'שבר ירך', trapStatus: 'not_trapped' });
    patients.push({ ...base, id: 'cp-b6', visualId: 'B-06', triage: 'yellow', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', location: 'ב.ג. 45', locDetail: 'חדר מדרגות', injury: 'חשד לשבר בירך', trapStatus: 'not_trapped' });
    // Same zone, both with the MSTART sweep's template injury: not a pair.
    patients.push({ ...base, id: 'cp-b7', visualId: 'B-07', triage: 'green', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', location: 'ב.ג. 45', locDetail: 'קומה 1', injury: 'פגיעת קריסה / לכידה', trapStatus: 'not_trapped' });
    patients.push({ ...base, id: 'cp-b8', visualId: 'B-08', triage: 'green', siteId: 'SITE_B', assignedPlatoonId: 'PLT-B', location: 'ב.ג. 45', locDetail: 'קומה 1', injury: 'פגיעת קריסה / לכידה', trapStatus: 'not_trapped' });
    siteData.lastMechanism = 'שבר ירך';
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
      goldenA: body.querySelector('[data-chamal-site="SITE_A"] [data-chamal-golden]')?.textContent || '',
      title: document.querySelector('#screen-role-dashboard .header-title, #screen-role-dashboard h1, #role-dashboard-title')?.textContent || document.getElementById('screen-role-dashboard').innerText.slice(0, 200),
      golden: body.querySelector('[data-chamal-site="SITE_B"] [data-chamal-golden]')?.textContent || '',
      pendingB: body.querySelector('[data-chamal-site="SITE_B"] [data-chamal-pending]')?.textContent || '',
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
  assert(info.evacLine.includes('בזירה 6') && info.evacLine.includes('בנאפ״ל'), `${tag}: site A evacuation line wrong: ${info.evacLine}`);
  assert(info.externalLine.includes('אין'), `${tag}: site A has no external report, line says: ${info.externalLine}`);
  assert(!info.responsibilitiesShown && info.hasChip, `${tag}: responsibilities must sit behind the chip, not at the top`);
  assert(info.devices >= 1, `${tag}: no device rows`);
  assert(info.title.includes('חמ״ל רפואי'), `${tag}: the role is shown as חמ״ל רפואי: ${info.title}`);
  assert(info.goldenA.includes('בדוק שעון'), `${tag}: a future injury time must be named on the golden-hour line: ${info.goldenA}`);
  assert(info.pendingB.includes('ממתינים למיון: 1'), `${tag}: site B has one casualty waiting for triage, card says: ${info.pendingB}`);
  // Site B: B-01, B-02, B-04..B-08 have no injury time and the demo has no incident time; B-03 (black, 90 min) is left out.
  assert(info.golden.includes('אף פצוע לא מעל 45') && info.golden.includes('7 ללא שעת פציעה'), `${tag}: golden-hour line must leave out the 90-min black casualty and name the 7 casualties with no known injury time: ${info.golden}`);
  assert(!info.rawKey, `${tag}: a raw missing-data key is on screen`);
  assert(!info.overflowX, `${tag}: the page scrolls sideways: ${info.overflowX}`);

  // Red casualties are clinical; picture-quality alerts are in their own column, never mixed.
  assert(info.clinicalTitles.some((t) => t.includes('פצוע אדום')), `${tag}: red casualty alert missing from the clinical column: ${info.clinicalTitles}`);
  assert(!info.clinicalTitles.some((t) => t.includes('כפילות')), `${tag}: a duplicate alert is in the clinical column`);
  // Duplicates: exactly the same-sector trapped pair, by visual id, nothing across sites.
  const dupes = info.qualityTitles.filter((t) => t.includes('כפילות'));
  assert(dupes.length === 2, `${tag}: expected exactly two suspected duplicates (A-03/A-04 trapped, B-05/B-06 injury), got ${JSON.stringify(dupes)}`);
  assert(dupes.some((d) => /A-03 ↔ A-04|A-04 ↔ A-03/.test(d)), `${tag}: trapped pair A-03/A-04 missing: ${dupes}`);
  assert(dupes.some((d) => /B-05 ↔ B-06|B-06 ↔ B-05/.test(d)), `${tag}: injury pair B-05/B-06 missing (prefix or last-typed injury hid it): ${dupes}`);
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
  // Site B reports exactly its field count; site A has no report: no gap alert at all (before, all
  // sites' casualties were compared with one site's report).
  const quiet = await page.evaluate(() => {
    const b = allSites.find((x) => x.id === 'SITE_B');
    const pb = getSitePatients('SITE_B');
    const n = (t) => pb.filter((p) => p.triage === t).length;
    b.externalReports = [{ id: 'ext-test-b', source: 'mda', red: n('red'), yellow: n('yellow'), green: n('green'), at: new Date().toISOString() }];
    renderRoleDashboard('chamal');
    return [...document.querySelectorAll('[data-chamal-quality] .cmd-strip-alert-title')].some((t) => t.textContent.includes('פער דיווח חיצוני'));
  });
  assert(!quiet, `${tag}: site B's matching report must not raise a gap alert for site A's casualties`);
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
  const extTitle = await page.evaluate(() => [...document.querySelectorAll('[data-chamal-quality] .cmd-strip-alert-title')].map((t) => t.textContent).find((t) => t.includes('פער דיווח חיצוני')) || '');
  assert(extTitle.includes(siteNameByIdSafe('SITE_A')), `${tag}: the gap alert names its site: ${extTitle}`);

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

// A site with an external report and no field casualty yet: the whole report is the gap, for the
// חמ״ל רפואי and on the full command screen (before, sites were only looked at through their casualties).
async function checkReportWithoutCasualties(browser) {
  const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const page = await context.newPage();
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => d.accept());
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#screen-pin-gate.active', { timeout: 5000 });
  await page.fill('#pin-gate-setup-new', PIN); await page.fill('#pin-gate-setup-confirm', PIN); await page.click('#pin-gate-setup-btn');
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    patients.push({ id: 'cz-a1', visualId: 'A-01', triage: 'red', siteId: 'SITE_A', location: 'הרצל 12', locDetail: 'לובי', vitals: {}, events: [], patientStatus: 'identified', createdAt: new Date().toISOString() });
    allSites.find((x) => x.id === 'SITE_B').externalReports = [{ id: 'ext-z', source: 'mda', red: 3, yellow: 0, green: 0, at: new Date().toISOString() }];
    startRoleDashboard('chamal');
    const panel = [...document.querySelectorAll('[data-chamal-quality] .cmd-strip-alert-title')].map((t) => t.textContent);
    openLegacyForRole('chamal'); switchCmdSite('ALL'); renderCommander();
    const full = document.getElementById('screen-commander').innerText;
    // The count sits in the duplicates panel (collapsed by default), so read its text directly.
    const dupPanel = document.getElementById('cmd-duplicates').textContent;
    // The full screen was left on ALL as chamal; a PC dashboard opened now must still see only its own
    // site's external gap, never site B's (before, its scope came from the last command screen state).
    const pcSite = pcPlatoonSite();
    const pcGaps = roleAlertRows('pc').filter((a) => a.type === 'EXTERNAL_REPORT_CONFLICT').map((a) => a.siteId);
    return { panel, pcSite, pcGaps, fullGap: (dupPanel.match(/(\d+) פערי דיווח חיצוני מול שדה/) || [])[1] || null };
  });
  assert(r.panel.some((t) => t.includes('פער דיווח חיצוני') && t.includes('מוקד B')), `report with no casualties: no gap alert for site B: ${JSON.stringify(r.panel)}`);
  assert(r.pcGaps.every((id) => id === r.pcSite), `PC dashboard saw another site's external gap: ${r.pcGaps} (own site ${r.pcSite})`);
  assert(r.fullGap === '3', `report with no casualties: full screen should count 3 gaps (site B only), got ${r.fullGap}`);
  assert(errors.length === 0, `report with no casualties: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log('  report without casualties: ok');
}

(async () => {
  const browser = await chromium.launch();
  try {
    await checkReportWithoutCasualties(browser);
    await checkPanel(browser, { width: 412, height: 915 });
    await checkPanel(browser, { width: 1440, height: 900 });
    console.log('browser_chamal_panel_test: PASS');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('browser_chamal_panel_test: FAIL\n' + (e.stack || e)); process.exit(1); });
