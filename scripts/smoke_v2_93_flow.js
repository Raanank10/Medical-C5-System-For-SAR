const fs = require('fs');
const path = require('path');
const { assertVersionLabels } = require('./lib/smoke_version');

const root = path.resolve(__dirname, '..');
const files = [path.join(root, 'index.html')];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const file of files) {
  const rel = path.relative(root, file);
  const html = fs.readFileSync(file, 'utf8');
  const taskBoard = html.indexOf('function renderPcNowTaskBoard');
  const loadBoard = html.indexOf('function renderPcMedicLoadBoard');
  const pcBoard = html.indexOf('function renderPcResponsibilityBoard');

  assert(taskBoard >= 0, `${rel}: missing PC now-task board`);
  assert(loadBoard >= 0, `${rel}: missing PC medic-load board`);
  assert(taskBoard < pcBoard && loadBoard < pcBoard, `${rel}: PC helpers must be defined before responsibility board`);
  assert(html.includes('משימות חוג״ד עכשיו'), `${rel}: missing PC task-board title`);
  assert(html.includes("renderCollapsibleSection('pc-medic-load','עומס חובשים'"), `${rel}: missing PC medic-load title`);
  // V2.99.59: the PC panel is tabbed; the task board leads the פעולה tab, medic load leads כוחות.
  assert(html.includes('action:`${renderPcNowTaskBoard(myPts)}'), `${rel}: PC task board must lead the action tab`);
  assert(html.includes('forces:`${myPlatoonRow()}${renderPcMedicLoadBoard(myPts)}'), `${rel}: PC medic-load board must lead the forces tab`);
  assert(html.includes('function startNewPatient('), `${rel}: legacy patient fallback removed`);
  assert(html.includes('function createDeathCertificationRequest('), `${rel}: death certification removed`);
  assert(html.includes('silentPopup:true,silentWarnings:true,suppressAutoResupply:true'), `${rel}: silent MSTART logistics behavior changed`);
  assert(!html.includes('<span class="summary-key">SABCDE</span>'), `${rel}: SABCDE ghost summary row returned`);
  assert(!html.includes('sabcde:{}'), `${rel}: SABCDE state ghost returned`);
  assert(!html.includes('.sabcde-opt,.avpu-btn'), `${rel}: SABCDE reset selector returned`);
  assert(html.includes("renderCollapsibleSection('cc-command-suggestions','הצעות פיקוד — מחושב בזמן אמת'"), `${rel}: CC live suggestions missing`);
  assert(html.includes('id="logistics-consumption-feed"'), `${rel}: logistics consumption feed missing`);
  assert(html.includes('id="logistics-quick-restock"'), `${rel}: logistics quick-restock row missing`);
  assert(html.includes('function receiveLogisticsSupply('), `${rel}: logistics receive helper missing`);
  assert(html.includes("pcTruckStock[itemType]=(pcTruckStock[itemType]??PC_TRUCK_BASELINE[itemType]??0)+received;"), `${rel}: logistics receive helper must replenish the PC truck`);
  assert(html.includes("movement_type:'logistics_manual_received'"), `${rel}: logistics receive helper must append a receipt ledger movement`);
  assertVersionLabels(html, rel);
  assert(!html.includes('Role-Based Medical Command System v2.91'), `${rel}: stale role strip version remains`);
  assert(!html.includes('ונפתח ״ציוד נצרך״'), `${rel}: launcher still promises a supply popup during sweep`);
  // The one allowed external script is the pinned supabase-js build used for real auth and sync.
  const externalScripts = html.match(/<script\s+src="[^"]*"/gi) || [];
  assert(externalScripts.length === 1 && /^<script\s+src="https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@\d+\.\d+\.\d+\//.test(externalScripts[0]), `${rel}: only the pinned supabase-js script may load externally`);

  console.log(`${rel}: V2.93 PC commander-impact static smoke passed`);
}
