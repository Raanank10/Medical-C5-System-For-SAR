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

  assert(html.includes("const APP_VERSION = '2.99.24';"), `${rel}: APP_VERSION must be V2.9924`);
  assert(html.includes('Demo V2.9924'), `${rel}: launcher label must be Demo V2.9924`);
  assert(html.includes('ROLE // V2.9924'), `${rel}: role header must be Demo V2.9924`);
  assert(html.includes('Role-Based Medical Command System V2.9924'), `${rel}: role system strip must be Demo V2.9924`);

  // Logged-in mode starts empty and works inside a real incident (database/038 lifecycle RPCs).
  assert(html.includes('id="screen-incident-picker"'), `${rel}: incident picker screen must exist`);
  assert(html.includes('id="incident-context-strip"'), `${rel}: incident context strip must exist`);
  assert(html.includes('id="draft-approval-banner"'), `${rel}: draft approval banner must exist`);
  for (const rpc of ['list_open_incidents', 'open_incident', 'join_incident', 'confirm_draft', 'reject_draft', 'acknowledge_draft']) {
    assert(html.includes(`'${rpc}'`), `${rel}: client must call the ${rpc} RPC`);
  }
  assert(html.includes("if(!currentUser && role!=='medic' && !patients.length) loadDemoScenario(true);"), `${rel}: role dashboards must not auto-load demo patients while logged in`);
  assert(html.includes('function blockDemoDataWhileLoggedIn()'), `${rel}: demo loaders must be guarded while logged in`);
  assert(html.includes('if(!entry.incident_id && currentUser && activeIncident) entry.incident_id=activeIncident.id;'), `${rel}: outbox entries must be pinned to the active incident at creation`);
  assert(html.includes("e.syncRejectReason='no_incident_context'"), `${rel}: unstamped outbox entries must be visibly rejected, not pushed`);

  // V2.99.24 triage sync: field triage reaches the server; server 'pending' never overwrites it.
  assert(html.includes('function reconcileTriageSync()'), `${rel}: triage reconciler must exist`);
  assert(html.includes("saveLocalEvent({type:'PATIENT_TRIAGE_UPDATED'"), `${rel}: red/yellow/green must be sent as PATIENT_TRIAGE_UPDATED`);
  assert(html.includes("saveLocalEvent({type:'PATIENT_TRIAGED_EXPECTANT', detail:`${p.visualId||p.id}"), `${rel}: black must be sent as PATIENT_TRIAGED_EXPECTANT`);
  assert(html.includes("if(serverTriage && serverTriage!=='pending'){ existing.triage=serverTriage;"), `${rel}: server pending must not overwrite a local triage`);

  // Legacy flows the smoke suite already depends on must still be present.
  assert(html.includes('LEGACY_FULL_ASSESSMENT_DO_NOT_DELETE_WITHOUT_TESTS'), `${rel}: legacy full assessment guard must remain`);

  console.log(`${rel}: Demo V2.9924 incident-lifecycle + triage-sync smoke passed`);
}

const a = fs.readFileSync(path.join(root, files[0]), 'utf8');
const b = fs.readFileSync(path.join(root, files[1]), 'utf8');
assert(a === b, 'index.html and demo/rescue-app.html must stay byte-identical');
console.log('index.html and demo/rescue-app.html are byte-identical');
