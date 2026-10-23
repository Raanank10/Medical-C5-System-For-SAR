// Every missing-data ("assessment debt") key index.html can put on a patient must have a Hebrew
// label in DEBT_LABELS, so no raw key such as stale_vitals ever reaches the screen (owner,
// 2026-10-23). Static check over index.html; scripts/browser_mobile_layout_test.js checks the
// rendered screen too. Node stdlib only.
// Run: node tests/debt-labels.test.js
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

const block = html.match(/const DEBT_LABELS = \{([\s\S]*?)\n\};/);
assert.ok(block, 'DEBT_LABELS object not found in index.html');
const labelled = new Set([...block[1].matchAll(/^\s*([a-z_]+)\s*:/gm)].map((m) => m[1]));
assert.ok(labelled.size > 5, `DEBT_LABELS looks empty (${labelled.size} keys)`);

const emitted = new Set();
const add = (re, group = 1) => [...html.matchAll(re)].forEach((m) => emitted.add(m[group]));
add(/\bdebt\.push\('([a-z_]+)'\)/g);                                   // assessmentDebtForPatient()
add(/assessmentDebt\.push\('([a-z_]+)'\)/g);                           // tourniquet limb unknown
add(/assessmentDebt\|\|\[\]\),\s*'([a-z_]+)'/g);                       // [...(p.assessmentDebt||[]),'x']
[...html.matchAll(/assessmentDebt:\s*\[([^\]]*)\]/g)].forEach((m) =>  // marker creation
  [...m[1].matchAll(/'([a-z_]+)'/g)].forEach((k) => emitted.add(k[1])));

assert.ok(emitted.size >= 10, `expected to find the debt keys index.html emits, found only ${[...emitted].join(', ')}`);
const missing = [...emitted].filter((k) => !labelled.has(k)).sort();
assert.deepEqual(missing, [], `debt keys with no Hebrew label in DEBT_LABELS: ${missing.join(', ')}`);

// The renderers must go through debtLabel(), never print the key itself.
assert.ok(!/DEBT_LABELS\[d\]\|\|d\b/.test(html), 'a renderer falls back to the raw key (DEBT_LABELS[d]||d)');
assert.ok(!/detail:debt\.join\(/.test(html), 'an alert detail joins raw debt keys');

console.log(`debt-labels: ${emitted.size} emitted keys, all labelled (${[...emitted].sort().join(', ')})`);
