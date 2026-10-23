// Real-browser layout test of the MSTART sweep card on a phone (owner, 2026-10-23: "Why does it
// look so messy?"). Reproduces the reported screen - signed-in admin, field mode on, sweep list
// with a red casualty marked by a tourniquet, vitals overdue, the "+ פצוע | אותו אזור" button up -
// at 375x812 and 412x915, RTL, and fails on:
// - any two visible elements on the card, the header or the fixed controls whose boxes overlap
//   (one inside the other is fine; that is nesting, not overlap);
// - any element wider than the viewport, or cut off by the card's edge (overflow:hidden);
// - card content hidden under a fixed control after scrolling to the end of the screen;
// - a raw snake_case key (e.g. stale_vitals) shown as text on the sweep screen or in the alerts;
// - a header taller than 64px or a header button label on more than one line.
// No backend: currentUser is set in the page (as the other browser tests stub Supabase).
//
// Runs in CI through scripts/run_tests.js; also runs on its own.
// Run: npm install && node scripts/browser_mobile_layout_test.js [--shots <dir>] [--report-only]
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
const PIN = '135790';
const VIEWPORTS = [{ width: 375, height: 812 }, { width: 412, height: 915 }];
const args = process.argv.slice(2);
const shotsDir = args.includes('--shots') ? path.resolve(args[args.indexOf('--shots') + 1]) : null;
const reportOnly = args.includes('--report-only');

async function setUp(page) {
  await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(400);
  await page.fill('#pin-gate-setup-new', PIN);
  await page.fill('#pin-gate-setup-confirm', PIN);
  await page.click('#pin-gate-setup-btn');
  await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });
  await page.evaluate(() => {
    // Synthetic account only (docs/OPERATIONS_SAFETY.md).
    currentUser = { id: '44444444-4444-4444-8444-444444444444', email: 'medic.demo@example.test', role: 'admin' };
    renderAuthStatus();
    activeRoleDashboard = 'medic';
    applyFieldMode(true);
    goTo('sweep');
    startSweepCasualtyMarker();
    const p = patients[0];
    const old = new Date(Date.now() - 40 * 60000).toISOString();
    p.createdAt = old;
    p.lastVitalsAt = old;
    p.mstart.lifeThreateningHemorrhage = true;
    p.mstart.color = 'red';
    p.triage = 'red';
    p.alert = true;
    p.zone = 'אזור לא צוין';
    activeSweepPatientId = null;
    renderMstartSweep();
    showSameZoneFab(p.zone);
  });
  await page.waitForTimeout(300);
  return errors;
}

// Every element worth checking, with its box, at the current scroll position.
async function collectBoxes(page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const sel = [
      '#screen-sweep .patient-card', '#screen-sweep .patient-id', '#screen-sweep .ticket-triage-band',
      '#screen-sweep .ticket-triage-label', '#screen-sweep .ticket-triage-source', '#screen-sweep .debt-chip',
      '#screen-sweep .next-action-box', '#screen-sweep .patient-info > div',
      '#same-zone-fab', '#field-mode-toggle', '#global-home-btn', '#screen-sweep .bottom-bar',
      '#auth-status-strip', '#auth-status-strip button', '#auth-status-strip summary', '#auth-status-strip .auth-status-text',
    ];
    const seen = new Set();
    const out = [];
    sel.forEach((s) => document.querySelectorAll(s).forEach((el) => {
      if (seen.has(el)) return;
      seen.add(el);
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      // Pinned = fixed or sticky (itself or an ancestor): it stays put while content scrolls under it.
      let fixed = false;
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (['fixed', 'sticky'].includes(getComputedStyle(n).position)) { fixed = true; break; }
      }
      const label = (el.id ? '#' + el.id : el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : el.tagName)
        + ' "' + (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 28) + '"';
      const card = el.closest('.patient-card');
      const cr = card && card !== el ? card.getBoundingClientRect() : null;
      out.push({ label, fixed, vh: window.innerHeight, l: r.left, r: r.right, t: r.top, b: r.bottom, vw,
        card: cr ? { l: cr.left, r: cr.right, t: cr.top, b: cr.bottom } : null, idx: out.length });
      el.dataset.layoutIdx = String(out.length - 1);
    }));
    // Containment, so a chip inside the card is not reported as overlapping it.
    const els = [...document.querySelectorAll('[data-layout-idx]')];
    out.forEach((o) => { o.ancestors = []; });
    els.forEach((a) => els.forEach((b) => { if (a !== b && a.contains(b)) out[+b.dataset.layoutIdx].ancestors.push(+a.dataset.layoutIdx); }));
    els.forEach((e) => delete e.dataset.layoutIdx);
    return out;
  });
}

const EPS = 1;
function intersect(a, b) {
  return Math.min(a.r, b.r) - Math.max(a.l, b.l) > EPS && Math.min(a.b, b.b) - Math.max(a.t, b.t) > EPS;
}

