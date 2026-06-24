const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = [
  path.join(root, 'index.html'),
  path.join(root, 'demo', 'rescue-app.html')
];

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
  assert(html.includes('renderPcNowTaskBoard(myPts)}${renderPcMedicLoadBoard(myPts)}${renderDedicatedPcCommandBoard(myPts)'), `${rel}: PC hero boards are not first`);
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
  assert(html.includes("const APP_VERSION = '2.99.4';"), `${rel}: APP_VERSION must be V2.994`);
  assert(html.includes('Demo V2.994'), `${rel}: launcher version label must be V2.994`);
  assert(html.includes('ROLE // V2.994'), `${rel}: role header version label must be V2.994`);
  assert(html.includes('Role-Based Medical Command System V2.994'), `${rel}: role system strip must be V2.994`);
  assert(!html.includes('Role-Based Medical Command System v2.91'), `${rel}: stale role strip version remains`);
  assert(!html.includes('ונפתח ״ציוד נצרך״'), `${rel}: launcher still promises a supply popup during sweep`);
  assert(!/<script\s+src=/i.test(html), `${rel}: external script introduced`);

  console.log(`${rel}: V2.93 PC commander-impact static smoke passed`);
}
