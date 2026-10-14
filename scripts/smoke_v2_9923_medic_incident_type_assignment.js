const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const files = ['index.html', path.join('demo', 'rescue-app.html')];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const rel of files) {
  const html = fs.readFileSync(path.join(root, rel), 'utf8');

  assert(html.includes("const APP_VERSION = '2.99.23';"), `${rel}: APP_VERSION must be V2.9923`);
  assert(html.includes('Demo V2.9923'), `${rel}: launcher label must be Demo V2.9923`);
  assert(html.includes('ROLE // V2.9923'), `${rel}: role header must be Demo V2.9923`);
  assert(html.includes('Role-Based Medical Command System V2.9923'), `${rel}: role system strip must be Demo V2.9923`);

  // Medic Movement screen: the hardcoded "structural collapse" alert banner is gone, replaced by
  // the same four incident types the rescue-chain (rpc/rcc) authority panel offers.
  assert(!html.includes('התרעה: אירוע קריסת מבנה פלוגתי'), `${rel}: hardcoded collapse banner must be removed from the Movement screen`);
  assert(html.includes('id="enroute-incident-type-grid"'), `${rel}: Movement screen must have an incident-type grid`);
  for (const type of ['missile_strike_structural_collapse', 'mass_shooting', 'vehicle_accident', 'explosion']) {
    assert(html.includes(`onclick="selectEnrouteIncidentType('${type}')"`), `${rel}: Movement screen must offer incident type ${type}`);
    assert(html.includes(`onclick="rescueSetIncidentType('\${role}','${type}')"`), `${rel}: rescue panel must still offer incident type ${type}`);
  }
  assert(html.includes('id="enroute-assignment-card"'), `${rel}: Movement screen must render the assignment / prior-info card`);

  // Rescue keeps final authority: rescue records its source, and a medic pick that differs from a
  // non-medic source is reported as a mismatch rather than overwriting it.
  assert(html.includes("s.incidentTypeSource={role,byLabel:rescueReporterLabel(role),at:Date.now()};"), `${rel}: rescueSetIncidentType must record its source`);
  assert(/function incidentTypeLockedForMedic\(siteId\)\{[\s\S]{0,200}?s\.incidentTypeSource\?\.role!=='medic'/.test(html), `${rel}: incident type must be locked for medics once a non-medic source set it`);
  assert(/if\(incidentTypeLockedForMedic\(siteId\)\)\{[\s\S]{0,800}?INCIDENT_TYPE_MISMATCH_REPORTED[\s\S]{0,600}?return;\s*\}/.test(html), `${rel}: a locked mismatch must report and return before applying the medic's type`);
  assert(html.includes("type:'INCIDENT_TYPE_MISMATCH',severity:'medium',owner:'pc'"), `${rel}: mismatch must surface as a PC alert`);

  // PC -> medic assignment (local-demo only) and prefill.
  assert(html.includes('id="medic-assign-modal"'), `${rel}: PC assignment modal must exist`);
  assert(html.includes(`onclick="openMedicAssignModal('\${m.userId}')"`), `${rel}: PC medic panel must offer an assign action`);
  assert(html.includes("type:'MEDIC_ASSIGNED_TO_INCIDENT'"), `${rel}: assignment must be logged as a local event`);
  assert(html.includes('applyEnrouteAssignmentPrefill();\n    renderEnrouteIncidentContext();'), `${rel}: goTo('enroute') must prefill and render the incident context`);
  assert(html.includes("type:'SITE_PREFILL_CORRECTED'"), `${rel}: medic corrections to prefilled values must be logged`);
  assert(html.includes('medicIncidentAssignments,demoSyncMode,lastSyncAt}));'), `${rel}: assignments must persist in the demo snapshot`);

  // Signed-in safety: the live medic is only a member of incident A, so a local assignment must
  // never move a signed-in device's sync target, and the new events must stay local-only.
  assert(html.includes("return (!currentUser && a?.siteId) || 'SITE_A';"), `${rel}: currentSiteId() must ignore local assignments while signed in`);
  assert(html.includes("if(currentUser && siteId!=='SITE_A'){ toast("), `${rel}: confirmMedicAssignment must refuse non-SITE_A while signed in`);
  const eligible = html.match(/const SYNC_ELIGIBLE_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\);/);
  assert(eligible, `${rel}: SYNC_ELIGIBLE_EVENT_TYPES must exist`);
  for (const t of ['MEDIC_ASSIGNED_TO_INCIDENT', 'INCIDENT_TYPE_MISMATCH_REPORTED', 'SITE_PREFILL_CORRECTED', 'INCIDENT_TYPE_SET']) {
    assert(!eligible[1].includes(`'${t}'`), `${rel}: ${t} must stay local-only (not sync-eligible)`);
  }

  console.log(`${rel}: Demo V2.9923 medic incident-type / assignment smoke passed`);
}
