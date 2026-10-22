// Runs every manual test script in one go, one after the other, and fails if any fails
// (docs/GAP_CLOSURE_PLAN.md WP-13). Used by the browser-and-smoke-tests CI job and locally:
//   npm test                         # everything
//   node scripts/run_tests.js smoke  # only scripts/smoke_*.js
//   node scripts/run_tests.js browser
// Groups: browser = scripts/browser_*.js (Playwright, headless Chromium), other =
// scripts/test_*.js, smoke = scripts/smoke_*.js (string checks on index.html). check_repo.py and
// tests/domain-rules.test.js stay in the separate fast repo-check job.
// Each script runs in its own process with a time limit, so one hang cannot stall the rest.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const scriptsDir = path.join(root, 'scripts');
const TIMEOUT_MS = 5 * 60 * 1000;

const GROUPS = {
  browser: (f) => /^browser_.*\.js$/.test(f),
  other: (f) => /^test_.*\.js$/.test(f),
  smoke: (f) => /^smoke_.*\.js$/.test(f),
};

const wanted = process.argv.slice(2);
const groups = wanted.length ? wanted : Object.keys(GROUPS);
for (const g of groups) {
  if (!GROUPS[g]) {
    console.error(`unknown group "${g}" (use: ${Object.keys(GROUPS).join(', ')})`);
    process.exit(2);
  }
}

const files = fs.readdirSync(scriptsDir).sort();
const results = [];
for (const group of groups) {
  for (const file of files.filter(GROUPS[group])) {
    const started = Date.now();
    const run = spawnSync(process.execPath, [path.join(scriptsDir, file)], { cwd: root, encoding: 'utf8', timeout: TIMEOUT_MS });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const ok = run.status === 0 && !run.error;
    results.push({ group, file, ok, seconds });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${group.padEnd(7)} ${file} (${seconds}s)`);
    if (!ok) {
      const why = run.error ? String(run.error.message || run.error) : `exit ${run.status}${run.signal ? ' ' + run.signal : ''}`;
      const output = `${run.stdout || ''}${run.stderr || ''}`.trim().split('\n').slice(-20).join('\n');
      console.log(`     ${why}\n${output.replace(/^/gm, '     | ')}`);
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map((r) => r.file).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
