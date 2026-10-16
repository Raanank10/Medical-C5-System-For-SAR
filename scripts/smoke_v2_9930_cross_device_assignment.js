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

  assert(html.includes("const APP_VERSION = '2.99.30';"), `${rel}: APP_VERSION must be V2.9930`);
  assert(html.includes('Demo V2.9930'), `${rel}: launcher label must be Demo V2.9930`);
  assert(html.includes('ROLE // V2.9930'), `${rel}: role header must be Demo V2.9930`);
  assert(html.includes('Role-Based Medical Command System V2.9930'), `${rel}: role system strip must be Demo V2.9930`);

  // Cross-device PC -> medic assignment on real incidents, using existing tables/RLS only.
  assert(/async function assignRealMedic\(profileId, address, note\)\{[\s\S]{0,1200}?updateIncidentWithMetadata\([\s\S]{0,600}?from\('incident_memberships'\)\.upsert\(\{incident_id:incidentId, profile_id:profileId, role_at_incident:[^}]*assigned_by:currentUser\.id/.test(html), `${rel}: assignment must write address/note first, then the medic membership with assigned_by`);
  assert(html.includes("if(!upd.data?.length) throw new Error("), `${rel}: an incident update that changed no row must fail loudly, not silently`);
  assert(html.includes("function canAssignMedicsOnServer(){ return !!currentUser && !!activeIncident && INCIDENT_COMMAND_ROLES.has(currentUser.role); }"), `${rel}: only command roles inside an incident may assign`);
  assert(/async function pullMyAssignment\(client\)\{[\s\S]{0,400}?\.eq\('profile_id',currentUser\.id\)\.not\('assigned_by','is',null\)\.order\('created_at',\{ascending:false\}\)\.limit\(1\)/.test(html), `${rel}: the medic phone must read its newest assigned membership`);
  assert(html.includes('id="assignment-switch-banner"') && html.includes('onclick="switchToAssignedIncident()"'), `${rel}: a medic in another incident must be offered a switch, not moved silently`);
  assert(html.includes("if(!activeIncident){ rememberDismissedAssignment(assignmentKey(a)); await activateIncident(a.incident);"), `${rel}: a medic not in any incident goes straight to the assigned one`);
  assert(/async function refreshIncidentContext\(\)\{[\s\S]{0,250}?await pullIncidentAssignmentState\(\);/.test(html), `${rel}: the 45s incident refresh must also pull the assignment`);

  // Incident type: server is the rescue/opening authority and reaches every phone.
  assert(html.includes("if(currentUser && activeIncident && siteId==='SITE_A') writeIncidentTypeToServer(activeIncident.id, type, role);"), `${rel}: rescue's incident type must be written to the server when signed in`);
  assert(/function applyServerIncidentType\(row\)\{[\s\S]{0,200}?if\(_pendingIncidentTypeWrites\[row\.id\]\) return;/.test(html), `${rel}: a pending local rescue write must not be overwritten by an older server value`);
  assert(/function myIncidentAssignment\(\)\{[\s\S]{0,250}?a\.incidentId===activeIncident\.id \? a : null;/.test(html), `${rel}: the Movement screen only uses an assignment for the incident the medic is in`);

  // Unchanged guarantees.
  const eligible = html.match(/const SYNC_ELIGIBLE_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\);/);
  assert(eligible && !eligible[1].includes("'MEDIC_ASSIGNED_TO_INCIDENT'"), `${rel}: MEDIC_ASSIGNED_TO_INCIDENT stays a local log entry; the membership row is the source of truth`);
  assert(html.includes('function getSupabaseClient(){\n  if(_demoSandbox) return null;'), `${rel}: the sandboxed briefing must still block all server access`);

  console.log(`${rel}: Demo V2.9930 cross-device assignment smoke passed`);
}
