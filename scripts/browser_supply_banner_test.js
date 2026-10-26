// Real-browser test for V2.99.70: the "supply used" banner that replaced the sheet which covered
// the screen after every treatment that uses up an item (owner 2026-10-26).
//
// Checks, at phone width (375x812), in local demo mode with the page's own functions:
// - a tourniquet from step 7 shows the banner, not a modal: the limb buttons take a real tap at
//   once, and the banner covers none of the tourniquet details (limb, time) or the continue button;
// - the patient still being documented is named "הפצוע בתיעוד", never the internal draft-... id;
//   a saved patient by its number;
// - with stock left it closes by itself after 6 seconds; a low or empty stock warning stays until
//   closed;
// - "שנה כמות" and "בטל שימוש" change the medic's stock, and unselecting the treatment afterwards
//   returns only what is still counted (no double return).
//
// Runs in CI through scripts/run_tests.js (WP-13); also runs on its own.
// Run: npm install && node scripts/browser_supply_banner_test.js
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
    await page.clock.install();
    // No backend in this test: serve an empty supabase-js instead of waiting on the CDN.
    await page.route('**/supabase-js@*/**', (r) => r.fulfill({ contentType: 'application/javascript', body: '' }));
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
    await page.fill('#pin-gate-setup-new', PIN);
    await page.fill('#pin-gate-setup-confirm', PIN);
    await page.click('#pin-gate-setup-btn');
    await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });

    const banner = () => page.evaluate(() => {
      const el = document.getElementById('supply-used-banner');
      return {
        shown: !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none',
        warn: el.classList.contains('warn'),
        text: document.getElementById('supply-used-body').textContent.replace(/\s+/g, ' ').trim(),
        overlay: [...document.querySelectorAll('.modal-overlay')].some((m) => !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none'),
      };
    });

    // 1. Tourniquet from step 7: banner, no modal, the limb takes a real tap at once.
    await page.evaluate(() => {
      patients = [];
      startNewPatient('extended');
      state.triage = 'red';
      goTo('step7');
      window.scrollTo(0, 0);
    });
    await page.click('#march-sec-m .chip[data-tx="tourniquet"]');
    let b = await banner();
    assert(b.shown && !b.overlay, `a tourniquet shows the banner and no modal, got ${JSON.stringify(b)}`);
    assert(b.text.includes('חסמי עורקים') && b.text.includes('הפצוע בתיעוד'), `banner names the item and "הפצוע בתיעוד", got "${b.text}"`);
    assert(!/draft-/.test(b.text), `the internal draft id must never be shown, got "${b.text}"`);
    assert(b.text.includes('נותר בערכה: 2') && !b.warn, `3 -> 2 tourniquets, no warning, got "${b.text}"`);
    // Choosing a tourniquet scrolls to its details (as before this change); the banner, at the top,
    // covers none of what the medic needs next: limb, time and the continue button.
    const covered = await page.evaluate(() => {
      const r = document.getElementById('supply-used-banner').getBoundingClientRect();
      const hit = (el) => { const q = el.getBoundingClientRect(); return q.height > 0 && q.left < r.right && q.right > r.left && q.top < r.bottom && q.bottom > r.top; };
      return [...document.querySelectorAll('#limb-grid .limb-btn, #tourniquet-time-input, #tourniquet-wrap button, #screen-step7 .bottom-bar button')]
        .filter((el) => getComputedStyle(el).display !== 'none' && hit(el)).map((el) => el.dataset.tx || el.id || el.textContent.trim());
    });
    assert(covered.length === 0, `the banner may not cover the tourniquet details or continue: ${covered.join(', ')}`);
    await page.click('#limb-grid .limb-btn >> nth=3', { timeout: 2000 });
    const limbPicked = await page.evaluate(() => [...tqData.limbs].join());
    assert(limbPicked === 'rr', `the limb must take a tap while the banner is up, got "${limbPicked}"`);

    // 2. With stock left it closes by itself after 6 seconds.
    await page.clock.runFor(5000);
    assert((await banner()).shown, 'still shown at 5 seconds');
    await page.clock.runFor(1500);
    assert(!(await banner()).shown, 'closed by itself after 6 seconds');

    // 3. Quantity change and cancel, then unselecting the treatment: no double return.
    await page.click('#march-sec-m .chip[data-tx="hemostatic"]');
    b = await banner();
    assert(b.shown && b.warn && b.text.includes('מלאי נמוך'), `gauze 2 -> 1 is low: banner warns, got ${JSON.stringify(b)}`);
    await page.click('#supply-used-banner button[onclick="changeSupplyUseQuantity()"]');
    let st = await page.evaluate(() => ({ stock: state.localStockCache.hemostaticGauze, mv: state.supplyMovements['tx:hemostatic'].qty }));
    b = await banner();
    assert(st.stock === 0 && st.mv === 2 && b.text.includes('×2') && b.text.includes('מלאי אזל'), `quantity 2: stock 0, movement 2, banner "×2" and empty, got ${JSON.stringify(st)} "${b.text}"`);
    await page.clock.runFor(10000);
    assert((await banner()).shown, 'an empty-stock warning stays until closed');
    await page.click('#supply-used-banner button[onclick="cancelSupplyUse()"]');
    st = await page.evaluate(() => ({ stock: state.localStockCache.hemostaticGauze, mv: state.supplyMovements['tx:hemostatic'].qty }));
    assert(st.stock === 2 && st.mv === 0, `cancel returns both: stock 2, movement 0, got ${JSON.stringify(st)}`);
    assert(!(await banner()).shown, 'cancel closes the banner');
    await page.click('#march-sec-m .chip[data-tx="hemostatic"]'); // unselect
    st = await page.evaluate(() => state.localStockCache.hemostaticGauze);
    assert(st === 2, `unselecting after a cancel must not return the gauze twice, got ${st}`);

    // 4. Close button; a saved patient is named by its number.
    await page.click('#march-sec-m .chip[data-tx="bandage"]');
    await page.click('#supply-used-banner .supply-banner-close');
    assert(!(await banner()).shown, 'the ✕ closes the banner');
    const saved = await page.evaluate(() => {
      const p = { id: 'P009-TS', visualId: 'P009-TS', triage: 'red', events: [] };
      patients.push(p);
      consumeFieldSupply('blankets', -1, p.id);
      return p.visualId;
    });
    b = await banner();
    assert(b.text.includes(saved), `a saved patient is named by its number, got "${b.text}"`);

    assert(pageErrors.length === 0, `uncaught page error(s): ${pageErrors.join(' | ')}`);
    await page.close();
    console.log('index.html: supply used banner browser test passed');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
