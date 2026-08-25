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
  const engine = section(html, 'const DecisionSupportEngine=(()=>', 'function renderRecommendationCard');
  const dashboardScreen = section(html, '<div id="screen-dashboard" class="screen">', 'id="screen-site"');

  assert(html.includes("const APP_VERSION = '2.99.16';"), `${rel}: APP_VERSION must be V2.9916`);
  assert(html.includes('Demo V2.9916'), `${rel}: launcher label must be Demo V2.9916`);
  assert(html.includes('ROLE // V2.9916'), `${rel}: role header must be Demo V2.9916`);
  assert(html.includes('Role-Based Medical Command System V2.9916'), `${rel}: role system strip must be Demo V2.9916`);

  assert(engine.includes('function forMedic()'), `${rel}: DecisionSupportEngine.forMedic missing`);
  assert(engine.includes("patients:roleScopedPatients('medic')"), `${rel}: forMedic must scope recommendations to the logged-in medic's own patients`);

  assert(html.includes('function renderRoleBriefingBody('), `${rel}: renderRoleBriefingBody missing`);
  assert(html.includes('function openRoleBriefing('), `${rel}: openRoleBriefing missing`);
  assert(html.includes("id=\"role-briefing-modal\""), `${rel}: role briefing modal markup missing`);
  assert(html.includes('class="modal-overlay hidden"') && html.includes('id="role-briefing-modal"'), `${rel}: role briefing modal must reuse the existing modal-overlay/modal-sheet pattern`);
  assert(html.includes("roleSection('תחומי אחריות'"), `${rel}: role briefing must surface roleConfig responsibilities`);
  assert(html.includes('siteData.hazardNote'), `${rel}: role briefing must surface siteData.hazardNote`);

  assert(dashboardScreen.includes('onclick="openRoleBriefing(\'medic\')"'), `${rel}: medic dashboard header must trigger the role briefing`);
  assert(dashboardScreen.includes('id="medic-briefing-badge"'), `${rel}: medic dashboard must show an unacknowledged-recommendation badge`);
  assert(dashboardScreen.includes('id="medic-nba-banner"'), `${rel}: medic dashboard must have a next-best-action banner slot`);

  assert(html.includes('function renderMedicNbaBanner('), `${rel}: renderMedicNbaBanner missing`);
  assert(html.includes('function updateMedicBriefingBadge('), `${rel}: updateMedicBriefingBadge missing`);
  assert(html.includes('DecisionSupportEngine.forMedic()'), `${rel}: renderDashboard must consume DecisionSupportEngine.forMedic`);

  assert(html.includes('hazardNote:\'\''), `${rel}: siteData default must include hazardNote`);
  assert(html.includes('id="site-hazard-note"'), `${rel}: Site screen must expose an editable hazard-note field`);
  assert(html.includes("siteData.hazardNote=document.getElementById('site-hazard-note')"), `${rel}: saveSite must persist the hazard note`);

  console.log(`${rel}: Demo V2.9916 role briefing static smoke passed`);
}
