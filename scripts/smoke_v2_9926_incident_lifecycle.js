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

  // Logged-in mode starts empty and works inside a real incident (database/038 lifecycle RPCs).
  assert(html.includes('id="screen-incident-picker"'), `${rel}: incident picker screen must exist`);
  assert(html.includes('id="incident-context-strip"'), `${rel}: incident context strip must exist`);
  assert(html.includes('id="draft-approval-banner"'), `${rel}: draft approval banner must exist`);
  for (const rpc of ['list_open_incidents', 'open_incident', 'join_incident', 'confirm_draft', 'reject_draft', 'acknowledge_draft']) {
    assert(html.includes(`'${rpc}'`), `${rel}: client must call the ${rpc} RPC`);
  }
  assert(html.includes('function blockDemoDataWhileLoggedIn()'), `${rel}: demo loaders must be guarded while logged in`);
  assert(html.includes('if(!entry.incident_id && currentUser && activeIncident) entry.incident_id=activeIncident.id;'), `${rel}: outbox entries must be pinned to the active incident at creation`);
  assert(html.includes("e.syncRejectReason='no_incident_context'"), `${rel}: unstamped outbox entries must be visibly rejected, not pushed`);

  // Legacy flows the smoke suite already depends on must still be present.
  assert(html.includes('LEGACY_FULL_ASSESSMENT_DO_NOT_DELETE_WITHOUT_TESTS'), `${rel}: legacy full assessment guard must remain`);

  console.log(`${rel}: Demo V2.9926 incident-lifecycle smoke passed`);
}

