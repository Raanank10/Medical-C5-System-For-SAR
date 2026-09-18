// Regression test for the F1 fix in docs/FAILURE_MODE_REVIEW.md ("Outbox cap could silently
// drop unsynced clinical data"). That review states persistOutbox() was "verified with three
// cases" when the fix landed, but no test file for it was ever committed to the repo - this is
// a real gap this script closes, not a new feature.
//
// Scope, honestly stated: this only exercises the pure client-side eviction logic in
// persistOutbox() (index.html / demo/rescue-app.html). It does NOT touch the network, Supabase
// Auth, or the /sync/log Edge Function - this sandboxed environment's outbound network policy
// blocks both the real Supabase project and the cdn.jsdelivr.net supabase-js bundle index.html
// loads, so a real cross-device sync-latency test (docs/FIELD_USABILITY_TEST_PLAN.md Session 2)
// cannot be run from here. This script is the one sub-piece of Session 2's step 5 (extended-
// offline stress test / outbox durability) that IS mechanically verifiable without real devices
// or real network - it is not a substitute for the real drill.
//
// Run: node scripts/test_outbox_eviction.js
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

function makeEntries(n, { synced }) {
  return Array.from({ length: n }, (_, i) => ({
    local_event_id: `${synced ? 'synced' : 'unsynced'}-${i}`,
    type: 'VITALS_RECORDED',
    synced,
  }));
}

async function checkFile(browser, file) {
  const rel = path.relative(root, file);
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await page.goto('file://' + file, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(300);

  // Same PIN-setup path browser_smoke_test.js uses - persistOutbox() needs _localEncKey set
  // (the encrypted-localStorage gate, docs/THREAT_MODEL.md T2) before it can run at all.
  const TEST_PIN = '135790';
  await page.fill('#pin-gate-setup-new', TEST_PIN);
  await page.fill('#pin-gate-setup-confirm', TEST_PIN);
  await page.click('#pin-gate-setup-btn');
  await page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'screen-login', { timeout: 5000 });

  // Case 1: normal mixed capping - 400 synced + 300 unsynced (700 total, over the 500 cap).
  // Expect: all 300 unsynced survive; only the newest 200 synced entries are kept (500 total).
  let result = await page.evaluate((entries) => {
    _outboxCache = entries;
    persistOutbox();
    return { total: _outboxCache.length, unsyncedKept: _outboxCache.filter(e => !e.synced).length,
      syncedKept: _outboxCache.filter(e => e.synced).length,
      keptSyncedIds: _outboxCache.filter(e => e.synced).map(e => e.local_event_id) };
  }, [...makeEntries(400, { synced: true }), ...makeEntries(300, { synced: false })]);
  assert(result.total === 500, `${rel} case 1: expected outbox trimmed to 500, got ${result.total}`);
  assert(result.unsyncedKept === 300, `${rel} case 1: expected all 300 unsynced entries preserved, got ${result.unsyncedKept}`);
  assert(result.syncedKept === 200, `${rel} case 1: expected exactly 200 synced entries kept (cap minus unsynced), got ${result.syncedKept}`);
  assert(result.keptSyncedIds.includes('synced-399') && !result.keptSyncedIds.includes('synced-0'),
    `${rel} case 1: expected the newest synced entries kept and oldest evicted, got ${JSON.stringify(result.keptSyncedIds.slice(0, 3))}...`);

  // Case 2: extreme case - 700 unsynced, 0 synced. The whole point of the fix: the outbox must
  // be allowed to grow past the 500 cap rather than silently drop unsynced clinical events.
  result = await page.evaluate((entries) => {
    _outboxCache = entries;
    persistOutbox();
    return { total: _outboxCache.length, unsyncedKept: _outboxCache.filter(e => !e.synced).length };
  }, makeEntries(700, { synced: false }));
  assert(result.total === 700, `${rel} case 2: expected outbox to grow past the 500 cap to 700, got ${result.total}`);
  assert(result.unsyncedKept === 700, `${rel} case 2: expected all 700 unsynced entries preserved with zero data loss, got ${result.unsyncedKept}`);

  // Case 3: boundary case - unsynced entries interspersed among older synced ones (not all at
  // the tail), 600 total. Every unsynced entry must survive regardless of its original position.
  const interspersed = [];
  for (let i = 0; i < 600; i++) {
    interspersed.push(i % 3 === 0
      ? { local_event_id: `mixed-unsynced-${i}`, type: 'TOURNIQUET_APPLIED', synced: false }
      : { local_event_id: `mixed-synced-${i}`, type: 'VITALS_RECORDED', synced: true });
  }
  const expectedUnsyncedCount = interspersed.filter(e => !e.synced).length;
  result = await page.evaluate((entries) => {
    _outboxCache = entries;
    persistOutbox();
    return { total: _outboxCache.length, unsyncedIds: _outboxCache.filter(e => !e.synced).map(e => e.local_event_id) };
  }, interspersed);
  assert(result.unsyncedIds.length === expectedUnsyncedCount,
    `${rel} case 3: expected all ${expectedUnsyncedCount} interspersed unsynced entries preserved, got ${result.unsyncedIds.length}`);
  const expectedIds = interspersed.filter(e => !e.synced).map(e => e.local_event_id).sort();
  assert(JSON.stringify(result.unsyncedIds.sort()) === JSON.stringify(expectedIds),
    `${rel} case 3: unsynced entry identity mismatch after trim - some specific unsynced event was lost or duplicated`);

  assert(pageErrors.length === 0, `${rel}: uncaught page error(s) during test: ${pageErrors.join(' | ')}`);
  await page.close();
  return true;
}

(async () => {
  // Prefer a pre-installed Chromium binary when the sandbox provides one (its revision may
  // trail the npm-installed Playwright version, which would otherwise try to download a new
  // browser build) - same fallback pattern as scripts/browser_smoke_test.js.
  const preinstalled = '/opt/pw-browsers/chromium';
  const launchOptions = fs.existsSync(preinstalled) ? { executablePath: preinstalled } : {};
  const browser = await chromium.launch(launchOptions);
  try {
    for (const file of files) {
      if (!fs.existsSync(file)) throw new Error(`Missing expected file: ${file}`);
      await checkFile(browser, file);
      console.log(`${path.relative(root, file)}: outbox eviction (F1) regression passed - 3 cases (mixed capping, 700-unsynced-only, interspersed boundary)`);
    }
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
