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

  assert(html.includes("const APP_VERSION = '2.99.31';"), `${rel}: APP_VERSION must be V2.9931`);
  assert(html.includes('Demo V2.9931'), `${rel}: launcher label must be Demo V2.9931`);
  assert(html.includes('ROLE // V2.9931'), `${rel}: role header must be Demo V2.9931`);
  assert(html.includes('Role-Based Medical Command System V2.9931'), `${rel}: role system strip must be Demo V2.9931`);

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

  // Unchanged guarantees (from V2.99.30 cross-device assignment).
  const eligible = html.match(/const SYNC_ELIGIBLE_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\);/);
  assert(eligible && !eligible[1].includes("'MEDIC_ASSIGNED_TO_INCIDENT'"), `${rel}: MEDIC_ASSIGNED_TO_INCIDENT stays a local log entry; the membership row is the source of truth`);
  assert(html.includes('function getSupabaseClient(){\n  if(_demoSandbox) return null;'), `${rel}: the sandboxed briefing must still block all server access`);

  // V2.99.31 admin user management (database/042, supabase/functions/admin-users): admin-only
  // entry point, role chosen per invitation, confirmation for admin and deactivation.
  assert(html.includes('id="screen-admin-users"'), `${rel}: admin user-management screen must exist`);
  assert(html.includes('id="auth-admin-users-btn" style="display:none"'), `${rel}: admin entry point must start hidden`);
  assert(html.includes("if(adminBtn) adminBtn.style.display=isAdminUser()?'':'none';"), `${rel}: admin entry point must show for admin only`);
  assert(html.includes("const ADMIN_USERS_FUNCTION_URL = SUPABASE_URL + '/functions/v1/admin-users';"), `${rel}: invites must go through the admin-users Edge Function`);
  for (const rpc of ['admin_list_users', 'admin_set_user_role', 'admin_set_user_active']) {
    assert(html.includes(`'${rpc}'`), `${rel}: client must call the ${rpc} RPC`);
  }
  assert(html.includes("if(role==='admin' && !confirm(`אישור הזמנת מנהל מערכת"), `${rel}: inviting an admin must ask for confirmation`);
  assert(html.includes("? confirm(`אישור מינוי מנהל מערכת"), `${rel}: promoting to admin must ask for confirmation`);
  assert(html.includes("<option value=\"\">בחר/י תפקיד למוזמן (חובה)</option>"), `${rel}: invite role must be an explicit choice, no default`);
  assert(html.includes("if(u.has_profile && !isMe){"), `${rel}: own row must not offer role/deactivate controls`);
  assert(html.includes("catch(e){ otpResult={error:e}; }\n    clearAuthLinkFromUrl();"), `${rel}: one-time token must be removed from the address bar once tried`);

  // Legacy flows the smoke suite already depends on must still be present.
  assert(html.includes('LEGACY_FULL_ASSESSMENT_DO_NOT_DELETE_WITHOUT_TESTS'), `${rel}: legacy full assessment guard must remain`);

  console.log(`${rel}: Demo V2.9931 incident-lifecycle + triage-sync + close-guard + collapse + cross-device + admin-users smoke passed`);
}

const a = fs.readFileSync(path.join(root, files[0]), 'utf8');
const b = fs.readFileSync(path.join(root, files[1]), 'utf8');
assert(a === b, 'index.html and demo/rescue-app.html must stay byte-identical');
console.log('index.html and demo/rescue-app.html are byte-identical');
