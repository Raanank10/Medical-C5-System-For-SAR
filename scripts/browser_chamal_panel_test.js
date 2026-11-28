// Real-browser test of the חמ״ל רפואי (role key chamal) panel (V2.99.96) and the three picture-quality fixes that came with it:
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

// Golden-hour clock (owner 2026-11-27): with no injury time entered it starts when the casualty's own
// incident began, the earlier of T0 and the opening time; with neither, registration is a lower limit:
// "לפחות N דק׳", red on it once past 60, "prompt" while under 45, never "ok". The full screen's row says it counts everyone, and shows visual ids.
async function checkGoldenHourClock(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
    const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
    const base = { triage: 'red', siteId: 'SITE_A', location: 'הרצל 12', locDetail: 'לובי', vitals: {}, events: [], patientStatus: 'identified', createdAt: ago(5) };
    // Demo, no T0 on the site: no clock at all.
    // Registered 90 minutes ago with no injury or incident time: at least 90 minutes, so red.
    patients.push({ ...base, id: 'gh-demo', visualId: 'A-50', createdAt: ago(90) });
    const demo = computeWatchdogRows(patients).find((x) => x.patient === 'gh-demo' && x.name === 'Golden Hour');
    startRoleDashboard('chamal');
    const card = document.querySelector('[data-chamal-site="SITE_A"] [data-chamal-golden]')?.textContent || '';
    // Signed in: the active incident (T0 70 min ago) and another incident (no T0 known, opened 50 min
    // ago; and one whose T0 is earlier than its opening).
    currentUser = { id: 'USR-CHAMAL-TEST', role: 'chamal', email: 'chamal@example.test' };
    activeIncident = { id: 'INC-1', t_zero: ago(70), opened_at: ago(65) };
    _openIncidents = [activeIncident, { id: 'INC-2', t_zero: null, opened_at: ago(50) }, { id: 'INC-3', t_zero: ago(80), opened_at: ago(30) }];
    patients.push({ ...base, id: 'gh-1', visualId: 'A-51', incidentId: 'INC-1' });
    patients.push({ ...base, id: 'gh-2', visualId: 'A-52', incidentId: 'INC-2' });
    patients.push({ ...base, id: 'gh-3', visualId: 'A-53', incidentId: 'INC-3' });
    patients.push({ ...base, id: 'gh-4', visualId: 'A-54', incidentId: 'INC-UNKNOWN' });
    // Owner: "the earlier beats everything else" (2026-11-27), for Crush and every injury timer too
    // (2026-11-28). Injury time entered 20 min ago, incident began 70 min ago: both rows run on 70.
    patients.push({ ...base, id: 'gh-6', visualId: 'A-56', incidentId: 'INC-1', trapStatus: 'trapped', tInjury: Date.now() - 20 * 60000, tInjurySource: 'entered' });
    // Entered 65 min ago, incident opened 50 min ago (INC-2): the entered 65 counts (the earlier).
    patients.push({ ...base, id: 'gh-7', visualId: 'A-57', incidentId: 'INC-2', tInjury: Date.now() - 65 * 60000, tInjurySource: 'entered' });
    // An incident whose only time is 20 min in the future: not used. Registered 5 min ago: the
    // registration as a lower limit, waiting; registered 90 min ago: red on it; with an injury time
    // entered 70 min ago: that time, red.
    _openIncidents.push({ id: 'INC-4', t_zero: new Date(Date.now() + 20 * 60000).toISOString(), opened_at: null });
    patients.push({ ...base, id: 'gh-8', visualId: 'A-58', incidentId: 'INC-4' });
    patients.push({ ...base, id: 'gh-9', visualId: 'A-59', incidentId: 'INC-4', tInjury: Date.now() - 70 * 60000, tInjurySource: 'entered' });
    patients.push({ ...base, id: 'gh-10', visualId: 'A-60', incidentId: 'INC-4', createdAt: ago(90) });
    // Registered 50 min ago, incident T0 set only now (made official later): at least 50, amber.
    _openIncidents.push({ id: 'INC-5', t_zero: new Date().toISOString(), opened_at: null });
    patients.push({ ...base, id: 'gh-11', visualId: 'A-61', incidentId: 'INC-5', createdAt: ago(50) });
    // The server's stored default (incident_open = T0) ties with the incident start: not an estimate.
    patients.push({ ...base, id: 'gh-12', visualId: 'A-62', incidentId: 'INC-1', tInjury: Date.parse(activeIncident.t_zero), tInjurySource: 'incident_open' });
    // An entered time in the future with a valid incident: the incident's clock, and the row says so.
    patients.push({ ...base, id: 'gh-13', visualId: 'A-63', incidentId: 'INC-1', tInjury: Date.now() + 2 * 3600000, tInjurySource: 'entered' });
    // A row pulled from before 088: its stored "injury time" is only the registration time.
    patients.push({ ...base, id: 'gh-5', visualId: 'A-55', incidentId: 'INC-1', tInjury: Date.now() - 5 * 60000, tInjurySource: 'event_time' });
    // First in the list, only a prompt: the panel must still open with a red row.
    patients.unshift({ ...base, id: 'gh-0', visualId: 'A-49', incidentId: 'INC-UNKNOWN' });
    const rows = computeWatchdogRows(patients);
    const g = (id) => rows.find((x) => x.patient === id && x.name === 'Golden Hour');
    goTo('commander'); renderCommander();
    const panel = document.getElementById('cmd-watchdogs').textContent;
    const firstRowRed = document.querySelector('#cmd-watchdogs .watchdog-row')?.classList.contains('red');
    currentUser = null; _openIncidents = []; activeIncident = null;
    return { demo, card, firstRowRed, g10: g('gh-10'), g11: g('gh-11'), g12: g('gh-12'), g13: g('gh-13'), g7: g('gh-7'), g8: g('gh-8'), g9: g('gh-9'), g6: g('gh-6'), c6: rows.find((x) => x.patient === 'gh-6' && x.name === 'Crush Syndrome'), g5: g('gh-5'), g1: g('gh-1'), g2: g('gh-2'), g3: g('gh-3'), g4: g('gh-4'), panel };
  });
  assert(r.demo && r.demo.state === 'red' && r.demo.detail.includes('לפחות 90 דק׳'), `no injury or incident time: registration is a lower limit, 90 min is red ("לפחות"): ${JSON.stringify(r.demo)}`);
  assert(r.card.includes('1 עברו 60') && r.card.includes('נספרו לפחות מהרישום'), `site card: a casualty with no clock is counted on its lower limit and named: ${r.card}`);
  assert(r.firstRowRed, `watchdog panel: red rows first`);
  assert(r.g6.state === 'red' && r.g6.detail.startsWith('70 דק׳'), `golden hour: a later entered injury time never shortens the incident's clock: ${JSON.stringify(r.g6)}`);
  assert(r.g7.state === 'red' && r.g7.detail.startsWith('65 דק׳') && r.g7.detail.includes('מאז הפציעה'), `golden hour: an entered injury time earlier than the incident counts: ${JSON.stringify(r.g7)}`);
  assert(r.g8.state === 'prompt' && r.g8.detail.includes('לפחות 5'), `golden hour: a future incident time is not used; the registration is the lower limit, waiting, never ok: ${JSON.stringify(r.g8)}`);
  assert(r.g10.state === 'red' && r.g10.detail.includes('לפחות 90'), `golden hour: a future incident time must not hide a 90-minute registration: ${JSON.stringify(r.g10)}`);
  assert(r.g11.state === 'amber' && r.g11.detail.includes('לפחות 50'), `golden hour: registered before the incident's T0: at least 50, amber: ${JSON.stringify(r.g11)}`);
  assert(r.g12.state === 'red' && r.g12.detail.includes('מאז תחילת האירוע') && !r.g12.detail.includes('משוערת'), `golden hour: a stored T0 default is the incident start, not an estimate: ${JSON.stringify(r.g12)}`);
  assert(r.g13.state === 'red' && r.g13.detail.startsWith('70 דק׳') && r.g13.detail.includes('שעת הפציעה שהוזנה בעתיד'), `golden hour: a future entered time is set aside and named: ${JSON.stringify(r.g13)}`);
  assert(r.g9.state === 'red' && r.g9.detail.startsWith('70 דק׳'), `golden hour: a future incident time does not hide a valid entered time: ${JSON.stringify(r.g9)}`);
  assert(r.c6 && r.c6.state === 'red' && r.c6.detail.includes('70 דק׳'), `crush runs on the same earliest clock as the golden hour: ${JSON.stringify(r.c6)}`);
  assert(r.g5.state === 'red' && r.g5.detail.startsWith('70 דק׳'), `a stored registration-time "injury time" must give way to the incident's start: ${JSON.stringify(r.g5)}`);
  assert(r.g1.state === 'red' && r.g1.detail.startsWith('70 דק׳') && r.g1.detail.includes('מאז תחילת האירוע'), `active incident: from its T0 (70 min): ${JSON.stringify(r.g1)}`);
  assert(r.g2.state === 'amber' && r.g2.detail.startsWith('50 דק׳'), `another incident with no T0: from its opening (50 min), not registration: ${JSON.stringify(r.g2)}`);
  assert(r.g3.state === 'red' && r.g3.detail.startsWith('80 דק׳'), `another incident: the earlier of T0 (80) and opening (30): ${JSON.stringify(r.g3)}`);
  assert(r.g4.state === 'prompt' && r.g4.detail.includes('לפחות 5 דק׳'), `incident unknown, registered 5 min ago: prompt with the lower limit, never ok: ${JSON.stringify(r.g4)}`);
  assert(r.panel.includes('כולל שפונו ושחורים') && r.panel.includes('A-5') && !r.panel.includes('gh-'), `full-screen rows: say they count everyone, show visual ids: ${r.panel.slice(0, 300)}`);
  assert(errors.length === 0, `golden-hour clock: page errors: ${errors.join(' | ')}`);
  await context.close();
  console.log('  golden-hour clock: ok');
}

(async () => {
  const browser = await chromium.launch();
  try {
    await checkGoldenHourClock(browser);
    await checkReportWithoutCasualties(browser);
    await checkPanel(browser, { width: 412, height: 915 });
    await checkPanel(browser, { width: 1440, height: 900 });
    console.log('browser_chamal_panel_test: PASS');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('browser_chamal_panel_test: FAIL\n' + (e.stack || e)); process.exit(1); });
