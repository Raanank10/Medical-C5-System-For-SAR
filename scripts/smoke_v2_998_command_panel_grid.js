const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['index.html', path.join('demo', 'rescue-app.html')];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function section(html, startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert(start >= 0, `missing section start: ${startNeedle}`);
  const end = html.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing section end: ${endNeedle}`);
  return html.slice(start, end);
}

for (const rel of files) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');
  const ccHero = section(html, 'function renderCcHeroDashboard', 'function renderCcCommandBoard');
  const pcLoadBoard = section(html, 'function renderPcMedicLoadBoard', 'function renderPcResponsibilityBoard');

  assert(html.includes("const APP_VERSION = '2.99.15';"), `${rel}: APP_VERSION must be V2.9915`);
  assert(html.includes('Demo V2.9915'), `${rel}: launcher label must be Demo V2.9915`);
  assert(html.includes('ROLE // V2.9915'), `${rel}: role header must be Demo V2.9915`);
  assert(html.includes('Role-Based Medical Command System V2.9915'), `${rel}: role system strip must be Demo V2.9915`);

  assert(html.includes('.panel-grid{'), `${rel}: panel-grid CSS missing`);
  assert(html.includes('.panel-status.critical{') && html.includes('.panel-status.stable{') && html.includes('.panel-status.ok{'), `${rel}: panel status color classes missing`);

  assert(html.includes('function renderCcPlatoonPanel('), `${rel}: CC per-platoon panel renderer missing`);
  assert(ccHero.includes('class="panel-grid"') && ccHero.includes('platoonPanels'), `${rel}: CC hero must render a platoon panel grid instead of the old comparison table`);
  assert(!ccHero.includes('<table class="auth-table">'), `${rel}: CC hero should no longer use the old platoon comparison table`);
  assert(html.includes("pl.score>=8?'critical':pl.score>=3?'stable':'ok'"), `${rel}: CC panel status must reuse the existing score>=8/>=3 thresholds, not new ones`);

  assert(html.includes('function renderPcMedicPanel('), `${rel}: PC per-medic panel renderer missing`);
  assert(pcLoadBoard.includes('class="panel-grid"') && pcLoadBoard.includes('renderPcMedicPanel('), `${rel}: PC medic-load board must render a medic panel grid instead of flat rows`);
  assert(pcLoadBoard.includes("overloaded=pts.length>=4||red>=2") && pcLoadBoard.includes('C5Rules.isDeviceSilent(lastMs)'), `${rel}: PC medic panel status must reuse the existing overloaded/silent logic, not new thresholds`);

  console.log(`${rel}: Demo V2.9915 command panel grid static smoke passed`);
}
