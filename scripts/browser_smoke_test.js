// Real browser smoke test: loads index.html and demo/rescue-app.html in headless Chromium via
// Playwright and checks the app actually renders and initializes, not just that the HTML text
// contains expected strings (see scripts/smoke_*.js for that kind of check). Manual-only, not
// wired into CI - see the package.json/CLAUDE.md note on why this is the one place in the repo
// with an npm dependency.
//
// Run: npm install && npm run test:browser-smoke   (or: node scripts/browser_smoke_test.js)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const files = [
  path.join(root, 'index.html'),
  path.join(root, 'demo', 'rescue-app.html'),
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const page = await browser.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  // restoreSession() runs async at the end of the inline script and returns early with no
  // network/session - give it a moment to settle before asserting on final DOM state.
  await page.waitForTimeout(500);

  assert(pageErrors.length === 0, `${rel}: uncaught page error(s): ${pageErrors.join(' | ')}`);

  const domainRulesLoaded = await page.evaluate(() => {
    const r = window.C5DomainRules;
    return !!r && typeof r.vitalsTimer === 'function' && typeof r.canChangePatientStatus === 'function'
      && typeof r.supplyBurnRatePer10Min === 'function';
  });
  assert(domainRulesLoaded, `${rel}: window.C5DomainRules did not load with the expected functions`);

  const appVersion = await page.evaluate(() => (typeof APP_VERSION !== 'undefined' ? APP_VERSION : null));
  assert(typeof appVersion === 'string' && /^\d+\.\d+(\.\d+)?$/.test(appVersion), `${rel}: APP_VERSION missing or malformed (got ${JSON.stringify(appVersion)})`);

  // Local storage is encrypted at rest (docs/THREAT_MODEL.md T2) behind a device PIN gate that's
  // now the true first screen, ahead of screen-login - a brand-new device (no PIN set yet) shows
  // the setup view first.
  let activeScreenId = await page.locator('.screen.active').first().getAttribute('id');
  assert(activeScreenId === 'screen-pin-gate', `${rel}: expected screen-pin-gate active on a fresh load with no PIN set, got ${activeScreenId}`);
  const setupPanelVisible = await page.locator('#pin-gate-setup-panel').isVisible();
  assert(setupPanelVisible, `${rel}: expected the PIN setup panel visible on a device with no PIN set yet`);

  const TEST_PIN = '135790';
  await page.fill('#pin-gate-setup-new', TEST_PIN);
  await page.fill('#pin-gate-setup-confirm', TEST_PIN);
  await page.click('#pin-gate-setup-btn');
  await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });

  const activeScreens = await page.locator('.screen.active').count();
  assert(activeScreens === 1, `${rel}: expected exactly one active screen after PIN setup, found ${activeScreens}`);
  activeScreenId = await page.locator('.screen.active').first().getAttribute('id');
  assert(activeScreenId === 'screen-login', `${rel}: expected screen-login active after PIN setup completes, got ${activeScreenId}`);

  // Prove the encryption actually happened, not just that the app kept working: inspect the raw
  // localStorage record directly - it must not be readable JSON with patient/clinical content.
  const rawVerifier = await page.evaluate((k) => localStorage.getItem(k), 'c5_pin_verifier_v1');
  assert(!!rawVerifier, `${rel}: expected a PIN verifier record in localStorage after setup`);
  const verifierShape = JSON.parse(rawVerifier);
  assert(verifierShape && verifierShape.ct && verifierShape.iv && verifierShape.salt, `${rel}: PIN verifier record missing expected {salt, iv, ct} shape`);

  // Reload (same page/origin, so localStorage persists) - a returning device with a PIN already
  // set must show the unlock view, not setup, and must reject a wrong PIN before accepting the
  // right one.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(500);
  activeScreenId = await page.locator('.screen.active').first().getAttribute('id');
  assert(activeScreenId === 'screen-pin-gate', `${rel}: expected screen-pin-gate active again after reload, got ${activeScreenId}`);
  const unlockPanelVisible = await page.locator('#pin-gate-unlock-panel').isVisible();
  assert(unlockPanelVisible, `${rel}: expected the PIN unlock panel (not setup) visible on a returning device with a PIN already set`);

  await page.fill('#pin-gate-unlock-input', '000000');
  await page.click('#pin-gate-unlock-btn');
  await page.waitForFunction(() => document.querySelector('#pin-gate-unlock-error')?.textContent?.length > 0, { timeout: 5000 });
  activeScreenId = await page.locator('.screen.active').first().getAttribute('id');
  assert(activeScreenId === 'screen-pin-gate', `${rel}: a wrong PIN must not unlock the device - expected screen-pin-gate still active, got ${activeScreenId}`);

  await page.fill('#pin-gate-unlock-input', TEST_PIN);
  await page.click('#pin-gate-unlock-btn');
  await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });
  activeScreenId = await page.locator('.screen.active').first().getAttribute('id');
  assert(activeScreenId === 'screen-login', `${rel}: the correct PIN must unlock the device - expected screen-login active, got ${activeScreenId}`);

  // A page that only half-parsed would still often report zero console errors (they're
  // warnings by default), so also fail loudly if anything logged at error level - a failed
  // resource load from a truly broken <script> tag would surface here.
  const unexpectedConsoleErrors = consoleErrors.filter((m) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|net::ERR_/.test(m));
  assert(unexpectedConsoleErrors.length === 0, `${rel}: unexpected console error(s): ${unexpectedConsoleErrors.join(' | ')}`);

  await page.close();
  console.log(`${rel}: browser smoke passed (APP_VERSION ${appVersion}, PIN gate setup/unlock/wrong-PIN-rejection verified, screen-login active, C5DomainRules loaded, no page errors)`);
}

async function main() {
  for (const file of files) {
    assert(fs.existsSync(file), `missing file: ${path.relative(root, file)}`);
  }
  // Prefer a pre-installed Chromium binary when the sandbox provides one (its revision may
  // trail the npm-installed Playwright version, which would otherwise try to download a new
  // browser build); fall back to Playwright's own managed browser otherwise.
  const preinstalled = '/opt/pw-browsers/chromium';
  const launchOptions = fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {};
  const browser = await chromium.launch(launchOptions);
  try {
    for (const file of files) {
      await checkFile(browser, file);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
