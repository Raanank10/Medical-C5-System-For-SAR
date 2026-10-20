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

  // V2.99.27 triage sync: field triage reaches the server; server 'pending' never overwrites it.
  assert(html.includes('function reconcileTriageSync()'), `${rel}: triage reconciler must exist`);
  assert(html.includes("saveLocalEvent({type:'PATIENT_TRIAGE_UPDATED'"), `${rel}: red/yellow/green must be sent as PATIENT_TRIAGE_UPDATED`);
  assert(html.includes("saveLocalEvent({type:'PATIENT_TRIAGED_EXPECTANT', detail:`${p.visualId||p.id}"), `${rel}: black must be sent as PATIENT_TRIAGED_EXPECTANT`);
  assert(html.includes("if(serverTriage && serverTriage!=='pending'){ existing.triage=serverTriage;"), `${rel}: server pending must not overwrite a local triage`);

  // V2.99.29 incident close guard (database/040): no close while patients are not handed over,
  // medical-command override only with a mandatory reason, server is the authority when logged in.
  for (const rpc of ['close_incident', 'reopen_incident']) {
    assert(html.includes(`'${rpc}'`), `${rel}: client must call the ${rpc} RPC`);
  }
  assert(html.includes('id="incident-close-modal"'), `${rel}: close guard modal must exist`);
  assert(html.includes('id="incident-strip-close-btn"'), `${rel}: incident strip must offer close/reopen to closing roles`);
  assert(html.includes("const INCIDENT_CLOSE_ROLES=new Set(['pc','cc','chamal','admin','physician','rpc','rcc']);"), `${rel}: closing roles must match close_incident()`);
  assert(html.includes("const INCIDENT_CLOSE_OVERRIDE_ROLES=new Set(['pc','cc','chamal','admin','physician']);"), `${rel}: override roles must match close_incident() (no rpc/rcc)`);
  assert(html.includes("if(!reason){ if(err) err.textContent='חובה לציין סיבה לסגירה בעקיפה'; return; }"), `${rel}: override must require a reason`);
  assert(html.includes('if(isIncidentClosedForSite(siteId)) requestIncidentReopen(role, siteId);'), `${rel}: rescue close button must go through the guard`);
  assert(!/s\.incidentStatus=reopening\?'official':'closed'/.test(html), `${rel}: the unguarded close toggle must be gone`);
  assert(html.includes('siteAuthority.SITE_A=freshSiteAuthority();'), `${rel}: site authority must reset on incident switch / sign-out`);

  // V2.99.29 building collapse with any incident type: the Movement screen's building-state choice
  // (or rescue's progressive-collapse status) adds the collapse brief and label to any type.
  assert(html.includes("const COLLAPSE_BUILDING_TYPES=new Set(['collapse','partial_collapse','intact_trapped']);"), `${rel}: collapse building types must be defined`);
  assert(html.includes("return !!s.buildingCollapse || s.buildingStatus==='progressive_collapse';"), `${rel}: rescue progressive collapse must count as a collapse`);
  assert(html.includes("return type!=='missile_strike_structural_collapse' && siteHasBuildingCollapse(siteId);"), `${rel}: missile type must not get the collapse part twice`);
  assert(html.includes("s.buildingCollapse=COLLAPSE_BUILDING_TYPES.has(val);"), `${rel}: building-state choice must mark the site`);
  const typeGrid = html.indexOf('id="enroute-incident-type-grid"');
  const buildingGrid = html.indexOf('id="enroute-type-grid"');
  const address = html.indexOf('id="enroute-address"');
  assert(typeGrid > 0 && buildingGrid > typeGrid && buildingGrid < address, `${rel}: building-state section must sit right under the incident type`);

  // Legacy flows the smoke suite already depends on must still be present.
  assert(html.includes('LEGACY_FULL_ASSESSMENT_DO_NOT_DELETE_WITHOUT_TESTS'), `${rel}: legacy full assessment guard must remain`);

  console.log(`${rel}: Demo V2.9929 incident-lifecycle + triage-sync + close-guard + collapse smoke passed`);
}

