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

function section(html, startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert(start >= 0, `missing section start: ${startNeedle}`);
  const end = html.indexOf(endNeedle, start + startNeedle.length);
  assert(end > start, `missing section end: ${endNeedle}`);
  return html.slice(start, end);
}

for (const rel of files) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');
  const identityFn = section(html, 'function rescueIdentityLine(p={}){', 'function tacticalPatientRow(p){');
  const tacticalFn = section(html, 'function tacticalPatientRow(p){', 'function tacticalPlatoonRollup(');
  const evacPanelFn = section(html, 'function renderRescueEvacOrderPanel(pts, title){', 'function renderDeathCertificationChain(){');
  const roleDashboardFn = section(html, 'function renderRoleDashboard(role=activeRoleDashboard){', 'function reassignPatient(');
  const rpcConfig = section(html, "rpc:{title:'מ״מ", "rcc:{title:'מ״פ חילוץ");

  assertVersionLabels(html, rel);

  // Patient identity is now in scope for rpc/rcc (per user correction to the earlier
  // "no identity" design) - name once reported/confirmed, else the physical description
  // already used elsewhere for locating an unidentified patient.
  assert(identityFn.includes("if(p.fullName && p.fullName!=='לא מזוהה') return p.fullName;"), `${rel}: rescueIdentityLine must prefer a confirmed/reported full name`);
  assert(identityFn.includes('if(p.temporaryDescription) return p.temporaryDescription;'), `${rel}: rescueIdentityLine must fall back to temporaryDescription`);
  assert(tacticalFn.includes('rescueIdentityLine(p)'), `${rel}: tacticalPatientRow (rpc's tactical list) must show patient identity`);

  // medicCallsign (the RESPONSIBLE MEDIC's identity) stays callsign-only - unaffected by the
  // patient-identity change above, this is a distinct piece of information.
  assert(html.includes('function medicCallsign(idOrName){'), `${rel}: medicCallsign missing`);
  assert(html.includes("return user ? user.callsign : 'לא משויך';"), `${rel}: medicCallsign must still redact to callsign only`);

  // Evacuation-order panel: same order PC/CC use (the server's get_rescue_patient_board() order
  // signed in, otherwise the shared sortedPatientsByEvacPriority), so rescue-chain and medical
  // command never disagree about evacuation sequence. Since database/074 (owner, 2026-10-23) the
  // rescue chain sees no clinical data: only urgent / not urgent, no colour, no tourniquet reason.
  assert(evacPanelFn.includes('rescueSortedForEvac('), `${rel}: renderRescueEvacOrderPanel must use the shared rescue evac order`);
  assert(html.includes('return [...ranked, ...sortedPatientsByEvacPriority(pts.filter(p=>!Number.isFinite(p.rescueEvacOrder)))];'), `${rel}: patients the server has not ranked must fall back to the shared evac-priority sort`);
  assert(!html.includes('function rescueEvacReason('), `${rel}: no evacuation reason text for rpc/rcc (it names the tourniquet or the vitals)`);
  assert(evacPanelFn.includes('RESCUE_PRIORITY_LABELS[prio]') && !evacPanelFn.includes('TRIAGE_LABELS'), `${rel}: evac-order panel shows priority, never the triage colour`);
  assert(!tacticalFn.includes('TRIAGE_LABELS'), `${rel}: tacticalPatientRow must not show the triage colour`);
  assert(evacPanelFn.includes('rescueIdentityLine(p)'), `${rel}: evac-order panel rows must show patient identity`);

  // Wired into renderRoleDashboard for rpc/rcc only, scoped via the existing roleScopedPatients
  // (rpc = own platoon, rcc = whole company) - no new DecisionSupportEngine method needed since
  // this is a direct sort, not an acknowledgable recommendation.
  // Since V2.99.76 the RPC has the RCC panel too (owner 2026-11-19), scoped to its own platoon.
  assert(roleDashboardFn.includes('if(RESCUE_PANEL_ROLES.has(role)){') && html.includes("const RESCUE_PANEL_ROLES=new Set(['rpc','rcc']);"), `${rel}: rpc must render the rescue panel`);
  assert(html.includes("const platoonOk=inc=>rescueCmdRole()!=='rpc'"), `${rel}: the rpc table keeps its own platoon's incidents only`);
  // RCC has its own panel since V2.99.76 (owner 2026-11-19): incidents table, a row opens the
  // incident's patients in the same shared evacuation order.
  const rccIncidentFn = section(html, 'function renderRccIncidentView(cfg){', 'function renderRccOverview(){');
  assert(roleDashboardFn.includes('body.innerHTML=renderRccPanel();'), `${rel}: rcc must render its own panel`);
  assert(rccIncidentFn.includes("renderRescueEvacOrderPanel(pts, 'סדר פינוי — הפצועים באירוע')"), `${rel}: rcc incident view must use the shared evac-order panel`);

  // Section titles: identity is shown, clinical data is not (database/074).
  assert(!html.slice(html.indexOf('function renderRccPanel(')).split('function renderRoleDashboard(')[0].includes('TRIAGE_LABELS'), `${rel}: rcc panel must not show the triage colour`);
  assert(html.includes('data-aar-rescue') && html.includes('rep.rescue.extracted'), `${rel}: the stored report shows the rescue section (database/085)`);
  assert(!roleDashboardFn.includes('ללא מדדים / זהות'), `${rel}: no rpc/rcc section title should still claim identity is excluded`);

  // roleConfig responsibilities text updated to match (identity now owned, not excluded)
  assert(rpcConfig.includes('צפייה בשם מאומת/מדווח או תיאור זיהוי זמני לכל פצוע'), `${rel}: rpc responsibilities must list identity visibility`);
  assert(rpcConfig.includes('ללא גישה לצבע מיון, חסם, מדדים, טיפול או מנגנון פציעה'), `${rel}: rpc responsibilities must exclude colour, tourniquet and clinical data, not identity`);

  console.log(`${rel}: Demo V2.9916 rpc/rcc evacuation order + identity visibility static smoke passed`);
}
