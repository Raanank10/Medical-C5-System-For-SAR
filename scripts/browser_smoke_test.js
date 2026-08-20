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

  const activeScreens = await page.locator('.screen.active').count();
  assert(activeScreens === 1, `${rel}: expected exactly one active screen on initial load, found ${activeScreens}`);

  const activeScreenId = await page.locator('.screen.active').first().getAttribute('id');
  assert(activeScreenId === 'screen-login', `${rel}: expected screen-login active on a fresh load with no session, got ${activeScreenId}`);

  // A page that only half-parsed would still often report zero console errors (they're
  // warnings by default), so also fail loudly if anything logged at error level - a failed
  // resource load from a truly broken <script> tag would surface here.
  const unexpectedConsoleErrors = consoleErrors.filter((m) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|net::ERR_/.test(m));
  assert(unexpectedConsoleErrors.length === 0, `${rel}: unexpected console error(s): ${unexpectedConsoleErrors.join(' | ')}`);

  await page.close();
  console.log(`${rel}: browser smoke passed (APP_VERSION ${appVersion}, screen-login active, C5DomainRules loaded, no page errors)`);
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