function findProblems(boxes, phase) {
  const problems = [];
  boxes.forEach((a) => {
    if (a.l < -EPS || a.r > a.vw + EPS) problems.push(`${phase}: exceeds viewport (${Math.round(a.l)}..${Math.round(a.r)} of ${a.vw}): ${a.label}`);
    if (a.card && (a.l < a.card.l - EPS || a.r > a.card.r + EPS)) problems.push(`${phase}: cut off by its card: ${a.label}`);
  });
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]; const b = boxes[j];
      if (a.ancestors.includes(b.idx) || b.ancestors.includes(a.idx)) continue;
      if (!intersect(a, b)) continue;
      // A pinned control over scrolling content is normal mid-scroll. It is a problem only when a
      // bottom control (FAB, mode toggle, bottom bar) still covers content at the end of the scroll,
      // since then that content can never be uncovered. Pinned vs pinned always is.
      if (a.fixed !== b.fixed) {
        if (phase !== 'scrolled to end') continue;
        const pinned = a.fixed ? a : b;
        if (pinned.t < pinned.vh / 2) continue; // top header: content at the end sits below it
      }
      problems.push(`${phase}: overlap: ${a.label}  <>  ${b.label}`);
    }
  }
  return problems;
}

async function checkViewport(browser, vp) {
  const tag = `${vp.width}x${vp.height}`;
  const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  const errors = await setUp(page);
  const problems = errors.map((e) => `page error: ${e}`);

  // Scroll so the card sits where the reported screenshot had it, then check.
  await page.evaluate(() => document.querySelector('#screen-sweep .patient-card')?.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(150);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${tag}-card.png`) });
  problems.push(...findProblems(await collectBoxes(page), `${tag} card in view`));

  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(150);
  if (shotsDir) await page.screenshot({ path: path.join(shotsDir, `${tag}-end.png`) });
  problems.push(...findProblems(await collectBoxes(page), 'scrolled to end').map((p) => p.replace('scrolled to end', `${tag} scrolled to end`)));

  // Header: one line of buttons, at most 64px tall.
  const header = await page.evaluate(() => {
    const strip = document.getElementById('auth-status-strip');
    const r = strip.getBoundingClientRect();
    const controls = [...strip.querySelectorAll('button, summary')]
      .filter((b) => b.checkVisibility() && b.getBoundingClientRect().height > 0);
    // The label is the control's last text element (an icon may sit above it on purpose); it
    // must render as a single line.
    const multiLine = controls.filter((b) => {
      const label = [...b.querySelectorAll('span')].filter((s) => !s.getAttribute('aria-hidden')).pop() || b;
      const range = document.createRange();
      range.selectNodeContents(label);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      return lines.size > 1;
    }).map((b) => b.innerText.replace(/\s+/g, ' ').trim());
    const small = controls.filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.innerText.replace(/\s+/g, ' ').trim());
    return { height: Math.round(r.height), multiLine, small };
  });
  if (header.height > 64) problems.push(`${tag}: header is ${header.height}px tall (target <= 64)`);
  header.multiLine.forEach((t) => problems.push(`${tag}: header button wraps to several lines: "${t}"`));
  header.small.forEach((t) => problems.push(`${tag}: header control under 44px (docs/TACTICAL_UI_GUIDELINES.md): "${t}"`));

  // No raw enum keys on screen: the sweep screen and the medic alert texts.
  const raw = await page.evaluate(() => {
    const texts = [document.getElementById('screen-sweep').innerText];
    try { buildAlertObjects(patients).forEach((a) => texts.push(`${a.title} ${a.detail}`)); } catch (e) { texts.push('buildAlertObjects threw: ' + e); }
    return [...new Set(texts.join('\n').match(/\b[a-z]+(?:_[a-z]+)+\b/g) || [])];
  });
  raw.forEach((k) => problems.push(`${tag}: raw key shown to the user: ${k}`));

  await context.close();
  return problems;
}

(async () => {
  if (shotsDir) fs.mkdirSync(shotsDir, { recursive: true });
  const browser = await chromium.launch();
  let problems = [];
  try {
    for (const vp of VIEWPORTS) problems = problems.concat(await checkViewport(browser, vp));
  } finally {
    await browser.close();
  }
  if (problems.length) {
    console.log(problems.map((p) => '  - ' + p).join('\n'));
    if (!reportOnly) {
      console.error(`browser_mobile_layout_test: ${problems.length} layout problem(s)`);
      process.exit(1);
    }
  }
  console.log(`browser_mobile_layout_test: ${problems.length ? problems.length + ' problem(s) (report only)' : 'passed'} - ${VIEWPORTS.map((v) => v.width + 'x' + v.height).join(', ')}, RTL, field mode, signed-in header, sweep card, FAB`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
