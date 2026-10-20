const fs = require('fs');
const path = require('path');
const { assertVersionLabels } = require('./lib/smoke_version');

const root = path.resolve(__dirname, '..');
const files = ['index.html'];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const rel of files) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');

  assertVersionLabels(html, rel);

  // PR2 of the resupply queue/dispatch scope: a real cross-device read of supply_requests
  // (database/033_supply_request_projection.sql) via get_supply_request_queue, replacing
  // reinforcementRequests' local-only view of resupply requests on the logistics/pc/cc boards.
  // Read-only in this pass - asserts the pull wiring and all three render call sites exist,
  // not any write/dispatch action (that's a later PR).
  assert(html.includes("async function pullSupplyRequestQueue(incidentId)"), `${rel}: pullSupplyRequestQueue() must exist`);
  assert(html.includes("client.rpc('get_supply_request_queue'"), `${rel}: must call the real get_supply_request_queue RPC`);
  assert(html.includes("async function pullSupplyRequestQueueAll()"), `${rel}: pullSupplyRequestQueueAll() must exist`);
  assert(/setInterval\(\(\)=>\{ if\(currentUser\) pullSupplyRequestQueueAll\(\); \}, 45000\)/.test(html), `${rel}: must poll the real queue on the same 45s cadence as sync/command-state pulls`);
  assert(html.includes('let _supplyRequestQueue={}'), `${rel}: _supplyRequestQueue store must exist`);
  assert(html.includes('function formatSupplyRequestRow(r)'), `${rel}: formatSupplyRequestRow() must exist`);
  assert(html.includes('function renderRealSupplyQueueRoleSection(incidentId)'), `${rel}: renderRealSupplyQueueRoleSection() must exist`);

  // All three call sites: logistics (own DOM element), pc board, cc board.
  assert(html.includes('id="logistics-real-queue"'), `${rel}: logistics screen must have a real-queue container`);
  assert(html.includes("document.getElementById('logistics-real-queue')"), `${rel}: renderLogisticsOfficer must populate the real-queue container`);
  assert(/renderPcResupplyBoard\(\)\{[\s\S]*?renderRealSupplyQueueRoleSection\(SITE_TO_INCIDENT_ID\[currentSiteId\(\)\]\)/.test(html), `${rel}: renderPcResupplyBoard must append the real queue section`);
  assert(/renderCcResupplyCommandBoard\(\)\{[\s\S]*?renderRealSupplyQueueRoleSection\(SITE_TO_INCIDENT_ID\[currentSiteId\(\)\]\)/.test(html), `${rel}: renderCcResupplyCommandBoard must append the real queue section`);

  console.log(`${rel}: Demo V2.9919 logistics resupply queue pull/read smoke passed`);
}
