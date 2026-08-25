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
  const identityFn = section(html, 'function rescueIdentityLine(p={}){', 'function tacticalPatientRow(p){');
  const tacticalFn = section(html, 'function tacticalPatientRow(p){', 'function tacticalPlatoonRollup(');
  const evacPanelFn = section(html, 'function renderRescueEvacOrderPanel(pts, title){', 'function renderDeathCertificationChain(){');
  const roleDashboardFn = section(html, 'function renderRoleDashboard(role=activeRoleDashboard){', 'function reassignPatient(');
  const rpcConfig = section(html, "rpc:{title:'מ״מ", "rcc:{title:'מ״פ חילוץ");

  assert(html.includes("const APP_VERSION = '2.99.16';"), `${rel}: APP_VERSION must be V2.9916`);
  assert(html.includes('Demo V2.9916'), `${rel}: launcher label must be Demo V2.9916`);
  assert(html.includes('ROLE // V2.9916'), `${rel}: role header must be Demo V2.9916`);
  assert(html.includes('Role-Based Medical Command System V2.9916'), `${rel}: role system strip must be Demo V2.9916`);

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

  // Evacuation-order panel: same ranking/order PC/CC already use (sortedPatientsByEvacPriority),
  // so rescue-chain and medical command never disagree about evacuation sequence. Tourniquet
  // reason stays verbatim (rpc/rcc already see/report tourniquet status); the vitals-derived
  // rank-2 reason (AVPU/RR) is redacted to a non-clinical label.
  assert(evacPanelFn.includes('sortedPatientsByEvacPriority(pts)'), `${rel}: renderRescueEvacOrderPanel must reuse the shared evac-priority sort, not a separate ranking`);
  assert(html.includes('function rescueEvacReason(rank, reason){'), `${rel}: rescueEvacReason missing`);
  assert(html.includes("if(rank===0 || rank===1) return reason;"), `${rel}: tourniquet-based reason (rank 0/1) must stay verbatim for rpc/rcc`);
  assert(html.includes("if(rank===2) return 'אדום — פינוי בעדיפות';"), `${rel}: rank-2 (vitals-derived) reason must be redacted for rpc/rcc`);
  assert(evacPanelFn.includes('rescueIdentityLine(p)'), `${rel}: evac-order panel rows must show patient identity`);

  // Wired into renderRoleDashboard for rpc/rcc only, scoped via the existing roleScopedPatients
  // (rpc = own platoon, rcc = whole company) - no new DecisionSupportEngine method needed since
  // this is a direct sort, not an acknowledgable recommendation.
  assert(roleDashboardFn.includes("role==='rpc'?renderRescueEvacOrderPanel(pts,'סדר פינוי מומלץ — מחלקה שלי')"), `${rel}: rpc must render the evac-order panel scoped to its own platoon`);
  assert(roleDashboardFn.includes("role==='rcc'?renderRescueEvacOrderPanel(pts,'סדר פינוי מומלץ — כלל הפלוגה')"), `${rel}: rcc must render the evac-order panel scoped to the whole company`);
  assert(roleDashboardFn.includes('${rescueEvacOrderPanel}'), `${rel}: rescueEvacOrderPanel must be spliced into the rendered sections`);

  // The old "(ללא מדדים / זהות)" section title is now stale since identity is shown -
  // must read "(ללא מדדים)" only.
  assert(roleDashboardFn.includes('תמונה טקטית — מחלקה שלי (ללא מדדים)'), `${rel}: rpc tactical section title must drop the stale "identity" exclusion claim`);
  assert(roleDashboardFn.includes('תמונה טקטית מרוכזת — פלוגה שלי (ללא מדדים)'), `${rel}: rcc tactical section title must drop the stale "identity" exclusion claim`);
  assert(!roleDashboardFn.includes('ללא מדדים / זהות'), `${rel}: no rpc/rcc section title should still claim identity is excluded`);

  // roleConfig responsibilities text updated to match (identity now owned, not excluded)
  assert(rpcConfig.includes('צפייה בשם מאומת/מדווח או תיאור זיהוי זמני לכל פצוע'), `${rel}: rpc responsibilities must list identity visibility`);
  assert(rpcConfig.includes('ללא גישה למדדים, טיפול או מנגנון פציעה'), `${rel}: rpc responsibilities must no longer claim identity is excluded`);

  console.log(`${rel}: Demo V2.9916 rpc/rcc evacuation order + identity visibility static smoke passed`);
}
